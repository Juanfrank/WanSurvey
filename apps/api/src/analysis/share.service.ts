import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../common/auth-context.js';
import { decryptField, encryptField, randomToken, sha256Hex } from '../common/crypto.js';
import { CONFIG, type AppConfig } from '../config.js';
import type { AnalysisTx } from './analysis-repo.js';

export const ShareBody = z.object({
  /** Days the link works; none means until revoked. */
  days: z.number().int().min(1).max(365).nullable().default(30),
});

/**
 * Read-only links to a project's summary for clients (M7). The token is stored hashed for
 * lookup and encrypted so managers can copy the link again; revoking ends it at once.
 */
@Injectable()
export class ShareService {
  constructor(
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private url(token: string) {
    return `${this.config.PUBLIC_WEB_URL}/share/${token}`;
  }

  async list(t: AnalysisTx, projectId: string) {
    const rows = await t.shareLinks(projectId);
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      revokedAt: r.revokedAt,
      url: r.revokedAt ? null : this.url(decryptField(r.tokenEnc, this.config.APP_ENCRYPTION_KEY)),
    }));
  }

  async create(
    t: AnalysisTx,
    ctx: AuthContext,
    projectId: string,
    body: z.infer<typeof ShareBody>,
  ) {
    const token = randomToken(24);
    const expiresAt = body.days ? new Date(Date.now() + body.days * 86_400_000) : null;
    const id = await t.createShareLink({
      projectId,
      tokenHash: sha256Hex(token),
      tokenEnc: encryptField(token, this.config.APP_ENCRYPTION_KEY),
      createdBy: ctx.userId,
      expiresAt,
    });
    await t.audit(
      this.audit.fromContext(ctx, {
        action: 'share_link.created',
        targetType: 'share_link',
        targetId: id,
        details: { projectId, expiresAt },
      }),
    );
    return { id, url: this.url(token), expiresAt };
  }

  async revoke(t: AnalysisTx, ctx: AuthContext, projectId: string, id: string) {
    if (!(await t.revokeShareLink(projectId, id))) throw new NotFoundException('Link not found');
    await t.audit(
      this.audit.fromContext(ctx, {
        action: 'share_link.revoked',
        targetType: 'share_link',
        targetId: id,
        details: { projectId },
      }),
    );
  }

  /** The project a live link opens (inside the link's organisation). */
  async projectOf(t: AnalysisTx, id: string): Promise<string> {
    const projectId = await t.shareLinkProject(id);
    if (!projectId) throw new NotFoundException('Link not found');
    return projectId;
  }
}
