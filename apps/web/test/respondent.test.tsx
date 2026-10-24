import 'fake-indexeddb/auto';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { compile } from '@wansurvey/logic';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InterviewStore } from '../src/interview/store.js';
import { router as appRouter } from '../src/router.js';

const compiled = compile({
  id: 'WEB',
  title: { es: 'Web' },
  defaultLanguage: 'es',
  languages: ['es'],
  sections: [
    {
      id: 'S',
      title: { es: 'S' },
      items: [
        {
          kind: 'question',
          id: 'A',
          name: 'A',
          type: 'single',
          text: { es: '¿Trabaja?' },
          options: [
            { code: 1, label: { es: 'Sí' } },
            { code: 2, label: { es: 'No' } },
          ],
        },
      ],
    },
  ],
} as never);

const payload = {
  interview: {
    id: 'i-1',
    language: 'es',
    status: 'in_progress',
    startedAt: '2026-10-12T10:00:00.000Z',
    state: {},
    stateVersion: 0,
    ownState: false,
    activeMs: 0,
    totalMs: 0,
  },
  context: { case: {}, params: {} },
  compiled,
  lastSeq: 0,
  serverTime: '2026-10-12T10:00:00.000Z',
  completion: { message: '', redirectUrl: '' },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('respondent page', () => {
  it('goes on in memory when the device cannot keep the answers, and still sends them', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const body = init.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url, body });
        if (url.includes('/sync')) {
          const ops = (body as { ops: { seq: number }[] }).ops;
          return new Response(
            JSON.stringify({
              acks: { 'i-1': ops.at(-1)?.seq ?? 0 },
              errors: {},
              versions: { 'i-1': 1 },
              serverTime: '',
            }),
          );
        }
        return new Response(JSON.stringify(payload));
      }),
    );
    // Every write to the browser's storage fails (full, or blocked).
    vi.spyOn(InterviewStore.prototype, 'record').mockRejectedValue(new Error('QuotaExceeded'));
    const router = createRouter({
      routeTree: appRouter.routeTree,
      history: createMemoryHistory({ initialEntries: ['/s/tok-1234567890abcdef'] }),
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByLabelText('Sí'));
    // The survey is handed over to a device id kept in memory, and the answer is sent from it.
    await waitFor(() => expect(calls.some((c) => c.url.includes('/sync'))).toBe(true));
    const opens = calls.filter((c) => c.url.includes('?device='));
    expect(opens).toHaveLength(2);
    const memoryDevice = new URL(opens[1]!.url, 'http://x').searchParams.get('device');
    expect(memoryDevice).not.toBe(new URL(opens[0]!.url, 'http://x').searchParams.get('device'));
    const sync = calls.find((c) => c.url.includes('/sync'))!.body as {
      deviceId: string;
      ops: { variable?: string; newValue?: unknown }[];
      state: { answers: Record<string, unknown> };
    };
    expect(sync.deviceId).toBe(memoryDevice);
    expect(sync.ops).toContainEqual(expect.objectContaining({ variable: 'A', newValue: 1 }));
    expect(sync.state.answers).toMatchObject({ A: 1 });
    // A second answer goes the same way: the failure did not stop the writes after it.
    fireEvent.click(screen.getByLabelText('No'));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.url.includes('/sync')).at(-1)!.body as { state: unknown },
      ).toMatchObject({ state: { answers: { A: 2 } } }),
    );
  });
});
