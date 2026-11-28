import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AfterClose, Auth, RequirePermission, type AuthContext } from '../common/auth-context.js';
import { HOME_REPO, type HomeRepo } from './home-repo.js';
import { homeParts, homeProjects } from './home.js';

/** Minutes without activity after which an interviewer no longer counts as working (as live). */
const ACTIVE_MINUTES = 5;
/** Callbacks listed under "For today". */
const DUE_LIMIT = 20;

/**
 * The home page's summary: per project, the fieldwork figures, the review queue and the
 * caller's own work, each only where the caller's roles allow it. Grouped queries over the
 * organisation, so the page does not ask each project's dashboard.
 */
@ApiTags('home')
@Controller('home')
export class HomeController {
  constructor(@Inject(HOME_REPO) private readonly repo: HomeRepo) {}

  @Get()
  // Someone whose projects are all closed gets an empty list, not a refusal.
  @AfterClose()
  @RequirePermission('projects.read', { anyProject: true })
  summary(@Auth() ctx: AuthContext) {
    const m = ctx.memberships;
    const parts = homeParts(m);
    return this.repo.inTenant(ctx.tenantId, async (t) => {
      const data = {
        projectIds: await t.projectIds(),
        completes: parts.field ? await t.completes() : [],
        field: parts.field ? await t.fieldCounts() : [],
        active: parts.field
          ? await t.activeSince(new Date(Date.now() - ACTIVE_MINUTES * 60_000))
          : [],
        lastActivity: parts.field ? await t.lastActivity() : [],
        review: parts.review ? await t.reviewCounts() : [],
        mine: parts.mine ? await t.mine(ctx.userId) : [],
      };
      const projects = homeProjects(m, data);
      // Only where the caller works cases (every project: no list to send).
      const withMine = projects.filter((p) => p.mine).map((p) => p.id);
      const due = withMine.length
        ? await t.dueCallbacks(
            ctx.userId,
            withMine.length === data.projectIds.length ? null : withMine,
            DUE_LIMIT,
          )
        : [];
      return {
        projects,
        dueCallbacks: due.map((c) => ({ ...c, at: new Date(c.at).toISOString() })),
      };
    });
  }
}
