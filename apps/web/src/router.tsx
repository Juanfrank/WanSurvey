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

const routeTree = rootRoute.addChildren([
  loginRoute,
  twoFactorRoute,
  twoFactorSetupRoute,
  appRoute.addChildren([
    homeRoute,
    waitingRoute,
    previewRoute,
    projectsRoute,
    projectRoute,
    designerRoute,
    interviewRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
