import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db/database.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import {
  bootstrap,
  createProject,
  createQuestionnaire,
  createTenant,
  unique,
  type TestApp,
} from './harness.js';

/** The analysis model (schema bi): snowflake and flat table, refreshed by a scheduled job. */
describe('analysis model', () => {
  let t: TestApp;
  let tenant: { id: string; slug: string };
  let project: string;
  const interview = uuidv7();
  const response = uuidv7();

  beforeAll(async () => {
    t = await bootstrap();
    tenant = await createTenant(t.admin);
    project = await createProject(t.admin, tenant.id);
    const qid = await createQuestionnaire(t.admin, tenant.id, project, { publish: true });
    const [v] =
      await t.admin`select id from questionnaire_versions where questionnaire_id = ${qid}`;
    const caseId = uuidv7();
    await t.admin`insert into cases (id, tenant_id, project_id, questionnaire_id, external_id, status)
      values (${caseId}, ${tenant.id}, ${project}, ${qid}, 'BI001', 'finalised')`;
    await t.admin`insert into interviews (id, tenant_id, project_id, case_id, questionnaire_version_id,
        mode, status, disposition, language, device_id, answers, submitted_at)
      values (${interview}, ${tenant.id}, ${project}, ${caseId}, ${v!.id}, 'CAPI', 'submitted',
        'COMPLETE', 'es', 'd1', ${t.admin.json({ A1_CONSENT: 1, A2_AGE: -8, A3_SEX: 2 })}, now())`;
    const point = uuidv7();
    await t.admin`insert into feedback_points (id, tenant_id, project_id, name, question, faces, slug, items)
      values (${point}, ${tenant.id}, ${project}, 'Mostrador', ${t.admin.json({ es: '¿Cómo lo atendimos?' })},
        5, ${unique('fb')}, ${t.admin.json([
          {
            id: 'SEDE',
            type: 'single',
            text: { es: '¿Sede?' },
            options: [{ code: 1, label: { es: 'Centro' } }],
          },
        ])})`;
    await t.admin`insert into feedback_responses (id, tenant_id, point_id, score, channel, comment, answers)
      values (${response}, ${tenant.id}, ${point}, 4, 'link', 'Rápido', ${t.admin.json({ SEDE: 1 })})`;
  });
  afterAll(() => t.close());

  it('is filled by the job, labels the codes, and keeps special codes out of the numbers', async () => {
    // Twice: the first fills the empty views, the next refreshes them without blocking readers.
    await t.app.get(JobsService).run('bi.refresh', {});
    await t.app.get(JobsService).run('bi.refresh', {});
    const rows = await t.admin`
      select envio_id::text, instrumento_tipo, canal, variable, codigo, respuesta,
             respuesta_especial, valor_numero::float as valor_numero, caso_codigo, completa
      from bi.plano_respuestas where envio_id in (${interview}, ${response})`;
    const by = (v: string) => rows.find((r) => r.variable === v)!;
    expect(by('A1_CONSENT')).toMatchObject({ respuesta: 'Sí', instrumento_tipo: 'cuestionario' });
    expect(by('A2_AGE')).toMatchObject({
      codigo: '-8',
      respuesta: 'No sabe',
      respuesta_especial: true,
      valor_numero: null,
    });
    expect(by('A3_SEX')).toMatchObject({ respuesta: 'Mujer', caso_codigo: 'BI001', completa: 1 });
    expect(by('_CARA')).toMatchObject({ respuesta: 'Bien', valor_numero: 4, canal: 'link' });
    expect(by('SEDE')).toMatchObject({ respuesta: 'Centro', instrumento_tipo: 'valoracion' });
    expect(by('_COMENTARIO')).toMatchObject({ respuesta: 'Rápido' });

    // The snowflake joins on single keys and finds every answer's question.
    const [orphans] = await t.admin`
      select count(*)::int as n from bi.fact_respuesta r
      left join bi.dim_pregunta p using (pregunta_id)
      where r.envio_id in (${interview}, ${response}) and p.pregunta_id is null`;
    expect(orphans!.n).toBe(0);
    const [envios] = await t.admin`
      select count(*)::int as n from bi.fact_envio e
      join bi.dim_proyecto p using (proyecto_id)
      join bi.dim_organizacion o using (organizacion_id)
      where o.organizacion_id = ${tenant.id}`;
    expect(envios!.n).toBe(2);
  });

  it('spans every organisation, so the application role may refresh it but not read it', async () => {
    const app = t.app.get(Database).client;
    await expect(app`select count(*) from bi.plano_respuestas`).rejects.toThrow(/permission/);
    await expect(app`select count(*) from bi.dim_organizacion`).rejects.toThrow(/permission/);
  });
});
