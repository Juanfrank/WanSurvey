import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
} from '@tanstack/react-router';
import { AppLayout } from './routes/AppLayout.js';
import { HomePage } from './routes/HomePage.js';
import { LoginPage } from './routes/LoginPage.js';
import { TwoFactorPage, TwoFactorSetupPage } from './routes/TwoFactorPages.js';
import { WaitingPage } from './routes/WaitingPage.js';

const rootRoute = createRootRoute({ component: () => <Outlet /> });

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

// Respondent pages: outside the staff application, no sign-in (the link is the credential).
const respondentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/s/$token',
  component: lazyRouteComponent(() => import('./respondent/RespondentPage.js'), 'RespondentPage'),
});
const openLinkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/o/$slug',
  component: lazyRouteComponent(() => import('./respondent/OpenLinkPage.js'), 'OpenLinkPage'),
});
// Quick feedback (F1): a face per link, or the widget for an iframe.
const feedbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/f/$slug',
  component: lazyRouteComponent(() => import('./feedback/FeedbackPage.js'), 'FeedbackPage'),
  validateSearch: (s: Record<string, unknown>): { r?: number; ref?: string; embed?: boolean } => ({
    ...(Number.isInteger(Number(s.r)) ? { r: Number(s.r) } : {}),
    ...(typeof s.ref === 'string' || typeof s.ref === 'number' ? { ref: String(s.ref) } : {}),
    ...(s.embed === 1 || s.embed === '1' || s.embed === true ? { embed: true } : {}),
  }),
});
const unsubscribeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/u/$token',
  component: lazyRouteComponent(() => import('./respondent/UnsubscribePage.js'), 'UnsubscribePage'),
});

const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', component: AppLayout });
const homeRoute = createRoute({ getParentRoute: () => appRoute, path: '/', component: HomePage });
const waitingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/waiting',
  component: WaitingPage,
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
  validateSearch: (s: Record<string, unknown>): { tab?: string; notice?: string } => ({
    ...(typeof s.tab === 'string' ? { tab: s.tab } : {}),
    ...(typeof s.notice === 'string' ? { notice: s.notice } : {}),
  }),
});
const designerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects/$projectId/questionnaires/$qid',
  component: lazyRouteComponent(() => import('./designer/DesignerPage.js'), 'DesignerPage'),
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
  ): { filter?: string; limit?: number; caseIds?: string } => ({
    ...(typeof s.filter === 'string' ? { filter: s.filter } : {}),
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
  respondentRoute,
  openLinkRoute,
  feedbackRoute,
  unsubscribeRoute,
  shareRoute,
  appRoute.addChildren([
    homeRoute,
    waitingRoute,
    previewRoute,
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
