import { pathToFileURL } from 'node:url';
import { type CompiledQuestionnaire } from '@wansurvey/logic';
import { sql, type Transaction } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { hashPassword } from '../auth/auth.service.js';
import { PiiCipher } from '../cases/pii.js';
import { localDay } from '../stats/zoned-day.js';
import { createMssqlDb } from './mssql/connection.js';
import { simulateInterview } from './simulate.js';

type Tx = Transaction<Record<string, never>>;

const MODES = ['CAPI', 'CATI', 'CAWI', 'PAPI'] as const;
const TEAM = ['Rosa Quispe', 'Jorge Mamani', 'Lucía Flores', 'Carlos Huamán'];
const LOST = ['REFUSAL', 'NON_CONTACT', 'NO_ANSWER', 'REFUSAL', 'WRONG_NUMBER', 'BREAK_OFF'];

const at = (d: Date) => sql`CAST(${d.toISOString()} AS datetimeoffset(3))`;

/**
 * Demo fieldwork for the "demo" organisation (dashboards, metrics, results, exports): a team of
 * interviewers, `count` simulated interviews over the last two weeks in all four modes on extra
 * cases (the 50 seed cases are left alone), calls and lost cases for the AAPOR rates, and the
 * daily figures. Idempotent: does nothing if the demo cases exist.
 */
export async function seedDemoData(adminUrl: string, password: string, count = 60): Promise<void> {
  const db = createMssqlDb<Record<string, never>>(adminUrl, { max: 1, requestTimeoutMs: 0 });
  try {
    const p = (
      await sql<{ id: string; tenant_id: string; timezone: string }>`
        SELECT p.id, p.tenant_id, p.timezone FROM projects p JOIN tenants t ON t.id = p.tenant_id
        WHERE t.slug = 'demo' AND p.code = 'HH2026'`.execute(db)
    ).rows[0];
    if (!p) throw new Error('Run the seed first');
    const done =
      await sql`SELECT 1 AS x FROM cases WHERE project_id = ${p.id} AND external_id = 'D001'`.execute(
        db,
      );
    if (done.rows.length) return;
    const v = (
      await sql<{ id: string; questionnaire_id: string; compiled: string }>`
        SELECT TOP 1 v.id, v.questionnaire_id, v.compiled FROM questionnaire_versions v
        JOIN questionnaires q ON q.id = v.questionnaire_id
        WHERE q.project_id = ${p.id} ORDER BY v.version DESC`.execute(db)
    ).rows[0]!;
    const compiled = JSON.parse(v.compiled) as CompiledQuestionnaire;
    const hash = await hashPassword(password);
    // The daily figures, as the stats job computes them: per local day, mode and interviewer.
    const daily = new Map<
      string,
      {
        day: string;
        mode: string;
        interviewer: string | null;
        submitted: number;
        completes: number;
        approved: number;
        activeMs: number;
      }
    >();
    await db.transaction().execute(async (tx: Tx) => {
      const run = async (q: ReturnType<typeof sql>) => void (await q.execute(tx));
      const main = (
        await sql<{
          id: string;
        }>`SELECT id FROM users WHERE email = 'interviewer@demo.wansurvey.test'`.execute(tx)
      ).rows[0]!;
      const team = [main.id];
      for (const [i, name] of TEAM.entries()) {
        const id = uuidv7();
        await run(sql`INSERT INTO users (id, email, name, first_name, status, password_hash)
                      VALUES (${id}, ${`interviewer${i + 2}@demo.wansurvey.test`}, ${name}, ${name.split(' ')[0]!}, 'active', ${hash})`);
        await run(
          sql`INSERT INTO tenant_members (id, tenant_id, user_id, status) VALUES (${uuidv7()}, ${p.tenant_id}, ${id}, 'active')`,
        );
        await run(
          sql`INSERT INTO memberships (id, tenant_id, user_id, role, project_id) VALUES (${uuidv7()}, ${p.tenant_id}, ${id}, 'interviewer', ${p.id})`,
        );
        team.push(id);
      }
      const piiRows = await sql<{ name: string }>`
        SELECT name FROM sample_fields WHERE project_id = ${p.id} AND pii = 1`.execute(tx);
      const pii = new Set(piiRows.rows.map((r) => r.name));
      const cipher = process.env.APP_ENCRYPTION_KEY
        ? new PiiCipher(process.env.APP_ENCRYPTION_KEY)
        : null;
      const seal = (sample: Record<string, unknown>) =>
        cipher ? cipher.seal(sample, pii) : { sample, samplePii: null, samplePiiIndex: null };
      const day = 86_400_000;
      const start = Date.now() - 14 * day;
      for (let n = 0; n < count + LOST.length * 2; n++) {
        const caseId = uuidv7();
        const external = `D${String(n + 1).padStart(3, '0')}`;
        const mode = MODES[n % 7 < 3 ? 0 : n % 7 < 5 ? 1 : n % 7 < 6 ? 2 : 3]!;
        const lost = n >= count ? LOST[n % LOST.length]! : null;
        const interviewer = lost
          ? team[1 + (n % (team.length - 1))]!
          : mode === 'CAWI'
            ? null
            : team[n % team.length]!;
        const when = new Date(start + (n / (count + 12)) * 14 * day + (n % 5) * 3_600_000);
        const finalLost = lost && !['NO_ANSWER'].includes(lost);
        const sealed = seal({
          first_name: 'Demo',
          last_name: external,
          region: 9,
          city: 'Lima',
          age: 30 + (n % 40),
        });
        await run(sql`INSERT INTO cases (id, tenant_id, project_id, questionnaire_id, external_id, sample, sample_pii, sample_pii_index, status, disposition, assigned_to, assigned_at, attempts, last_attempt_at)
                      VALUES (${caseId}, ${p.tenant_id}, ${p.id}, ${v.questionnaire_id}, ${external}, ${JSON.stringify(sealed.sample)},
                              ${sealed.samplePii}, ${sealed.samplePiiIndex ? JSON.stringify(sealed.samplePiiIndex) : null},
                              ${lost ? (finalLost ? 'finalised' : 'assigned') : 'finalised'}, ${lost ?? 'COMPLETE'},
                              ${interviewer}, ${interviewer ? at(when) : null}, ${mode === 'CATI' || lost ? 1 + (n % 3) : 0}, ${at(when)})`);
        if (mode === 'CATI' || lost) {
          const caller = interviewer ?? team[1]!;
          for (let a = 0; a < 1 + (n % 3); a++) {
            const last = a === n % 3;
            const from = new Date(when.getTime() - (3 - a) * 3_600_000);
            await run(sql`INSERT INTO call_attempts (id, tenant_id, project_id, case_id, interviewer_id, number_masked, started_at, ended_at, outcome, disposition)
                          VALUES (${uuidv7()}, ${p.tenant_id}, ${p.id}, ${caseId}, ${caller}, '…42',
                                  ${at(from)}, ${at(new Date(from.getTime() + 60_000))},
                                  ${last ? (lost === 'REFUSAL' ? 'refusal' : lost ? 'no_answer' : 'answered') : 'no_answer'},
                                  ${last ? (lost ?? 'COMPLETE') : 'NO_ANSWER'})`);
          }
        }
        if (lost) continue;
        const s = simulateInterview(compiled, {
          mode,
          seed: external,
          caseData: { first_name: 'Demo', city: 'Lima', region: 9 },
          now: when,
        });
        const minutes = interviewer === team[4] ? 4 + (n % 3) : 12 + ((n * 7) % 15);
        const status = n % 4 === 0 ? 'approved' : 'submitted';
        const disposition = s.status().disposition;
        await run(sql`INSERT INTO interviews (id, tenant_id, project_id, case_id, questionnaire_version_id, mode, interviewer_id,
                        status, disposition, language, state, answers, device_id, started_at, ended_at, submitted_at, submissions,
                        active_ms, total_ms, flags, sampled, updated_at)
                      VALUES (${uuidv7()}, ${p.tenant_id}, ${p.id}, ${caseId}, ${v.id}, ${mode}, ${interviewer},
                        ${status}, ${disposition}, 'es', ${JSON.stringify(s.state())}, ${JSON.stringify(s.getAnswers())},
                        ${'demo-' + mode.toLowerCase()}, ${at(new Date(when.getTime() - minutes * 60_000))}, ${at(when)}, ${at(when)}, 1,
                        ${minutes * 60_000}, ${(minutes + 2) * 60_000},
                        ${JSON.stringify(interviewer === team[4] ? { speeding: { msPerQuestion: 900 } } : {})}, ${n % 10 === 0 ? 1 : 0}, ${at(when)})`);
        const d = localDay(when, p.timezone);
        const k = `${d}|${mode}|${interviewer}`;
        const row = daily.get(k) ?? {
          day: d,
          mode,
          interviewer,
          submitted: 0,
          completes: 0,
          approved: 0,
          activeMs: 0,
        };
        row.submitted += 1;
        if (disposition === 'COMPLETE') {
          row.completes += 1;
          row.activeMs += minutes * 60_000;
        }
        if (status === 'approved') row.approved += 1;
        daily.set(k, row);
      }
      for (const r of daily.values())
        await run(sql`INSERT INTO stats_daily (tenant_id, project_id, day, mode, interviewer_id, submitted, completes, approved, rejected, active_ms)
                      VALUES (${p.tenant_id}, ${p.id}, ${r.day}, ${r.mode}, ${r.interviewer}, ${r.submitted}, ${r.completes}, ${r.approved}, 0, ${r.activeMs})`);
      await run(sql`UPDATE projects SET settings = JSON_MODIFY(settings, '$.fieldwork', JSON_QUERY(${JSON.stringify({ targetCompletes: 120 })}))
                    WHERE id = ${p.id}`);
    });
    console.log(`Seeded ${count} demo interviews in Household Survey 2026.`);
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const admin = process.env.DATABASE_ADMIN_URL;
  if (!admin) {
    console.error('DATABASE_ADMIN_URL is required');
    process.exit(1);
  }
  seedDemoData(
    admin,
    process.env.SEED_PASSWORD ?? 'demo-password-123',
    Number(process.env.SEED_INTERVIEWS ?? 60),
  ).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
