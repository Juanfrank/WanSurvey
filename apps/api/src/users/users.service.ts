import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ROLE_RANK, type Role } from '@wansurvey/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { AuditService } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import { tenantRank, type AuthContext, type MembershipGrant } from '../common/auth-context.js';
import { sha256Hex } from '../common/crypto.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Database, type Tx } from '../db/database.js';
import { memberships, projects, sessions, tenantMembers, userTokens, users } from '../db/schema.js';
import { MAILER, type Mailer } from '../mail/mailer.js';

const INVITATION_TTL_HOURS = 7 * 24;

/** A member as seen by their organisation: global identity plus this organisation's fields. */
const memberColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  firstName: users.firstName,
  phone: users.phone,
  languages: users.languages,
  totpEnabled: users.totpEnabled,
  status: tenantMembers.status,
  idCode: tenantMembers.idCode,
  phoneExtension: tenantMembers.phoneExtension,
  createdAt: tenantMembers.createdAt,
  deactivatedAt: tenantMembers.deactivatedAt,
};

@Injectable()
export class UsersService {
  constructor(
    private readonly database: Database,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  async list(ctx: AuthContext) {
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx
        .select(memberColumns)
        .from(tenantMembers)
        .innerJoin(users, eq(users.id, tenantMembers.userId))
        .orderBy(users.name);
      const grants = await tx.select().from(memberships);
      return rows.map((u) => ({
        ...u,
        memberships: grants
          .filter((g) => g.userId === u.id)
          .map((g) => ({ role: g.role, projectId: g.projectId })),
        /** Signed in (e.g. with Microsoft) but no role assigned yet. */
        awaitingRole: u.status === 'active' && !grants.some((g) => g.userId === u.id),
      }));
    });
  }

  /** Role changes may not grant above the actor's own rank; only owners manage owners. */
  private assertCanGrant(ctx: AuthContext, grants: MembershipGrant[]) {
    const rank = tenantRank(ctx.memberships);
    for (const g of grants) {
      if (g.role === 'owner' && rank < ROLE_RANK.owner)
        throw new ForbiddenException('Only owners can grant the owner role');
      if (ROLE_RANK[g.role] > rank)
        throw new ForbiddenException(`You cannot grant the ${g.role} role`);
    }
  }

  private async assertProjectsExist(tx: Tx, grants: MembershipGrant[]) {
    const ids = [...new Set(grants.map((g) => g.projectId).filter((p): p is string => p !== null))];
    if (!ids.length) return;
    const found = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(inArray(projects.id, ids));
    if (found.length !== ids.length) throw new BadRequestException('Unknown project');
  }

  async invite(
    ctx: AuthContext,
    input: {
      email: string;
      name: string;
      firstName?: string;
      idCode?: string;
      languages?: string[];
      memberships: MembershipGrant[];
    },
  ) {
    this.assertCanGrant(ctx, input.memberships);
    // Accounts are global: an e-mail that already has one is linked, not duplicated.
    const existingId = await this.database.userIdByEmail(input.email);
    const userId = existingId ?? uuidv7();
    const result = await this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.assertProjectsExist(tx, input.memberships);
      if (existingId) {
        const [member] = await tx
          .select({ id: tenantMembers.id })
          .from(tenantMembers)
          .where(eq(tenantMembers.userId, existingId));
        if (member) throw new ConflictException('This person is already a member');
      } else {
        // No RETURNING: the new row only becomes visible once the membership below exists.
        await tx.insert(users).values({
          id: userId,
          email: input.email,
          name: input.name,
          firstName: input.firstName ?? null,
          languages: input.languages ?? [],
          status: 'pending',
        });
      }
      await tx.insert(tenantMembers).values({
        tenantId: ctx.tenantId,
        userId,
        status: 'invited',
        idCode: input.idCode ?? null,
      });
      await tx
        .insert(memberships)
        .values(input.memberships.map((m) => ({ tenantId: ctx.tenantId, userId, ...m })));
      const token = await this.auth.issueToken(tx, {
        tenantId: ctx.tenantId,
        userId,
        purpose: 'invitation',
        ttlHours: INVITATION_TTL_HOURS,
      });
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'user.invited',
          targetType: 'user',
          targetId: userId,
          details: {
            email: input.email,
            existingAccount: !!existingId,
            memberships: input.memberships,
          },
        }),
      );
      const [member] = await tx
        .select(memberColumns)
        .from(tenantMembers)
        .innerJoin(users, eq(users.id, tenantMembers.userId))
        .where(eq(tenantMembers.userId, userId));
      return { member: member!, token };
    });
    await this.sendInvitation(result.member, result.token, !!existingId);
    return { ...result.member, existingAccount: !!existingId, memberships: input.memberships };
  }

  private async sendInvitation(
    member: { email: string; name: string },
    token: string,
    existingAccount: boolean,
  ) {
    const link = `${this.config.PUBLIC_WEB_URL}/accept-invitation?token=${encodeURIComponent(token)}`;
    await this.mailer.send({
      to: member.email,
      subject: existingAccount
        ? 'You have been added to an organisation on WanSurvey'
        : 'You have been invited to WanSurvey',
      text: existingAccount
        ? `Hello ${member.name},\n\nYou have been added to another organisation. Confirm with your existing password within 7 days:\n${link}`
        : `Hello ${member.name},\n\nAccept your invitation within 7 days:\n${link}`,
      idempotencyKey: `invite:${sha256Hex(token)}`,
    });
  }

  /**
   * A new invitation link for someone who has not accepted yet (the old link may have
   * expired or been lost); earlier links stop working.
   */
  async resendInvitation(ctx: AuthContext, userId: string) {
    const result = await this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.loadTarget(tx, ctx, userId);
      const [member] = await tx
        .select({ ...memberColumns, userStatus: users.status })
        .from(tenantMembers)
        .innerJoin(users, eq(users.id, tenantMembers.userId))
        .where(eq(tenantMembers.userId, userId));
      if (member!.status !== 'invited')
        throw new ConflictException({
          code: 'NOT_INVITED',
          message: 'This person has already accepted their invitation',
        });
      await tx
        .update(userTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(userTokens.userId, userId),
            eq(userTokens.purpose, 'invitation'),
            isNull(userTokens.usedAt),
          ),
        );
      const token = await this.auth.issueToken(tx, {
        tenantId: ctx.tenantId,
        userId,
        purpose: 'invitation',
        ttlHours: INVITATION_TTL_HOURS,
      });
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'user.invitation_resent',
          targetType: 'user',
          targetId: userId,
        }),
      );
      return { member: member!, token };
    });
    await this.sendInvitation(result.member, result.token, result.member.userStatus !== 'pending');
  }

  /** Gives a deactivated member their access back (still invited if they never accepted). */
  async reactivate(ctx: AuthContext, userId: string) {
    await this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.loadTarget(tx, ctx, userId);
      const [row] = await tx
        .select({ status: tenantMembers.status, userStatus: users.status })
        .from(tenantMembers)
        .innerJoin(users, eq(users.id, tenantMembers.userId))
        .where(eq(tenantMembers.userId, userId));
      if (row!.status !== 'deactivated')
        throw new ConflictException({ code: 'NOT_DEACTIVATED', message: 'This person is active' });
      await tx
        .update(tenantMembers)
        .set({ status: row!.userStatus === 'pending' ? 'invited' : 'active', deactivatedAt: null })
        .where(eq(tenantMembers.userId, userId));
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'user.reactivated',
          targetType: 'user',
          targetId: userId,
        }),
      );
    });
  }

  async setMemberships(ctx: AuthContext, userId: string, grants: MembershipGrant[]) {
    if (userId === ctx.userId) throw new ForbiddenException('You cannot change your own roles');
    this.assertCanGrant(ctx, grants);
    return this.database.withTenant(ctx.tenantId, async (tx) => {
      const before = await this.loadTarget(tx, ctx, userId);
      await this.assertProjectsExist(tx, grants);
      await tx.delete(memberships).where(eq(memberships.userId, userId));
      if (grants.length)
        await tx
          .insert(memberships)
          .values(grants.map((g) => ({ tenantId: ctx.tenantId, userId, ...g })));
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'user.role_changed',
          targetType: 'user',
          targetId: userId,
          details: { before, after: grants },
        }),
      );
      return { userId, memberships: grants };
    });
  }

  async deactivate(ctx: AuthContext, userId: string) {
    if (userId === ctx.userId) throw new ForbiddenException('You cannot deactivate yourself');
    await this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.loadTarget(tx, ctx, userId);
      // Only this organisation's membership ends; the account and its history are kept, so
      // historic interviews stay attributable and other organisations are unaffected.
      await tx
        .update(tenantMembers)
        .set({ status: 'deactivated', deactivatedAt: new Date() })
        .where(eq(tenantMembers.userId, userId));
      await this.revokeSessions(tx, userId);
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'user.deactivated',
          targetType: 'user',
          targetId: userId,
        }),
      );
    });
  }

  async forceLogout(ctx: AuthContext, userId: string) {
    await this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.loadTarget(tx, ctx, userId);
      const n = await this.revokeSessions(tx, userId);
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'user.forced_logout',
          targetType: 'user',
          targetId: userId,
          details: { sessions: n },
        }),
      );
    });
  }

  /** Loads the target's grants and refuses to act on someone who outranks the actor. */
  private async loadTarget(tx: Tx, ctx: AuthContext, userId: string): Promise<MembershipGrant[]> {
    const [member] = await tx
      .select({ id: tenantMembers.id })
      .from(tenantMembers)
      .where(eq(tenantMembers.userId, userId));
    if (!member) throw new NotFoundException('User not found');
    const grants = (await tx.select().from(memberships).where(eq(memberships.userId, userId))).map(
      (g) => ({
        role: g.role as Role,
        projectId: g.projectId,
      }),
    );
    if (
      tenantRank(grants) > tenantRank(ctx.memberships) ||
      (grants.some((g) => g.role === 'owner') && tenantRank(ctx.memberships) < ROLE_RANK.owner)
    ) {
      throw new ForbiddenException('You cannot manage this user');
    }
    return grants;
  }

  private async revokeSessions(tx: Tx, userId: string): Promise<number> {
    const rows = await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return rows.length;
  }
}
