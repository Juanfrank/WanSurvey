import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, nextRouteFor, ssoStartUrl } from '../src/api.js';
import { router as appRouter } from '../src/router.js';

function mockFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const hit = routes[url.replace('/api/v1', '')] ?? {
        status: 404,
        body: { message: 'not found' },
      };
      return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 });
    }),
  );
  return calls;
}

function renderAt(path: string) {
  const router = createRouter({
    routeTree: appRouter.routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = 'ws_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
});

const me = (access: 'ok' | 'no_role', mfaState = 'ok') => ({
  user: { id: 'u', email: 'ana@agency.org', name: 'Ana', firstName: 'Ana', totpEnabled: false },
  tenantId: 't1',
  tenants: [
    { id: 't1', slug: 'demo', name: 'Demo Research' },
    { id: 't2', slug: 'demo2', name: 'Second Agency' },
  ],
  mfaState,
  memberships: access === 'ok' ? [{ role: 'interviewer', projectId: null }] : [],
  permissions: [],
  access:
    access === 'ok'
      ? { state: 'ok', message: null }
      : {
          state: 'no_role',
          message:
            'Your account is active, but no role has been assigned to you in Demo Research yet.',
        },
});

describe('api client', () => {
  it('sends the CSRF token on writes only, with cookies', async () => {
    document.cookie = 'ws_csrf=abc%2B1';
    const calls = mockFetch({ '/x': { body: { ok: true } } });
    await api('/x');
    await api('/x', { method: 'POST', body: { a: 1 } });
    expect((calls[0]!.init.headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
    expect((calls[1]!.init.headers as Record<string, string>)['x-csrf-token']).toBe('abc+1');
    expect(calls[1]!.init.credentials).toBe('include');
  });

  it('routes people according to their session', () => {
    expect(nextRouteFor({ mfaState: 'pending', access: { state: 'ok', message: null } })).toBe(
      '/login/2fa',
    );
    expect(nextRouteFor({ mfaState: 'enroll', access: { state: 'ok', message: null } })).toBe(
      '/login/2fa/setup',
    );
    expect(nextRouteFor({ mfaState: 'ok', access: { state: 'no_role', message: 'x' } })).toBe(
      '/waiting',
    );
    expect(nextRouteFor({ mfaState: 'ok', access: { state: 'ok', message: null } })).toBeNull();
    expect(ssoStartUrl('ana@agency.org')).toBe(
      '/api/v1/auth/sso/start?email=ana%40agency.org&returnTo=%2F',
    );
  });
});

describe('screens', () => {
  it('login explains a Microsoft sign-in failure', async () => {
    mockFetch({});
    renderAt('/login?sso_error=domain_not_allowed');
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Your e-mail domain is not allowed for this organisation.',
    );
    expect(screen.getByRole('button', { name: 'Sign in with Microsoft' })).toBeTruthy();
  });

  it('sends someone without a role to the waiting page and shows the API message', async () => {
    mockFetch({ '/auth/me': { body: me('no_role') } });
    const router = renderAt('/');
    await waitFor(() => expect(router.state.location.pathname).toBe('/waiting'));
    expect(await screen.findByTestId('access-message')).toHaveProperty(
      'textContent',
      'Your account is active, but no role has been assigned to you in Demo Research yet.',
    );
    expect(screen.getByRole('button', { name: 'Switch' })).toBeTruthy(); // other organisation offered
  });

  it('sends signed-out visitors to the login page', async () => {
    mockFetch({ '/auth/me': { status: 401, body: { code: 'UNAUTHENTICATED' } } });
    const router = renderAt('/');
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });
});
