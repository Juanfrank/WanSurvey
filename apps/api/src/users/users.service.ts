import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ROLE_RANK, type Role } from '@wansurvey/schema';
import { uuidv7 } from 'uuidv7';
import { AuditService } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import { AUTH_REPO, type AuthRepo } from '../auth/auth-repo.js';
import { tenantRank, type AuthContext, type MembershipGrant } from '../common/auth-context.js';
import { sha256Hex } from '../common/crypto.js';
import { CONFIG, type AppConfig } from '../config.js';
import { USERS_REPO, type UsersRepo, type UsersTx } from './users-repo.js';
import { MAILER, type Mailer } from '../mail/mailer.js';

const INVITATION_TTL_HOURS = 7 * 24;

@Injectable()
export class UsersService {
  constructor(
    @Inject(USERS_REPO) private readonly repo: UsersRepo,
    @Inject(AUTH_REPO) private readonly authRepo: AuthRepo,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  async list(ctx: AuthContext) {
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const rows = await t.members();
      const grants = await t.grants();
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

  private async assertProjectsExist(t: UsersTx, grants: MembershipGrant[]) {
    const ids = [...new Set(grants.map((g) => g.projectId).filter((p): p is string => p !== null))];
    if (!ids.length) return;
    if ((await t.existingProjects(ids)).length !== ids.length)
      throw new BadRequestException('Unknown project');
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
    const existingId = (await this.authRepo.userByEmail(input.email))?.id ?? null;
    const userId = existingId ?? uuidv7();
    const result = await this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.assertProjectsExist(t, input.memberships);
      if (existingId && (await t.isMember(existingId)))
        throw new ConflictException('This person is already a member');
      await t.invite({
        userId,
        email: input.email,
        name: input.name,
        firstName: input.firstName,
        idCode: input.idCode,
        languages: input.languages,
        grants: input.memberships,
        existing: !!existingId,
      });
      const token = await t.issueInvitation(userId, INVITATION_TTL_HOURS);
      await t.audit(
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
      const member = await t.member(userId);
      return { member: member!, token, org: await t.slug() };
    });
    await this.sendInvitation(result.member, result.token, !!existingId, result.org);
    return { ...result.member, existingAccount: !!existingId, memberships: input.memberships };
  }

  private async sendInvitation(
    member: { email: string; name: string },
    token: string,
    existingAccount: boolean,
    org: string,
  ) {
    // Without passwords the invitation is accepted by signing in with Microsoft to the
    // organisation that sent it; the link carries the organisation, not the token.
    if (!this.config.PASSWORD_LOGIN) {
      const link = `${this.config.PUBLIC_WEB_URL}/accept-invitation?org=${encodeURIComponent(org)}`;
      await this.mailer.send({
        to: member.email,
        subject: existingAccount
          ? 'You have been added to an organisation on WanSurvey'
          : 'You have been invited to WanSurvey',
        text: `Hello ${member.name},\n\nYou have been invited to WanSurvey. To accept, open this link and choose "Ingresar con Microsoft" (sign in with Microsoft) with your work account:\n${link}`,
        idempotencyKey: `invite:${sha256Hex(token)}`,
      });
      return;
    }
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
    const result = await this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.loadTarget(t, ctx, userId);
      const member = await t.member(userId);
      if (member!.status !== 'invited')
        throw new ConflictException({
          code: 'NOT_INVITED',
          message: 'This person has already accepted their invitation',
        });
      await t.voidInvitations(userId);
      const token = await t.issueInvitation(userId, INVITATION_TTL_HOURS);
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'user.invitation_resent',
          targetType: 'user',
          targetId: userId,
        }),
      );
      return { member: member!, token, org: await t.slug() };
    });
    await this.sendInvitation(
      result.member,
      result.token,
      result.member.userStatus !== 'pending',
      result.org,
    );
  }

  /** Gives a deactivated member their access back (still invited if they never accepted). */
  async reactivate(ctx: AuthContext, userId: string) {
    await this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.loadTarget(t, ctx, userId);
      const row = await t.member(userId);
      if (row!.status !== 'deactivated')
        throw new ConflictException({ code: 'NOT_DEACTIVATED', message: 'This person is active' });
      await t.setMemberStatus(userId, row!.userStatus === 'pending' ? 'invited' : 'active');
      await t.audit(
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
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const before = await this.loadTarget(t, ctx, userId);
      await this.assertProjectsExist(t, grants);
      await t.setGrants(userId, grants);
      await t.audit(
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
    await this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.loadTarget(t, ctx, userId);
      // Only this organisation's membership ends; the account and its history are kept, so
      // historic interviews stay attributable and other organisations are unaffected.
      await t.setMemberStatus(userId, 'deactivated');
      await t.revokeSessions(userId);
      await t.audit(
        this.audit.fromContext(ctx, {
          action: 'user.deactivated',
          targetType: 'user',
          targetId: userId,
        }),
      );
    });
  }

  async forceLogout(ctx: AuthContext, userId: string) {
    await this.repo.inTenant(ctx.tenantId, async (t) => {
      await this.loadTarget(t, ctx, userId);
      const n = await t.revokeSessions(userId);
      await t.audit(
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
  private async loadTarget(
    t: UsersTx,
    ctx: AuthContext,
    userId: string,
  ): Promise<MembershipGrant[]> {
    if (!(await t.isMember(userId))) throw new NotFoundException('User not found');
    const grants = (await t.grants(userId)).map((g) => ({
      role: g.role as Role,
      projectId: g.projectId,
    }));
    if (
      tenantRank(grants) > tenantRank(ctx.memberships) ||
      (grants.some((g) => g.role === 'owner') && tenantRank(ctx.memberships) < ROLE_RANK.owner)
    ) {
      throw new ForbiddenException('You cannot manage this user');
    }
    return grants;
  }
}
