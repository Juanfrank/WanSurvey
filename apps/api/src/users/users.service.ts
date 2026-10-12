import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ROLE_RANK, type Role } from '@wansurvey/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import { tenantRank, type AuthContext, type MembershipGrant } from '../common/auth-context.js';
import { sha256Hex } from '../common/crypto.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Database, type Tx } from '../db/database.js';
import { memberships, projects, sessions, users } from '../db/schema.js';
import { MAILER, type Mailer } from '../mail/mailer.js';

const INVITATION_TTL_HOURS = 7 * 24;

const publicUser = {
  id: users.id,
  email: users.email,
  name: users.name,
  firstName: users.firstName,
  phone: users.phone,
  idCode: users.idCode,
  languages: users.languages,
  phoneExtension: users.phoneExtension,
  status: users.status,
  totpEnabled: users.totpEnabled,
  createdAt: users.createdAt,
  deactivatedAt: users.deactivatedAt,
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
      const rows = await tx.select(publicUser).from(users).orderBy(users.name);
      const grants = await tx.select().from(memberships);
      return rows.map((u) => ({
        ...u,
        memberships: grants
          .filter((g) => g.userId === u.id)
          .map((g) => ({ role: g.role, projectId: g.projectId })),
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
    const { user, token } = await this.database.withTenant(ctx.tenantId, async (tx) => {
      await this.assertProjectsExist(tx, input.memberships);
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = lower(${input.email})`);
      if (existing) throw new ConflictException('A user with this e-mail already exists');
      const [user] = await tx
        .insert(users)
        .values({
          tenantId: ctx.tenantId,
          email: input.email,
          name: input.name,
          firstName: input.firstName ?? null,
          idCode: input.idCode ?? null,
          languages: input.languages ?? [],
          status: 'invited',
        })
        .returning(publicUser);
      await tx
        .insert(memberships)
        .values(input.memberships.map((m) => ({ tenantId: ctx.tenantId, userId: user!.id, ...m })));
      const token = await this.auth.issueToken(
        tx,
        ctx.tenantId,
        user!.id,
        'invitation',
        INVITATION_TTL_HOURS,
      );
      await this.audit.record(
        tx,
        ctx.tenantId,
        this.audit.fromContext(ctx, {
          action: 'user.invited',
          targetType: 'user',
          targetId: user!.id,
          details: { email: input.email, memberships: input.memberships },
        }),
      );
      return { user: user!, token };
    });
    await this.mailer.send({
      to: user.email,
      subject: 'You have been invited to WanSurvey',
      text: `Hello ${user.name},\n\nAccept your invitation within 7 days:\n${this.config.PUBLIC_WEB_URL}/accept-invitation?token=${encodeURIComponent(token)}`,
      idempotencyKey: `invite:${sha256Hex(token)}`,
    });
    return { ...user, memberships: input.memberships };
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
      // The row is kept so historic interviews stay attributable.
      await tx
        .update(users)
        .set({ status: 'deactivated', deactivatedAt: new Date() })
        .where(eq(users.id, userId));
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
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!user) throw new NotFoundException('User not found');
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
