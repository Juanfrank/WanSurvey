import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinkBuilder } from '../src/cawi/LinkBuilder.js';
import {
  buildQuery,
  paramQuestions,
  segmentLinks,
  valueProblem,
  withQuery,
} from '../src/cawi/linkParams.js';

const definition = {
  answerSets: {
    sede: [
      { code: 1, label: { es: 'Lima' } },
      { code: 2, label: { es: 'Cusco' } },
    ],
  },
  sections: [
    {
      items: [
        {
          kind: 'question',
          id: 'SEDE',
          name: 'SEDE',
          type: 'single',
          text: { es: 'Sede' },
          answerSetId: 'sede',
          urlParam: 'sede',
        },
        {
          kind: 'block',
          items: [
            {
              kind: 'question',
              id: 'EDAD',
              name: 'EDAD',
              type: 'numeric',
              text: { es: 'Edad' },
              urlParam: 'edad',
            },
            {
              kind: 'question',
              id: 'SIN',
              name: 'SIN',
              type: 'text',
              text: { es: 'Sin parámetro' },
            },
          ],
        },
        {
          kind: 'roster',
          items: [
            {
              kind: 'question',
              id: 'R',
              name: 'R',
              type: 'text',
              text: { es: 'En lista' },
              urlParam: 'r',
            },
          ],
        },
        {
          kind: 'question',
          id: 'GRUPO',
          name: 'GRUPO',
          type: 'single',
          text: { es: 'Grupo' },
          urlParam: 'grupo',
          options: [
            { code: 'A', label: { es: 'A' } },
            { code: 'B', label: { es: 'B' } },
          ],
        },
      ],
    },
  ],
};

describe('link parameters', () => {
  it('finds the questions a link can answer, in order, outside rosters', () => {
    const q = paramQuestions(definition, 'es');
    expect(q.map((x) => x.param)).toEqual(['sede', 'edad', 'grupo']);
    expect(q[0]!.options).toEqual([
      { code: '1', label: 'Lima' },
      { code: '2', label: 'Cusco' },
    ]);
  });

  it('says why a value would be dropped, as the engine does', () => {
    const [sede, edad] = paramQuestions(definition, 'es');
    expect(valueProblem(sede!, '2')).toBeNull();
    expect(valueProblem(sede!, '9')).toBe('notAnOption');
    expect(valueProblem(edad!, 'abc')).toBe('notANumber');
    expect(valueProblem(edad!, '')).toBeNull();
  });

  it('builds an encoded query, leaves empty values out and joins to an existing one', () => {
    const query = buildQuery([
      { param: 'sede', value: '2' },
      { param: 'nota', value: 'a b&c' },
      { param: 'vacio', value: '  ' },
    ]);
    expect(query).toBe('sede=2&nota=a%20b%26c');
    expect(withQuery('https://x/s/abc', query)).toBe('https://x/s/abc?sede=2&nota=a%20b%26c');
    expect(withQuery('https://x/s/abc?k=1', 'a=2')).toBe('https://x/s/abc?k=1&a=2');
    expect(withQuery('https://x/s/abc', '')).toBe('https://x/s/abc');
  });

  it('makes one address per value of the segment with the fixed parameters', () => {
    const [sede] = paramQuestions(definition, 'es');
    expect(
      segmentLinks('https://x/s/abc', [{ param: 'edad', value: '30' }], sede!, ['1', '2']),
    ).toEqual([
      { value: '1', label: 'Lima', url: 'https://x/s/abc?edad=30&sede=1' },
      { value: '2', label: 'Cusco', url: 'https://x/s/abc?edad=30&sede=2' },
    ]);
  });
});

function mockApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = url.replace('/api/v1', '');
      const body = path.endsWith('/versions/3') ? { definition } : { latestVersion: 3 };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

describe('the link builder', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds the address, marks a value the survey would drop, and makes a link per segment', async () => {
    mockApi();
    const user = userEvent.setup();
    const seen: string[] = [];
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <LinkBuilder
          projectId="p"
          questionnaireId="q"
          baseUrl="https://x/s/abc"
          onQueryChange={(s) => seen.push(s)}
        />
      </QueryClientProvider>,
    );
    await user.click(
      await screen.findByRole('button', { name: /Agregar una pregunta|Add a question/ }),
    );
    const row = document.querySelector('[data-param-row="sede"]') as HTMLElement;
    await user.selectOptions(within(row).getAllByRole('combobox')[1]!, '2');
    expect(screen.getByTestId('builder-url').textContent).toBe('https://x/s/abc?sede=2');
    expect(seen.at(-1)).toBe('sede=2');

    // A second question, with a value it does not take.
    await user.click(screen.getByRole('button', { name: /Agregar una pregunta|Add a question/ }));
    const second = document.querySelector('[data-param-row="edad"]') as HTMLElement;
    await user.type(within(second).getByRole('spinbutton'), '-');
    // Segments by group, keeping the branch.
    await user.selectOptions(
      screen.getByRole('combobox', { name: /Segmentar por|Segment by/ }),
      'grupo',
    );
    const table = screen.getByTestId('segment-links');
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(table.textContent).toContain('https://x/s/abc?sede=2&grupo=A');
    expect(table.textContent).toContain('https://x/s/abc?sede=2&grupo=B');
  });
});
