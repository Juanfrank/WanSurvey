import { randomUUID } from 'node:crypto';
import { sql, type RawBuilder } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMssqlDb } from '../../src/db/mssql/connection.js';
import { MssqlDatabase } from '../../src/db/mssql/database.js';
import { runMssqlMigrations } from '../../src/db/mssql/migrate.js';
import { BiStore } from '../../src/stats/bi-store.mssql.js';
import { QuestionnaireStore } from '../../src/questionnaires/questionnaire-store.mssql.js';

/**
 * The analysis model on SQL Server (mssql/0009): the text helpers, the dimensions, the facts
 * (answers at any roster depth, special answers, positions, grid rows, paradata) and the flat
 * table, built by the refresh procedures; and that the application user can run those and read
 * nothing in bi. Runs only where a SQL Server is given.
 */
const ADMIN = process.env.MSSQL_ADMIN_URL;
const APP = process.env.MSSQL_URL;

const COMPILED = {
  hash: 'bi1',
  questionnaire: {
    defaultLanguage: 'es',
    settings: { specialCodes: { dk: { code: '-97', label: { es: 'No sabe' } } } },
    answerSets: {
      sat: [
        { code: '1', label: { es: 'Bajo' } },
        { code: '2', label: { es: 'Alto' } },
      ],
    },
    sections: [
      {
        items: [
          {
            kind: 'question',
            name: 'P1',
            type: 'single',
            text: { es: '<b>¿Edad?</b> {{x}}' },
            answerSetId: 'sat',
          },
          {
            kind: 'block',
            items: [
              {
                kind: 'question',
                name: 'P2',
                type: 'multi',
                text: { es: 'Cuáles' },
                options: [
                  { code: 'a', label: { es: 'A' } },
                  { code: 'b', label: { es: 'B' } },
                ],
              },
            ],
          },
          {
            kind: 'roster',
            items: [{ kind: 'question', name: 'NOM', type: 'text', text: { es: 'Nombre' } }],
          },
          {
            kind: 'question',
            name: 'G',
            type: 'grid',
            text: { es: 'Cuadrícula' },
            rows: [{ code: 'r1', label: { es: 'Fila 1' } }],
            options: [{ code: '1', label: { es: 'Sí' } }],
          },
          {
            kind: 'question',
            name: 'L',
            type: 'scale',
            text: { es: 'Escala' },
            scale: {
              min: 1,
              max: 3,
              step: 1,
              style: 'likert',
              minLabel: { es: 'Malo' },
              maxLabel: { es: 'Bueno' },
            },
          },
        ],
      },
    ],
  },
  vars: {
    P1: { kind: 'question', type: 'single', rosterChain: [] },
    NOM: { kind: 'question', type: 'text', rosterChain: ['members'] },
    TOT: { kind: 'computed', type: 'number', rosterChain: [] },
  },
};

describe.skipIf(!ADMIN || !APP)('SQL Server: analysis model (bi)', () => {
  let app: MssqlDatabase;
  const questionnaires = new QuestionnaireStore();
  const stamp = Date.now().toString(36);
  const TZ = 'America/Guatemala';
  const a = { id: randomUUID(), slug: `bi-${stamp}`, project: randomUUID() };
  const user = randomUUID();
  const i1 = randomUUID();
  const i2 = randomUUID();
  let versionId: string;
  let q: string;

  const owner = async <T>(
    fn: (db: ReturnType<typeof createMssqlDb<Record<string, never>>>) => Promise<T>,
  ) => {
    const db = createMssqlDb<Record<string, never>>(ADMIN!, { max: 1, requestTimeoutMs: 0 });
    try {
      return await fn(db);
    } finally {
      await db.destroy();
    }
  };
  const rows = <T>(query: RawBuilder<T>) => owner(async (db) => (await query.execute(db)).rows);

  beforeAll(async () => {
    await runMssqlMigrations(ADMIN!, APP!);
    app = new MssqlDatabase(APP!, { max: 4 });
    await owner(async (db) => {
      await sql`INSERT INTO tenants (id, name, slug) VALUES (${a.id}, ${a.slug}, ${a.slug})`.execute(
        db,
      );
      await sql`INSERT INTO projects (id, tenant_id, name, code, timezone) VALUES (${a.project}, ${a.id}, 'P', ${'P-' + a.slug}, ${TZ})`.execute(
        db,
      );
      await sql`INSERT INTO users (id, tenant_id, email, name) VALUES (${user}, ${a.id}, ${`u-${stamp}@example.org`}, 'Ana')`.execute(
        db,
      );
      await sql`INSERT INTO memberships (id, tenant_id, user_id, role) VALUES (${randomUUID()}, ${a.id}, ${user}, 'interviewer')`.execute(
        db,
      );
    });
    q = await app.withTenant(a.id, (tx) =>
      questionnaires.create(tx, {
        tenantId: a.id,
        projectId: a.project,
        name: 'Encuesta',
        draft: {},
        userId: user,
      }),
    );
    await app.withTenant(a.id, (tx) =>
      questionnaires.publish(tx, {
        tenantId: a.id,
        questionnaireId: q,
        definition: {},
        compiled: COMPILED,
        mapping: null,
        userId: user,
      }),
    );
    versionId = await app.withTenant(a.id, async (tx) =>
      (
        await tx
          .selectFrom('questionnaire_versions')
          .select('id')
          .where('questionnaire_id', '=', q)
          .executeTakeFirstOrThrow()
      ).id.toLowerCase(),
    );
    await owner(async (db) => {
      const ins = (id: string, submittedAt: string, answers: object) =>
        sql`INSERT INTO interviews (id, tenant_id, project_id, questionnaire_version_id, mode, interviewer_id,
              status, disposition, language, device_id, submitted_at, active_ms, total_ms, answers, flags)
            VALUES (${id}, ${a.id}, ${a.project}, ${versionId}, 'CATI', ${user}, 'submitted', 'COMPLETE', 'es', 'd',
              ${submittedAt}, 4600, 9000, ${JSON.stringify(answers)}, '{"speeding":true,"alone":true}')`.execute(
          db,
        );
      await ins(i1, '2026-11-02T03:00:00Z', {
        P1: '2',
        P2: ['a', 'b'],
        members: [{ NOM: 'Ana' }, { NOM: 'Luis' }],
        G: { r1: '1' },
        L: 3,
        TOT: 12,
      });
      await ins(i2, '2026-11-02T15:00:00Z', { P1: { $special: 'dk' }, P2: [], L: 1 });
      await sql`INSERT INTO interview_paradata (id, tenant_id, interview_id, device_id, seq, type, at, payload)
        VALUES (${randomUUID()}, ${a.id}, ${i1}, 'd', 1, 'navigate_back', '2026-11-02T03:05:00Z',
                '{"key":"s.members[2].NOM[1]","ms":2500}')`.execute(db);
      await sql`INSERT INTO interview_paradata (id, tenant_id, interview_id, device_id, seq, type, at, payload)
        VALUES (${randomUUID()}, ${a.id}, ${i1}, 'd', 2, 'note_added', '2026-11-02T03:06:00Z', '{"text":"hola"}')`.execute(
        db,
      );
      await sql`EXEC bi.guardar_zonas ${JSON.stringify([{ tz: TZ, desde: '2000-01-01T00:00:00', minutos: -360 }])}`.execute(
        db,
      );
      await sql`EXEC bi.refrescar`.execute(db);
    });
  });
  afterAll(async () => {
    await app?.destroy();
  });

  const key = (...p: string[]) =>
    rows<{ k: string }>(sql`SELECT bi.clave(${p.join('|')}) AS k`).then((r) => r[0]!.k);
  const resp = (envio: string) =>
    rows<{
      variable: string;
      ruta: string | null;
      miembro: number | null;
      fila_codigo: string | null;
      posicion: number | null;
      valor: string | null;
      especial: boolean;
      especial_clase: string | null;
      valor_numero: number | null;
      opcion_id: string | null;
    }>(sql`SELECT variable, ruta, miembro, fila_codigo, posicion, valor, especial, especial_clase,
                  valor_numero, opcion_id
           FROM bi.fact_respuesta WHERE envio_id = ${envio} ORDER BY variable, ruta, fila_codigo, posicion`);

  it('cleans labels, writes numbers and keys the way the model does', async () => {
    const r = await rows<Record<string, unknown>>(sql`SELECT
      bi.plano(N'<b>Hola</b>   {{#if x}}mundo{{else}}nada{{/if}} {{nombre}}') AS plano,
      bi.texto(N'{"en":"Hi","es":"Hola"}', N'es') AS es,
      bi.texto(N'{"en":"Hi"}', N'fr') AS primero,
      bi.numero(N' 12.5 ') AS n1, bi.numero(N'abc') AS n2, bi.numero(N'1e3') AS n3,
      bi.variable_de(N's1.members[2].age[1]') AS variable, bi.ruta_de(N's1.members[2].age[1]') AS ruta,
      bi.clave(N'a|b') AS clave`);
    expect(r[0]).toMatchObject({
      plano: 'Hola mundo nada …',
      es: 'Hola',
      primero: 'Hi',
      variable: 'age',
      ruta: '2.1',
    });
    expect(Number(r[0]!.n1)).toBe(12.5);
    expect(r[0]!.n2).toBeNull();
    expect(Number(r[0]!.n3)).toBe(1000);
    expect(r[0]!.clave).toMatch(/^[0-9a-f]{32}$/);
  });

  it('lists the questions of every nesting level, with their roster list and computed variables', async () => {
    const r = await rows<{
      variable: string;
      tipo: string;
      clase: string;
      pregunta: string | null;
      lista: string | null;
      cadena: string | null;
      pregunta_id: string;
    }>(sql`SELECT variable, tipo, clase, pregunta, lista, cadena, pregunta_id
           FROM bi.dim_pregunta WHERE version_id = ${versionId} ORDER BY orden, variable`);
    expect(r.map((x) => x.variable)).toEqual(['P1', 'P2', 'NOM', 'G', 'L', 'TOT']);
    const by = Object.fromEntries(r.map((x) => [x.variable, x]));
    expect(by.P1).toMatchObject({
      tipo: 'single',
      clase: 'pregunta',
      pregunta: '¿Edad? …',
      lista: null,
    });
    expect(by.NOM).toMatchObject({ lista: 'members', cadena: 'members' });
    expect(by.TOT).toMatchObject({ clase: 'computed', pregunta: null });
    expect(by.P1!.pregunta_id).toBe(await key(versionId, 'P1'));
  });

  it('has options from the question, the shared set, scale points and special codes', async () => {
    const opts = async (variable: string) =>
      (
        await rows<{ codigo: string; etiqueta: string | null; especial: boolean }>(sql`
          SELECT o.codigo, o.etiqueta, o.especial FROM bi.dim_opcion o
          JOIN bi.dim_pregunta p ON p.pregunta_id = o.pregunta_id
          WHERE p.version_id = ${versionId} AND p.variable = ${variable} ORDER BY o.especial, o.orden`)
      ).map((x) => [x.codigo, x.etiqueta, !!x.especial]);
    expect(await opts('P1')).toEqual([
      ['1', 'Bajo', false],
      ['2', 'Alto', false],
      ['-97', 'No sabe', true],
    ]);
    expect(await opts('P2')).toEqual([
      ['a', 'A', false],
      ['b', 'B', false],
      ['-97', 'No sabe', true],
    ]);
    expect(await opts('L')).toEqual([
      ['1', '1 – Malo', false],
      ['2', '2', false],
      ['3', '3 – Bueno', false],
      ['-97', 'No sabe', true],
    ]);
    const filas = await rows<{ fila_codigo: string; fila: string }>(sql`
      SELECT f.fila_codigo, f.fila FROM bi.dim_fila f JOIN bi.dim_pregunta p ON p.pregunta_id = f.pregunta_id
      WHERE p.version_id = ${versionId}`);
    expect(filas).toEqual([{ fila_codigo: 'r1', fila: 'Fila 1' }]);
  });

  it('flattens answers: values, positions, grid rows, roster members, empty lists and specials', async () => {
    const r1 = await resp(i1);
    expect(r1.map((x) => [x.variable, x.ruta, x.fila_codigo, x.posicion, x.valor])).toEqual([
      ['G', null, 'r1', null, '1'],
      ['L', null, null, null, '3'],
      ['NOM', '1', null, null, 'Ana'],
      ['NOM', '2', null, null, 'Luis'],
      ['P1', null, null, null, '2'],
      ['P2', null, null, 1, 'a'],
      ['P2', null, null, 2, 'b'],
      ['TOT', null, null, null, '12'],
    ]);
    expect(r1.find((x) => x.variable === 'NOM' && x.ruta === '2')!.miembro).toBe(2);
    expect(Number(r1.find((x) => x.variable === 'L')!.valor_numero)).toBe(3);
    expect(r1.find((x) => x.variable === 'P1')!.opcion_id).toBe(await key(versionId, 'P1', '2'));

    const r2 = await resp(i2);
    expect(
      r2.map((x) => [x.variable, x.posicion, x.valor, !!x.especial, x.especial_clase]),
    ).toEqual([
      ['L', null, '1', false, null],
      ['P1', null, '-97', true, 'dk'],
      ['P2', null, null, false, null],
    ]);
    expect(r2.find((x) => x.variable === 'P1')!.valor_numero).toBeNull();
  });

  it('counts one row per submission, with the local day, paradata counts and flags', async () => {
    const r = await rows<{
      envio_id: string;
      fecha: Date;
      retrocesos: number;
      notas: number;
      completa: number;
      alertas: string;
      segundos_activos: number;
    }>(sql`SELECT envio_id, CONVERT(varchar(10), fecha, 23) AS fecha, retrocesos, notas, completa, alertas,
                  segundos_activos
           FROM bi.fact_envio WHERE version_id = ${versionId} ORDER BY enviado_en`);
    expect(r.map((x) => [x.fecha, x.retrocesos, x.notas, x.completa, x.alertas])).toEqual([
      // 03:00Z on the 2nd is still the 1st in Guatemala (UTC-6).
      ['2026-11-01', 1, 1, 1, 'alone speeding'],
      ['2026-11-02', 0, 0, 1, 'alone speeding'],
    ]);
    expect(Number(r[0]!.segundos_activos)).toBe(5);
  });

  it('ties paradata to the question and roster member it is about', async () => {
    const r = await rows<{
      tipo: string;
      variable: string | null;
      ruta: string | null;
      segundos: number | null;
      pregunta_id: string | null;
    }>(
      sql`SELECT tipo, variable, ruta, segundos, pregunta_id FROM bi.fact_paradato WHERE envio_id = ${i1} ORDER BY secuencia`,
    );
    expect(r[0]).toMatchObject({ tipo: 'navigate_back', variable: 'NOM', ruta: '2.1' });
    expect(Number(r[0]!.segundos)).toBe(2.5);
    expect(r[0]!.pregunta_id).toBe(await key(versionId, 'NOM'));
    expect(r[1]).toMatchObject({ tipo: 'note_added', variable: null, ruta: null });
  });

  it('joins everything in the flat table, with labels, the interviewer and the day', async () => {
    const r = await rows<{
      variable: string;
      respuesta: string;
      entrevistador: string;
      anio_mes: string;
      instrumento: string;
    }>(
      sql`SELECT variable, respuesta, entrevistador, anio_mes, instrumento FROM bi.plano_respuestas
          WHERE envio_id = ${i1} AND variable IN ('P1', 'G') ORDER BY variable`,
    );
    expect(r).toEqual([
      {
        variable: 'G',
        respuesta: 'Sí',
        entrevistador: 'Ana',
        anio_mes: '2026-11',
        instrumento: 'Encuesta',
      },
      {
        variable: 'P1',
        respuesta: 'Alto',
        entrevistador: 'Ana',
        anio_mes: '2026-11',
        instrumento: 'Encuesta',
      },
    ]);
  });

  it('keeps a fingerprint, so the application refreshes only when something changed', async () => {
    const state = () =>
      app.db.transaction().execute(async (tx) => {
        const res = await sql<{
          actual: string;
          ultima: string | null;
        }>`EXEC bi.estado_actual`.execute(tx);
        return res.rows[0]!;
      });
    const before = await state();
    await app.db.transaction().execute(async (tx) => {
      await sql`EXEC bi.marcar_huella ${before.actual}`.execute(tx);
    });
    expect((await state()).ultima).toBe(before.actual);
    await owner((db) =>
      sql`UPDATE interviews SET updated_at = SYSDATETIMEOFFSET() WHERE id = ${i2}`.execute(db),
    );
    const after = await state();
    expect(after.actual).not.toBe(before.actual);
    expect(after.ultima).toBe(before.actual);
  });

  it('lets the application refresh one table at a time but read nothing in bi', async () => {
    await app.db.transaction().execute(async (tx) => {
      await sql`EXEC bi.refrescar_vista ${'dim_fila'}`.execute(tx);
    });
    await expect(
      app.db.transaction().execute(async (tx) => {
        await sql`EXEC bi.refrescar_vista ${'tenants'}`.execute(tx);
      }),
    ).rejects.toThrow(/Not a table of the analysis model/);
    await expect(sql`SELECT TOP 1 * FROM bi.dim_pregunta`.execute(app.db)).rejects.toThrow(
      /permission was denied/i,
    );
    await expect(sql`SELECT TOP 1 * FROM bi.fact_respuesta`.execute(app.db)).rejects.toThrow(
      /permission was denied/i,
    );
  });

  it('refreshes from the application: zones first, only when something changed', async () => {
    const store = new BiStore();
    expect(await store.saveZones(app)).toBeGreaterThan(0);
    expect(await store.refresh(app, true)).toBe(true);
    expect(await store.refresh(app)).toBe(false);
    await owner((db) =>
      sql`UPDATE interviews SET updated_at = SYSDATETIMEOFFSET() WHERE id = ${i2}`.execute(db),
    );
    expect(await store.refresh(app)).toBe(true);
    const days = await rows<{ fecha: string }>(
      sql`SELECT CONVERT(varchar(10), fecha, 23) AS fecha FROM bi.fact_envio WHERE version_id = ${versionId} ORDER BY enviado_en`,
    );
    expect(days.map((d) => d.fecha)).toEqual(['2026-11-01', '2026-11-02']);
  });
});
