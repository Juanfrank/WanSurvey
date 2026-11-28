import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { router as appRouter } from '../src/router.js';

/**
 * The installation's mode comes with the session (`GET /auth/me`, `singleTenant`; before sign-in
 * `GET /auth/methods` says it too): with one organisation (SINGLE_TENANT=true) nothing about
 * choosing, switching or "the whole installation" is shown.
 */
function mockFetch(routes: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = url.replace('/api/v1', '');
      return path in routes
        ? new Response(JSON.stringify(routes[path]), { status: 200 })
        : new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    }),
  );
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

afterEach(() => vi.unstubAllGlobals());

const methods = (singleTenant: boolean) => ({
  password: true,
  microsoftNeedsEmail: !singleTenant,
  singleTenant,
});

const me = (single: boolean, access: 'ok' | 'no_role', permissions: string[] = []) => ({
  singleTenant: single,
  user: { id: 'u', email: 'ana@agency.org', name: 'Ana', firstName: 'Ana', totpEnabled: true },
  tenantId: 't1',
  // As an API of the default mode would list them: the web app must not offer the second.
  tenants: [
    { id: 't1', slug: 'demo', name: 'Demo Research' },
    { id: 't2', slug: 'demo2', name: 'Second Agency' },
  ],
  mfaState: 'ok',
  memberships: access === 'ok' ? [{ role: 'owner', projectId: null }] : [],
  permissions,
  access:
    access === 'ok'
      ? { state: 'ok', message: null }
      : { state: 'no_role', message: 'No role in Demo Research yet.' },
  terms: { version: 1, acceptedVersion: 1, accepted: true },
});

/** The account menu's organisation picker (in the menu, hidden until it opens). */
const picker = () => screen.queryByRole('combobox', { name: 'Organisation', hidden: true });

describe.each([true, false])('single-tenant mode %s', (single) => {
  it(
    single
      ? 'the account menu has no organisation to choose'
      : 'the account menu lets the person switch organisation',
    async () => {
      mockFetch({ '/auth/methods': methods(single), '/auth/me': me(single, 'ok') });
      renderAt('/');
      await screen.findByRole('combobox', { name: 'Language', hidden: true });
      expect(!!picker()).toBe(!single);
    },
  );

  it(
    single
      ? 'the waiting page offers no other organisation'
      : 'the waiting page offers the other organisations',
    async () => {
      mockFetch({ '/auth/methods': methods(single), '/auth/me': me(single, 'no_role') });
      const router = renderAt('/');
      await waitFor(() => expect(router.state.location.pathname).toBe('/waiting'));
      await screen.findByTestId('access-message');
      expect(!!screen.queryByRole('button', { name: 'Switch' })).toBe(!single);
    },
  );

  it(
    single
      ? 'the Organisation page has no "whole installation" block'
      : 'the Organisation page keeps the installation block apart',
    async () => {
      mockFetch({
        '/auth/methods': methods(single),
        '/auth/me': me(single, 'ok', ['tenant.read', 'tenant.manage']),
      });
      renderAt('/admin/organisation');
      // The refresh of the analysis model is there either way: among the organisation's cards in
      // single-tenant mode, under "Whole installation" otherwise.
      expect(await screen.findByText('Analysis model refresh')).toBeTruthy();
      expect(screen.getAllByText('Analysis model refresh')).toHaveLength(1);
      expect(!!screen.queryByRole('heading', { name: 'Whole installation' })).toBe(!single);
    },
  );
});
