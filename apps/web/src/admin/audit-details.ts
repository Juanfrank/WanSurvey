import { ROLE_PERMISSIONS } from '@wansurvey/schema';
import { permKey } from './permissions.js';

/** One line of an entry's details: what it is and its value, both in words. */
export interface DetailRow {
  label: string;
  value: string;
}

export interface DescribeContext {
  t: (key: string, opts?: { defaultValue?: string }) => string;
  /** The name of a person, project or team by id, when known. */
  name: (id: string) => string | undefined;
  date: (d: Date) => string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const WORD = /^[a-z][a-z_]*$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** An action's name in words (`auth.login` → "Signed in"), or its code when it has none. */
export function actionLabel(t: DescribeContext['t'], action: string): string {
  return t(`admin.log.actions.${action}`, { defaultValue: action });
}

/** A field's name in words, or the field itself. */
const fieldLabel = (t: DescribeContext['t'], key: string) =>
  t(`admin.log.fields.${key}`, { defaultValue: key });

const roleLabel = (t: DescribeContext['t'], role: string) =>
  WORD.test(role) ? t(`team.roleNames.${role}`, { defaultValue: role }) : role;

/** A recorded value in words: names for ids, dates, yes/no, known codes. */
export function formatValue(v: unknown, c: DescribeContext, key?: string): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return c.t(v ? 'admin.log.yes' : 'admin.log.no');
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    if (UUID.test(v)) return c.name(v.toLowerCase()) ?? v.slice(0, 8);
    if (ISO.test(v) && !Number.isNaN(Date.parse(v))) return c.date(new Date(v));
    if (key === 'role' || key === 'roles') return roleLabel(c.t, v);
    if (key === 'action' || key === 'actions') return actionLabel(c.t, v);
    // What a role opened to an external client: permission codes, in words.
    if (key === 'opens') return c.t(permKey(v), { defaultValue: v });
    if (WORD.test(v)) return c.t(`admin.log.values.${v}`, { defaultValue: v });
    return v;
  }
  if (Array.isArray(v)) return v.length ? v.map((x) => formatValue(x, c, key)).join(', ') : '—';
  if (isObject(v)) {
    const entries = Object.entries(v);
    if (!entries.length) return '—';
    return entries
      .map(([k, x]) =>
        UUID.test(k)
          ? `${formatValue(k, c)}: ${formatValue(x, c)}`
          : `${fieldLabel(c.t, k)}: ${formatValue(x, c, k)}`,
      )
      .join('; ');
  }
  return JSON.stringify(v);
}

/** Permissions added and taken away, role by role, from two sets of role changes. */
function rolesDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  c: DescribeContext,
): DetailRow[] {
  // Only changes from the defaults are stored: a role left out has its default permissions.
  const effective = (o: Record<string, unknown>, role: string): string[] =>
    Array.isArray(o[role])
      ? (o[role] as string[])
      : [...((ROLE_PERMISSIONS as Record<string, readonly string[]>)[role] ?? [])];
  const perm = (p: string) => c.t(permKey(p), { defaultValue: p });
  const rows: DetailRow[] = [];
  for (const role of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = new Set(effective(before, role));
    const now = new Set(effective(after, role));
    const added = [...now].filter((p) => !was.has(p));
    const removed = [...was].filter((p) => !now.has(p));
    if (!added.length && !removed.length) continue;
    rows.push({
      label: roleLabel(c.t, role),
      value: [...added.map((p) => `+ ${perm(p)}`), ...removed.map((p) => `− ${perm(p)}`)].join(
        ', ',
      ),
    });
  }
  return rows.length
    ? rows
    : [{ label: fieldLabel(c.t, 'change'), value: c.t('admin.log.noChange') }];
}

/**
 * An entry's details as lines a person can read: a change shown as "before → after" field by
 * field (permissions added and removed for role changes), every other field in words.
 */
export function describeDetails(
  action: string,
  details: Record<string, unknown> | null | undefined,
  c: DescribeContext,
): DetailRow[] {
  const d = details ?? {};
  const rows: DetailRow[] = [];
  const skip = new Set<string>();
  const arrow = (a: unknown, b: unknown, key?: string) =>
    `${formatValue(a, c, key)} → ${formatValue(b, c, key)}`;

  if ('before' in d && 'after' in d) {
    skip.add('before').add('after');
    const { before, after } = d;
    if (action === 'tenant.roles_updated' && isObject(before) && isObject(after))
      rows.push(...rolesDiff(before, after, c));
    else if (isObject(before) && isObject(after)) {
      for (const k of new Set([...Object.keys(before), ...Object.keys(after)]))
        if (JSON.stringify(before[k]) !== JSON.stringify(after[k]))
          rows.push({ label: fieldLabel(c.t, k), value: arrow(before[k], after[k], k) });
      if (!rows.length)
        rows.push({ label: fieldLabel(c.t, 'change'), value: c.t('admin.log.noChange') });
    } else
      rows.push({
        label: fieldLabel(c.t, action.startsWith('user.role') ? 'role' : 'change'),
        value: arrow(before, after, action.includes('role') ? 'role' : undefined),
      });
  }
  // A review decision: the interview's status, from and to.
  if (action.startsWith('interview.') && typeof d.from === 'string' && typeof d.to === 'string') {
    skip.add('from').add('to');
    rows.push({ label: fieldLabel(c.t, 'status'), value: arrow(d.from, d.to) });
  }
  for (const [k, v] of Object.entries(d)) {
    if (skip.has(k)) continue;
    rows.push({ label: fieldLabel(c.t, k), value: formatValue(v, c, k) });
  }
  return rows;
}
