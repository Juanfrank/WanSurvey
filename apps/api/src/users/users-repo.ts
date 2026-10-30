import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { AuditService, type AuditEntry } from '../audit/audit.service.js';
import { AuditStore } from '../audit/audit-store.mssql.js';
import { SessionsStore } from '../auth/sessions-store.mssql.js';
import { randomToken, sha256Hex } from '../common/crypto.js';
import { Database, type Tx } from '../db/database.js';
import { Engine } from '../db/engine.js';
import type { MssqlTx } from '../db/mssql/database.js';
import {
  memberships,
  projects,
  sessions,
  tenantMembers,
  tenants,
  userTokens,
  users,
} from '../db/schema.js';
import { PeopleStore, type Grant, type Member } from './people-store.mssql.js';

/**
 * What the people service needs from the database, whichever engine runs (the pattern of
 * `auth/auth-repo.ts`): the PostgreSQL side is the Drizzle code the service had, the SQL Server
 * side uses `PeopleStore` and `SessionsStore`. The rules (who may grant what, whom one may manage)
 * live once, in the service.
 */
export type { Grant, Member };
export type MemberStatus = 'invited' | 'active' | 'deactivated';

export interface UsersTx {
  members(): Promise<Member[]>;
  /** The roles of everyone in the organisation (or of one person). */
  grants(userId?: string): Promise<(Grant & { userId: string })[]>;
  setGrants(userId: string, grants: Grant[]): Promise<void>;
  /** The ids of those projects that exist in the organisation. */
  existingProjects(ids: string[]): Promise<string[]>;
  isMember(userId: string): Promise<boolean>;
  /** Gives the person this role in one project (null: takes them out of it). */
  setProjectRole(userId: string, projectId: string, role: string | null): Promise<void>;
  /** A new member (and a new pending account unless `existing`), with their roles. */
  invite(v: {
    userId: string;
    email: string;
    name: string;
    firstName?: string | null;
    idCode?: string | null;
    languages?: string[];
    grants: Grant[];
    existing: boolean;
  }): Promise<void>;
  member(userId: string): Promise<(Member & { userStatus: string }) | null>;
  setMemberStatus(userId: string, status: MemberStatus): Promise<void>;
  /** Makes the person's open invitation links stop working. */
  voidInvitations(userId: string): Promise<void>;
  /** A new invitation link token; only its hash is stored. */
  issueInvitation(userId: string, ttlHours: number): Promise<string>;
  slug(): Promise<string>;
  /** Revokes the person's live sessions; returns how many. */
  revokeSessions(userId: string): Promise<number>;
  audit(entry: AuditEntry): Promise<void>;
}

export interface UsersRepo {
  inTenant<T>(tenantId: string, fn: (t: UsersTx) => Promise<T>): Promise<T>;
}

// ─── PostgreSQL ─────────────────────────────────────────────────────────────────────────

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

class PgUsersTx implements UsersTx {
  constructor(
    private readonly tx: Tx,
    private readonly tenantId: string,
    private readonly audits: AuditService,
  ) {}

  members() {
    return this.tx
      .select(memberColumns)
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .orderBy(users.name);
  }

  async grants(userId?: string) {
    const rows = await this.tx
      .select()
      .from(memberships)
      .where(userId ? eq(memberships.userId, userId) : undefined);
    return rows.map((g) => ({ userId: g.userId, role: g.role as string, projectId: g.projectId }));
  }

  async setGrants(userId: string, grants: Grant[]) {
    await this.tx.delete(memberships).where(eq(memberships.userId, userId));
    if (grants.length)
      await this.tx.insert(memberships).values(
        grants.map((g) => ({
          tenantId: this.tenantId,
          userId,
          role: g.role as (typeof memberships.$inferInsert)['role'],
          projectId: g.projectId,
        })),
      );
  }

  async existingProjects(ids: string[]) {
    if (!ids.length) return [];
    const found = await this.tx
      .select({ id: projects.id })
      .from(projects)
      .where(inArray(projects.id, ids));
    return found.map((p) => p.id);
  }

  async setProjectRole(userId: string, projectId: string, role: string | null) {
    await this.tx
      .delete(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.projectId, projectId)));
    if (role)
      await this.tx.insert(memberships).values({
        tenantId: this.tenantId,
        userId,
        projectId,
        role: role as (typeof memberships.$inferInsert)['role'],
      });
  }

  async isMember(userId: string) {
    const [m] = await this.tx
      .select({ id: tenantMembers.id })
      .from(tenantMembers)
      .where(eq(tenantMembers.userId, userId));
    return !!m;
  }

  async invite(v: Parameters<UsersTx['invite']>[0]) {
    if (!v.existing)
      // No RETURNING: the new row only becomes visible once the membership below exists.
      await this.tx.insert(users).values({
        id: v.userId,
        email: v.email,
        name: v.name,
        firstName: v.firstName ?? null,
        languages: v.languages ?? [],
        status: 'pending',
      });
    await this.tx.insert(tenantMembers).values({
      tenantId: this.tenantId,
      userId: v.userId,
      status: 'invited',
      idCode: v.idCode ?? null,
    });
    await this.setGrants(v.userId, v.grants);
  }

  async member(userId: string) {
    const [m] = await this.tx
      .select({ ...memberColumns, userStatus: users.status })
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .where(eq(tenantMembers.userId, userId));
    return m ?? null;
  }

  async setMemberStatus(userId: string, status: MemberStatus) {
    await this.tx
      .update(tenantMembers)
      .set({ status, deactivatedAt: status === 'deactivated' ? new Date() : null })
      .where(eq(tenantMembers.userId, userId));
  }

  async voidInvitations(userId: string) {
    await this.tx
      .update(userTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(userTokens.userId, userId),
          eq(userTokens.purpose, 'invitation'),
          isNull(userTokens.usedAt),
        ),
      );
  }

  async issueInvitation(userId: string, ttlHours: number) {
    const raw = randomToken();
    await this.tx.insert(userTokens).values({
      tenantId: this.tenantId,
      userId,
      purpose: 'invitation',
      tokenHash: sha256Hex(raw),
      expiresAt: new Date(Date.now() + ttlHours * 3600_000),
    });
    return raw;
  }

  async slug() {
    const [t] = await this.tx
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, this.tenantId));
    return t!.slug;
  }

  async revokeSessions(userId: string) {
    const rows = await this.tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return rows.length;
  }

  audit(entry: AuditEntry) {
    return this.audits.record(this.tx, this.tenantId, entry);
  }
}

@Injectable()
export class PgUsersRepo implements UsersRepo {
  constructor(
    private readonly database: Database,
    private readonly audits: AuditService,
  ) {}

  inTenant<T>(tenantId: string, fn: (t: UsersTx) => Promise<T>) {
    return this.database.withTenant(tenantId, (tx) => fn(new PgUsersTx(tx, tenantId, this.audits)));
  }
}

// ─── SQL Server ─────────────────────────────────────────────────────────────────────────

class MssqlUsersTx implements UsersTx {
  constructor(
    private readonly tx: MssqlTx,
    private readonly tenantId: string,
    private readonly people: PeopleStore,
    private readonly sessionStore: SessionsStore,
    private readonly auditStore: AuditStore,
  ) {}

  members() {
    return this.people.members(this.tx);
  }
  grants(userId?: string) {
    return this.people.grants(this.tx, userId);
  }
  setGrants(userId: string, grants: Grant[]) {
    return this.people.setGrants(this.tx, this.tenantId, userId, grants);
  }
  existingProjects(ids: string[]) {
    return this.people.existingProjects(this.tx, ids);
  }
  async isMember(userId: string) {
    return !!(await this.people.member(this.tx, userId));
  }
  async setProjectRole(userId: string, projectId: string, role: string | null) {
    const grants = (await this.people.grants(this.tx, userId)).filter(
      (g) => g.projectId !== projectId.toLowerCase(),
    );
    await this.people.setGrants(
      this.tx,
      this.tenantId,
      userId,
      role ? [...grants, { role, projectId }] : grants,
    );
  }
  invite(v: Parameters<UsersTx['invite']>[0]) {
    return this.people.invite(this.tx, { tenantId: this.tenantId, ...v });
  }
  member(userId: string) {
    return this.people.member(this.tx, userId);
  }
  setMemberStatus(userId: string, status: MemberStatus) {
    return this.people.setMemberStatus(this.tx, userId, status);
  }
  voidInvitations(userId: string) {
    return this.sessionStore.voidTokens(this.tx, userId, 'invitation');
  }
  async issueInvitation(userId: string, ttlHours: number) {
    const raw = randomToken();
    await this.sessionStore.issueToken(this.tx, {
      tenantId: this.tenantId,
      userId,
      purpose: 'invitation',
      tokenHash: sha256Hex(raw),
      expiresAt: new Date(Date.now() + ttlHours * 3600_000),
    });
    return raw;
  }
  async slug() {
    const t = await this.tx
      .selectFrom('tenants')
      .select('slug')
      .where('id', '=', this.tenantId)
      .executeTakeFirstOrThrow();
    return t.slug;
  }
  revokeSessions(userId: string) {
    return this.sessionStore.revokeAllOf(this.tx, userId);
  }
  audit(entry: AuditEntry) {
    return this.auditStore.record(this.tx, this.tenantId, entry);
  }
}

@Injectable()
export class MssqlUsersRepo implements UsersRepo {
  private readonly people = new PeopleStore();
  private readonly sessionStore = new SessionsStore();
  private readonly auditStore = new AuditStore();

  constructor(private readonly engine: Engine) {}

  inTenant<T>(tenantId: string, fn: (t: UsersTx) => Promise<T>) {
    return this.engine.sql.withTenant(tenantId, (tx) =>
      fn(new MssqlUsersTx(tx, tenantId, this.people, this.sessionStore, this.auditStore)),
    );
  }
}

export const USERS_REPO = Symbol('USERS_REPO');
