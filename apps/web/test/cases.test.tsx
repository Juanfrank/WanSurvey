import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CasesTab } from '../src/cases/CasesTab.js';
import { CaseMap } from '../src/cases/CaseMap.js';
import { SettingsTab } from '../src/cases/SettingsTab.js';

const me = {
  user: { id: 'u1', email: 'pm@x', name: 'PM', firstName: 'PM', totpEnabled: false },
  tenantId: 't1',
  tenants: [],
  mfaState: 'ok',
  memberships: [{ role: 'project_manager', projectId: null }],
  permissions: [],
  access: { state: 'ok', message: null },
};
const rows = Array.from({ length: 5 }, (_, i) => ({
  id: `c${i}`,
  externalId: `HH${i}`,
  sample: { first_name: '•••', region: (i % 3) + 1 },
  status: 'fresh',
  disposition: null,
  priority: 0,
  modePreference: null,
  assignedTo: null,
  assignedName: null,
  updatedAt: '2026-10-12T00:00:00Z',
}));

function mockFetch() {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const path = url.replace('/api/v1', '');
      let body: unknown = {};
      if (path === '/auth/me') body = me;
      else if (path.startsWith('/projects/p/cases/assign')) body = { changed: 2, skipped: 0 };
      else if (path.startsWith('/projects/p/cases'))
        body = {
          total: 5,
          page: 1,
          limit: 25,
          counts: { fresh: 5 },
          fields: [
            { name: 'first_name', label: null, type: 'text', pii: true },
            { name: 'region', label: null, type: 'number', pii: false },
          ],
          piiMasked: true,
          canReveal: true,
          rows,
        };
      else if (path === '/projects/p/assignees')
        body = [{ userId: 'i1', name: 'Ines', email: 'i@x', roles: ['interviewer'], workload: {} }];
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('cases grid', () => {
  it('shows masked personal fields, selects ranges with Shift and assigns', async () => {
    const calls = mockFetch();
    const user = userEvent.setup();
    const { container } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CasesTab projectId="p" />
      </QueryClientProvider>,
    );
    const table = await screen.findByTestId('cases-table');
    await waitFor(() => expect(within(table).getAllByText('•••')).toHaveLength(5));
    expect(screen.getByText(/Personal fields are hidden/)).toBeTruthy();

    await user.click(screen.getByLabelText('Select case HH1'));
    await user.keyboard('{Shift>}');
    await user.click(screen.getByLabelText('Select case HH3'));
    await user.keyboard('{/Shift}');
    expect(screen.getByText('3 selected')).toBeTruthy();

    await waitFor(() =>
      expect(screen.getAllByRole('option', { name: 'Ines' }).length).toBeGreaterThan(0),
    );
    await user.selectOptions(screen.getByLabelText('Assign selected to'), 'i1');
    await user.click(screen.getByRole('button', { name: 'Assign' }));
    await screen.findByText('2 cases assigned.');
    const post = calls.find((c) => c.url.endsWith('/cases/assign'))!;
    expect(JSON.parse(String(post.init!.body))).toEqual({
      caseIds: ['c1', 'c2', 'c3'],
      userId: 'i1',
    });

    const result = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});

describe('project settings', () => {
  it('saves the personal data and assignment mode switches', async () => {
    const calls = mockFetch();
    const user = userEvent.setup();
    const project = {
      id: 'p',
      name: 'P',
      code: 'P',
      status: 'active',
      languages: ['en'],
      modesEnabled: [],
      settings: { revealToInterviewers: true, assignmentMode: 'assigned' as const },
    };
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <SettingsTab project={project} />
      </QueryClientProvider>,
    );
    const reveal = screen.getByRole('checkbox', { name: /Show interviewers the personal data/ });
    expect(reveal).toHaveProperty('checked', true);
    await user.click(reveal);
    await user.click(screen.getByRole('radio', { name: /Open pool/ }));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Settings saved.');
    const patch = calls.find((c) => c.init?.method === 'PATCH')!;
    expect(patch.url).toMatch(/\/projects\/p$/);
    expect(JSON.parse(String(patch.init!.body))).toEqual({
      settings: { revealToInterviewers: false, assignmentMode: 'pool' },
    });
    const result = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});

describe('case map', () => {
  it('lists the points as a table and starts geocoding', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const path = url.replace('/api/v1', '');
        let body: unknown = {};
        if (path === '/auth/me') body = me;
        else if (path.endsWith('/cases-map'))
          body = [
            {
              caseId: 'c1',
              externalId: 'HH1',
              status: 'fresh',
              lat: -12.05,
              lng: -77.04,
              quality: 'house',
            },
          ];
        else if (path.endsWith('/geocode/status'))
          body = {
            enabled: true,
            job: { running: false, total: 3, done: 3, found: 2, notFound: 1, failed: 0 },
          };
        else if (path.endsWith('/geocode')) body = { running: true, total: 3 };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const user = userEvent.setup();
    const opened: string[] = [];
    const { container } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CaseMap projectId="p" onOpen={(id) => opened.push(id)} />
      </QueryClientProvider>,
    );
    await screen.findByText('Addresses: 2 found, 1 not found, 0 failed.');
    expect(screen.getByText(/sent to OpenStreetMap Nominatim/)).toBeTruthy();
    await user.click(screen.getByText('1 point as a table'));
    await user.click(screen.getByRole('button', { name: 'HH1' }));
    expect(opened).toEqual(['c1']);
    expect(screen.getByText('-12.05000, -77.04000')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Find addresses on the map' })).toBeTruthy(),
    );
    await user.click(screen.getByRole('button', { name: 'Find addresses on the map' }));
    expect(calls.some((c) => c.url.endsWith('/geocode') && c.init?.method === 'POST')).toBe(true);
    const result = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});
