import { pathToFileURL } from 'node:url';
import { type CompiledQuestionnaire } from '@wansurvey/logic';
import postgres from 'postgres';
import { uuidv7 } from 'uuidv7';
import { hashPassword } from '../auth/auth.service.js';
import { PiiCipher } from '../cases/pii.js';
import { simulateInterview } from './simulate.js';

const MODES = ['CAPI', 'CATI', 'CAWI', 'PAPI'] as const;
const TEAM = ['Rosa Quispe', 'Jorge Mamani', 'Lucía Flores', 'Carlos Huamán'];
const LOST = ['REFUSAL', 'NON_CONTACT', 'NO_ANSWER', 'REFUSAL', 'WRONG_NUMBER', 'BREAK_OFF'];

/**
 * Demo fieldwork for the "demo" organisation (dashboards, metrics, results, exports): a team of
 * interviewers, `count` simulated interviews over the last two weeks in all four modes on extra
 * cases (the 50 seed cases are left alone), calls and lost cases for the AAPOR rates, and the
 * daily figures. Idempotent: does nothing if the demo cases exist.
 */
export async function seedDemoData(adminUrl: string, password: string, count = 60): Promise<void> {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const [p] = await sql<{ id: string; tenant_id: string; timezone: string }[]>`
      select p.id, p.tenant_id, p.timezone from projects p join tenants t on t.id = p.tenant_id
      where t.slug = 'demo' and p.code = 'HH2026'`;
    if (!p) throw new Error('Run the seed first');
    const [done] =
      await sql`select 1 from cases where project_id = ${p.id} and external_id = 'D001'`;
    if (done) return;
    const [v] = await sql<
      { id: string; questionnaire_id: string; compiled: CompiledQuestionnaire }[]
    >`
      select v.id, v.questionnaire_id, v.compiled from questionnaire_versions v
      join questionnaires q on q.id = v.questionnaire_id
      where q.project_id = ${p.id} order by v.version desc limit 1`;
    const hash = await hashPassword(password);
    await sql.begin(async (tx) => {
      const [main] = await tx<{ id: string }[]>`
        select id from users where email = 'interviewer@demo.wansurvey.test'`;
      const team = [main!.id];
      for (const [i, name] of TEAM.entries()) {
        const id = uuidv7();
        await tx`insert into users (id, email, name, first_name, status, password_hash)
                 values (${id}, ${`interviewer${i + 2}@demo.wansurvey.test`}, ${name}, ${name.split(' ')[0]!}, 'active', ${hash})`;
        await tx`insert into tenant_members (id, tenant_id, user_id, status) values (${uuidv7()}, ${p.tenant_id}, ${id}, 'active')`;
        await tx`insert into memberships (id, tenant_id, user_id, role, project_id) values (${uuidv7()}, ${p.tenant_id}, ${id}, 'interviewer', ${p.id})`;
        team.push(id);
      }
      // Personal fields sealed as the API would (H1) when the key is at hand.
      const piiRows = await tx<{ name: string }[]>`
        select name from sample_fields where project_id = ${p.id} and pii`;
      const pii = new Set(piiRows.map((r) => r.name));
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
        // Lost cases go to the rest of the team, so the main demo interviewer's own lists
        // (used by the walkthroughs and tests) only gain finished cases.
        const interviewer = lost
          ? team[1 + (n % (team.length - 1))]!
          : mode === 'CAWI'
            ? null
            : team[n % team.length]!;
        const at = new Date(start + (n / (count + 12)) * 14 * day + (n % 5) * 3_600_000);
        const finalLost = lost && !['NO_ANSWER'].includes(lost);
        const sealed = seal({
          first_name: 'Demo',
          last_name: external,
          region: 9,
          city: 'Lima',
          age: 30 + (n % 40),
        });
        await tx`insert into cases (id, tenant_id, project_id, questionnaire_id, external_id, sample, sample_pii, sample_pii_index, status, disposition, assigned_to, attempts, last_attempt_at)
                 values (${caseId}, ${p.tenant_id}, ${p.id}, ${v!.questionnaire_id}, ${external}, ${tx.json(sealed.sample as never)},
                         ${sealed.samplePii}, ${sealed.samplePiiIndex},
                         ${lost ? (finalLost ? 'finalised' : 'assigned') : 'finalised'}, ${lost ?? 'COMPLETE'},
                         ${interviewer}, ${mode === 'CATI' || lost ? 1 + (n % 3) : 0}, ${at})`;
        if (mode === 'CATI' || lost) {
          const caller = interviewer ?? team[1]!;
          for (let a = 0; a < 1 + (n % 3); a++) {
            const last = a === n % 3;
            await tx`insert into call_attempts (id, tenant_id, project_id, case_id, interviewer_id, number_masked, started_at, ended_at, outcome, disposition)
                     values (${uuidv7()}, ${p.tenant_id}, ${p.id}, ${caseId}, ${caller}, '…42',
                             ${new Date(at.getTime() - (3 - a) * 3_600_000)}, ${new Date(at.getTime() - (3 - a) * 3_600_000 + 60_000)},
                             ${last ? (lost === 'REFUSAL' ? 'refusal' : lost ? 'no_answer' : 'answered') : 'no_answer'},
                             ${last ? (lost ?? 'COMPLETE') : 'NO_ANSWER'})`;
          }
        }
        if (lost) continue;
        const s = simulateInterview(v!.compiled, {
          mode,
          seed: external,
          caseData: { first_name: 'Demo', city: 'Lima', region: 9 },
          now: at,
        });
        // Interviewer 5 is quick: short interviews stand out in the team metrics.
        const minutes = interviewer === team[4] ? 4 + (n % 3) : 12 + ((n * 7) % 15);
        const status = n % 4 === 0 ? 'approved' : 'submitted';
        await tx`insert into interviews (id, tenant_id, project_id, case_id, questionnaire_version_id, mode, interviewer_id,
                   status, disposition, language, state, answers, device_id, started_at, ended_at, submitted_at, submissions,
                   active_ms, total_ms, flags, sampled, updated_at)
                 values (${uuidv7()}, ${p.tenant_id}, ${p.id}, ${caseId}, ${v!.id}, ${mode}, ${interviewer},
                   ${status}, ${s.status().disposition}, 'es', ${tx.json(s.state() as never)}, ${tx.json(s.getAnswers() as never)},
                   ${'demo-' + mode.toLowerCase()}, ${new Date(at.getTime() - minutes * 60_000)}, ${at}, ${at}, 1,
                   ${minutes * 60_000}, ${(minutes + 2) * 60_000},
                   ${tx.json(interviewer === team[4] ? { speeding: { msPerQuestion: 900 } } : {})}, ${n % 10 === 0}, ${at})`;
      }
      // Daily figures, as the stats job computes them (StatsService.refresh).
      await tx`
        insert into stats_daily (tenant_id, project_id, day, mode, interviewer_id, submitted, completes, approved, rejected, active_ms)
        select ${p.tenant_id}, ${p.id}, (i.submitted_at at time zone ${p.timezone})::date, i.mode, i.interviewer_id,
               count(*) filter (where i.status <> 'returned'),
               count(*) filter (where i.status in ('submitted', 'in_review', 'approved') and i.disposition = 'COMPLETE'),
               count(*) filter (where i.status = 'approved'),
               count(*) filter (where i.status = 'rejected'),
               coalesce(sum(i.active_ms) filter (where i.status in ('submitted', 'in_review', 'approved') and i.disposition = 'COMPLETE'), 0)
        from interviews i
        where i.project_id = ${p.id} and i.submitted_at is not null and i.entry_pass = 1
        group by 3, 4, 5
        on conflict do nothing`;
      await tx`update projects set settings = jsonb_set(settings, '{fieldwork}', ${tx.json({ targetCompletes: 120 })})
               where id = ${p.id}`;
    });
    console.log(`Seeded ${count} demo interviews in Household Survey 2026.`);
  } finally {
    await sql.end({ timeout: 5 });
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
