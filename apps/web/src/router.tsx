import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  Outlet,
} from '@tanstack/react-router';
import { isRespondentPath, loadCatalogue } from './i18n.js';
import { parseFeedbackSearch, type FeedbackSearch } from './respondent/public-routes.js';
import { usePageTitle } from './routes/pageTitle.js';

// Every page loads when opened: a web respondent downloads none of the staff application (H6).
const AppLayout = lazyRouteComponent(() => import('./routes/AppLayout.js'), 'AppLayout');
const HomePage = lazyRouteComponent(() => import('./routes/HomePage.js'), 'HomePage');
const LoginPage = lazyRouteComponent(() => import('./routes/LoginPage.js'), 'LoginPage');
const TwoFactorPage = lazyRouteComponent(
  () => import('./routes/TwoFactorPages.js'),
  'TwoFactorPage',
);
const TwoFactorSetupPage = lazyRouteComponent(
  () => import('./routes/TwoFactorPages.js'),
  'TwoFactorSetupPage',
);
const WaitingPage = lazyRouteComponent(() => import('./routes/WaitingPage.js'), 'WaitingPage');
const passwordPage = (name: 'AcceptInvitationPage' | 'ResetPasswordPage' | 'ForgotPasswordPage') =>
  lazyRouteComponent(() => import('./routes/PasswordPages.js'), name);

function Root() {
  usePageTitle();
  return <Outlet />;
}

const rootRoute = createRootRoute({
  component: Root,
  // Staff pages need the interface's words, also when coming from a respondent's page.
  beforeLoad: ({ location }) => (isRespondentPath(location.pathname) ? undefined : loadCatalogue()),
});

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
  validateSearch: (s: Record<string, unknown>): { sso_error?: string } =>
    typeof s.sso_error === 'string' ? { sso_error: s.sso_error } : {},
});
const twoFactorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login/2fa',
  component: TwoFactorPage,
});
const twoFactorSetupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login/2fa/setup',
  component: TwoFactorSetupPage,
});

// Links from e-mails (an invitation, a password reset) and asking for one.
const acceptInvitationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accept-invitation',
  component: passwordPage('AcceptInvitationPage'),
});
const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset-password',
  component: passwordPage('ResetPasswordPage'),
});
const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/forgot-password',
  component: passwordPage('ForgotPasswordPage'),
});

// Respondent pages: outside the staff application, no sign-in (the link is the credential).
const respondentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/s/$token',
  component: lazyRouteComponent(() => import('./respondent/RouterPages.js'), 'RespondentRoute'),
});
const openLinkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/o/$slug',
  component: lazyRouteComponent(() => import('./respondent/RouterPages.js'), 'OpenLinkRoute'),
});
// Quick feedback (F1): a face per link, or the widget for an iframe.
const feedbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/f/$slug',
  component: lazyRouteComponent(() => import('./respondent/RouterPages.js'), 'FeedbackRoute'),
  validateSearch: (s: Record<string, unknown>): FeedbackSearch => parseFeedbackSearch(s),
});
const unsubscribeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/u/$token',
  component: lazyRouteComponent(() => import('./respondent/RouterPages.js'), 'UnsubscribeRoute'),
});

const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', component: AppLayout });
const homeRoute = createRoute({ getParentRoute: () => appRoute, path: '/', component: HomePage });
const waitingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/waiting',
  component: WaitingPage,
});
// Administration: people and roles, teams, the organisation, the activity log.
const adminRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin',
  component: lazyRouteComponent(() => import('./admin/AdminLayout.js'), 'AdminLayout'),
});
const adminUsersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'users',
  component: lazyRouteComponent(() => import('./team/TeamPage.js'), 'TeamPage'),
});
const adminTeamsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'teams',
  component: lazyRouteComponent(() => import('./admin/TeamsPage.js'), 'TeamsPage'),
});
const adminRolesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'roles',
  component: lazyRouteComponent(() => import('./admin/RolesPage.js'), 'RolesPage'),
});
const adminOrganisationRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'organisation',
  component: lazyRouteComponent(() => import('./admin/OrganisationPage.js'), 'OrganisationPage'),
});
const adminAuditRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: 'audit',
  component: lazyRouteComponent(() => import('./admin/AuditPage.js'), 'AuditPage'),
});
// The old address of the people page.
const teamRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/team',
  beforeLoad: () => {
    throw redirect({ to: '/admin/users' });
  },
});
// The preview (logic engine, renderer, samples) loads only when opened.
const previewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/preview',
  component: lazyRouteComponent(() => import('./preview/PreviewPage.js'), 'PreviewPage'),
});

// The designer (editor, logic engine, preview) also loads only when opened.
const projectsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects',
  component: lazyRouteComponent(() => import('./designer/ProjectPages.js'), 'ProjectsPage'),
});
const projectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects/$projectId',
  component: lazyRouteComponent(() => import('./designer/ProjectPages.js'), 'ProjectPage'),
  validateSearch: (
    s: Record<string, unknown>,
  ): { tab?: string; notice?: string; call?: string; q?: string } => ({
    ...(typeof s.tab === 'string' ? { tab: s.tab } : {}),
    // The questionnaire whose cases are shown.
    ...(typeof s.q === 'string' ? { q: s.q } : {}),
    ...(typeof s.notice === 'string' ? { notice: s.notice } : {}),
    // A case to call at once (from the case drawer).
    ...(typeof s.call === 'string' ? { call: s.call } : {}),
  }),
});
const designerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects/$projectId/questionnaires/$qid',
  component: lazyRouteComponent(() => import('./designer/DesignerPage.js'), 'DesignerPage'),
  // The tab and sub-tab (design, distribution, settings), kept so Back and reload return there.
  validateSearch: (
    s: Record<string, unknown>,
  ): { tab?: string; sub?: string; notice?: string } => ({
    ...(typeof s.tab === 'string' ? { tab: s.tab } : {}),
    ...(typeof s.sub === 'string' ? { sub: s.sub } : {}),
    ...(typeof s.notice === 'string' ? { notice: s.notice } : {}),
  }),
});

const interviewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects/$projectId/interviews/$interviewId',
  component: lazyRouteComponent(() => import('./interview/InterviewPage.js'), 'InterviewPage'),
});

// Offline work on a device (CAPI): loads from the service worker's cache with no connection.
const deviceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects/$projectId/device',
  component: lazyRouteComponent(() => import('./device/DevicePage.js'), 'DevicePage'),
  validateSearch: (s: Record<string, unknown>): { notice?: string } =>
    typeof s.notice === 'string' ? { notice: s.notice } : {},
});

// Paper forms to print (PAPI).
const printRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects/$projectId/papi/print',
  component: lazyRouteComponent(() => import('./papi/PrintPage.js'), 'PrintPage'),
  validateSearch: (
    s: Record<string, unknown>,
  ): { filter?: string; limit?: number; caseIds?: string; q?: string } => ({
    ...(typeof s.filter === 'string' ? { filter: s.filter } : {}),
    ...(typeof s.q === 'string' ? { q: s.q } : {}),
    ...(typeof s.limit === 'number' ? { limit: s.limit } : {}),
    ...(typeof s.caseIds === 'string' ? { caseIds: s.caseIds } : {}),
  }),
});

const feedbackPrintRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects/$projectId/feedback/$pointId/print',
  component: lazyRouteComponent(
    () => import('./feedback/FeedbackPrintPage.js'),
    'FeedbackPrintPage',
  ),
});

// Answer review (slice 11).
const reviewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects/$projectId/review/$interviewId',
  component: lazyRouteComponent(() => import('./review/ReviewPage.js'), 'ReviewPage'),
});

// Results (slice 12): the printable summary, and the read-only summary shared with clients.
const summaryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects/$projectId/summary',
  component: lazyRouteComponent(() => import('./analysis/SummaryPage.js'), 'SummaryPage'),
  validateSearch: (s: Record<string, unknown>) =>
    Object.fromEntries(
      ['questionnaireId', 'mode', 'from', 'to', 'where', 'approvedOnly']
        .filter((k) => typeof s[k] === 'string' || typeof s[k] === 'boolean')
        .map((k) => [k, s[k]]),
    ) as Record<string, string | boolean>,
});
const shareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/share/$token',
  component: lazyRouteComponent(() => import('./analysis/SummaryPage.js'), 'SharePage'),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  twoFactorRoute,
  twoFactorSetupRoute,
  acceptInvitationRoute,
  resetPasswordRoute,
  forgotPasswordRoute,
  respondentRoute,
  openLinkRoute,
  feedbackRoute,
  unsubscribeRoute,
  shareRoute,
  appRoute.addChildren([
    homeRoute,
    waitingRoute,
    previewRoute,
    teamRoute,
    adminRoute.addChildren([
      adminUsersRoute,
      adminTeamsRoute,
      adminRolesRoute,
      adminOrganisationRoute,
      adminAuditRoute,
    ]),
    projectsRoute,
    projectRoute,
    designerRoute,
    interviewRoute,
    deviceRoute,
    printRoute,
    feedbackPrintRoute,
    reviewRoute,
    summaryRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
