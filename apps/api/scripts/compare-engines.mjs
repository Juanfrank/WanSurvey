#!/usr/bin/env node
/* global process, console, fetch, Buffer, setTimeout */
// Calls the same read endpoints of two running APIs (one on PostgreSQL, one on SQL Server, over the
// same data) as the same person, and reports where the answers differ.
//   node scripts/compare-engines.mjs http://localhost:3101 http://localhost:3100 [email] [password] [org]
const [
  a,
  b,
  email = 'project.manager@demo.wansurvey.test',
  password = 'demo-password-123',
  org = 'demo',
] = process.argv.slice(2);
if (!a || !b) {
  console.error('usage: compare-engines.mjs <url-a> <url-b> [email] [password] [org]');
  process.exit(2);
}

async function session(base) {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, tenant: org }),
  });
  if (!res.ok) throw new Error(`login at ${base}: ${res.status} ${await res.text()}`);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const csrf = (await res.json()).csrfToken;
  return {
    base,
    post: async (path, body = {}) => {
      const r = await fetch(`${base}/api/v1${path}`, {
        method: 'POST',
        headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      let out = null;
      try {
        out = await r.json();
      } catch {
        /* no body */
      }
      return { status: r.status, body: out };
    },
    file: async (path) => {
      const r = await fetch(`${base}/api/v1${path}`, { headers: { cookie } });
      return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) };
    },
    get: async (path) => {
      const r = await fetch(`${base}/api/v1${path}`, { headers: { cookie } });
      let body = null;
      try {
        body = await r.json();
      } catch {
        /* no body */
      }
      return { status: r.status, body };
    },
  };
}

// `createdAt` of an export is the moment this script asked for it, on each API.
const VOLATILE = new Set([
  'csrfToken',
  'generatedAt',
  'serverTime',
  'now',
  'requestId',
  'at',
  'createdAt',
  'startedAt',
  'finishedAt',
]);
const canon = (v) =>
  typeof v === 'number'
    ? Math.round(v * 100) / 100
    : Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .filter((k) => !VOLATILE.has(k))
              .sort()
              .map((k) => [k, canon(v[k])]),
          )
        : typeof v === 'string'
          ? v.replace(
              /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z$/,
              (_m, s, f) => `${s}${(f ?? '.000').padEnd(4, '0').slice(0, 4)}Z`,
            )
          : v;
const sortDeep = (v) =>
  Array.isArray(v)
    ? v.map(sortDeep).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sortDeep(x)]))
      : v;

function firstDiff(x, y, path = '') {
  if (JSON.stringify(x) === JSON.stringify(y)) return null;
  if (
    x &&
    y &&
    typeof x === 'object' &&
    typeof y === 'object' &&
    Array.isArray(x) === Array.isArray(y)
  ) {
    const keys = Array.isArray(x)
      ? [...Array(Math.max(x.length, y.length)).keys()]
      : [...new Set([...Object.keys(x), ...Object.keys(y)])];
    for (const k of keys) {
      const d = firstDiff(x[k], y[k], `${path}${Array.isArray(x) ? `[${k}]` : '.' + k}`);
      if (d) return d;
    }
  }
  return `${path}: ${JSON.stringify(x)?.slice(0, 90)}  vs  ${JSON.stringify(y)?.slice(0, 90)}`;
}

const A = await session(a);
const B = await session(b);
const paths = [
  '/auth/me',
  '/auth/tenants',
  '/tenant',
  '/tenant/roles',
  '/projects',
  '/users',
  '/teams',
  '/audit',
  '/data/questionnaires',
];
const projects = (await A.get('/projects')).body ?? [];
for (const p of projects) {
  for (const s of [
    '',
    '/cases',
    '/cases?limit=200',
    '/cases-map',
    '/questionnaires',
    '/assignments',
    '/assignees',
    '/sample-fields',
    '/live/snapshot',
    '/metrics/interviewers',
    '/waves',
    '/email-templates',
    '/share-links',
    '/presence',
    '/mismatches',
    '/open-link',
    '/forms',
    '/summary',
    '/topline',
    '/people',
    '/goals',
  ])
    paths.push(`/projects/${p.id}${s}`);
  const qs = (await A.get(`/projects/${p.id}/questionnaires`)).body ?? [];
  for (const q of Array.isArray(qs) ? qs : [])
    for (const s of ['', '/versions', '/scenarios', '/comments'])
      paths.push(`/projects/${p.id}/questionnaires/${q.id}${s}`);
}
for (const p of projects) {
  const list = (await A.get(`/projects/${p.id}/cases?limit=200`)).body;
  const cases = list?.rows ?? [];
  for (const c of cases.slice(0, 8)) paths.push(`/projects/${p.id}/cases/${c.id}?reveal=pii`);
}
let same = 0,
  skipped = 0;
const problems = [];
for (const path of paths) {
  const [x, y] = await Promise.all([A.get(path), B.get(path)]);
  if (x.status === 404 && y.status === 404) {
    skipped++;
    continue;
  }
  if (x.status !== y.status) {
    problems.push(`${path}: status ${x.status} vs ${y.status}`);
    continue;
  }
  const cx = canon(x.body),
    cy = canon(y.body);
  if (JSON.stringify(cx) === JSON.stringify(cy)) {
    same++;
    continue;
  }
  if (JSON.stringify(sortDeep(cx)) === JSON.stringify(sortDeep(cy))) {
    problems.push(`${path}: same content, different order`);
    continue;
  }
  problems.push(`${path}: ${firstDiff(cx, cy)}`);
}
// Exports built by each API from its own database: the files must be the same.
const exportProblems = [];
let exportsChecked = 0;
const stripVolatile = (buf) =>
  buf
    .toString('utf8')
    .split('\n')
    .filter((l) => !/Generado el|Generated/.test(l))
    .join('\n');
for (const p of projects) {
  const qs = (await A.get(`/projects/${p.id}/questionnaires`)).body;
  for (const q of (Array.isArray(qs) ? qs : []).slice(0, 2))
    for (const format of ['csv']) {
      // the SQL script is written in each engine's dialect: not comparable
      const [ex, ey] = await Promise.all([
        A.post(`/projects/${p.id}/exports`, { questionnaireId: q.id, format }),
        B.post(`/projects/${p.id}/exports`, { questionnaireId: q.id, format }),
      ]);
      if (ex.status !== 201 || ey.status !== 201) {
        exportProblems.push(`${p.id} ${format}: create ${ex.status} vs ${ey.status}`);
        continue;
      }
      const wait = async (S, id) => {
        for (let i = 0; i < 40; i++) {
          const l = (await S.get(`/projects/${p.id}/exports`)).body;
          const e = l.find((x) => x.id === id);
          if (e && ['done', 'failed'].includes(e.status)) return e.status;
          await new Promise((r) => setTimeout(r, 500));
        }
        return 'timeout';
      };
      const [sx, sy] = await Promise.all([wait(A, ex.body.id), wait(B, ey.body.id)]);
      if (sx !== 'done' || sy !== 'done') {
        exportProblems.push(`${p.id} ${format}: status ${sx} vs ${sy}`);
        continue;
      }
      const [fx, fy] = await Promise.all([
        A.file(`/projects/${p.id}/exports/${ex.body.id}/file`),
        B.file(`/projects/${p.id}/exports/${ey.body.id}/file`),
      ]);
      exportsChecked++;
      if (stripVolatile(fx.bytes) !== stripVolatile(fy.bytes))
        exportProblems.push(
          `${p.id} ${format}: the files differ (${fx.bytes.length} vs ${fy.bytes.length} bytes)`,
        );
    }
}
problems.push(...exportProblems);
console.log(`${exportsChecked} exports built by both APIs and compared.`);
console.log(
  `${paths.filter((p) => p.includes('reveal=pii')).length} case reads with personal data revealed.`,
);
console.log(
  `${paths.length} requests: ${same} identical, ${skipped} not found on both, ${problems.length} differ.`,
);
for (const p of problems) console.log(`  ${p}`);
process.exit(problems.some((p) => !p.endsWith('different order')) ? 1 : 0);
