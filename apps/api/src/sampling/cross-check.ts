import type { CrossCheck } from '@wansurvey/schema/sampling';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/database.js';
import { cases, contacts } from '../db/schema.js';
import { words, type PiiCipher } from '../cases/pii.js';
import { chunks } from '../cases/cases.service.js';

/** A unit or row to check: its sample (personal fields in clear) and its contacts. */
export interface Candidate {
  sample: Record<string, unknown>;
  contacts: { type: string; value: string }[];
}

const CONTACT_FIELDS = new Set(['phone', 'email']);
const norm = (v: unknown) => words(v).join(' ');
const key = (a: string, b: string) => `${a}\u0000${b}`;
const intersect = (a: Set<string> | undefined, b: Set<string>): Set<string> =>
  a ? new Set([...a].filter((id) => b.has(id))) : new Set(b);

/** People who had one of the rule's results recently, indexed by what identifies them. */
class Recent {
  readonly byToken = new Map<string, Set<string>>();
  readonly byField = new Map<string, Set<string>>();
  readonly byContact = new Map<string, Set<string>>();

  private add(map: Map<string, Set<string>>, k: string, id: string) {
    const s = map.get(k) ?? new Set<string>();
    s.add(id);
    map.set(k, s);
  }

  constructor(
    rows: { id: string; sample: unknown; samplePiiIndex: string[] | null }[],
    cs: { caseId: string; type: string; value: string }[],
  ) {
    for (const r of rows) {
      for (const tk of r.samplePiiIndex ?? []) this.add(this.byToken, tk, r.id);
      for (const [f, v] of Object.entries((r.sample ?? {}) as Record<string, unknown>)) {
        const n = norm(v);
        if (n) this.add(this.byField, key(f, n), r.id);
      }
    }
    for (const c of cs) this.add(this.byContact, key(c.type, c.value.toLowerCase()), c.caseId);
  }
}

/**
 * Cross-case checks of a sampling plan (S1): a unit is not eligible when the same person had a
 * listed result within the window, in the project or the whole organisation. Personal fields
 * are compared through their keyed word hashes, never in clear; contacts by exact value.
 */
export class CrossChecker {
  private constructor(
    private readonly rules: { rule: CrossCheck; recent: Recent }[],
    private readonly pii: PiiCipher,
  ) {}

  static async load(
    tx: Tx,
    pii: PiiCipher,
    projectId: string,
    rules: CrossCheck[],
    now = new Date(),
  ): Promise<CrossChecker | null> {
    if (!rules.length) return null;
    const loaded = [];
    for (const rule of rules) {
      const since = new Date(now.getTime() - rule.withinDays * 86_400_000).toISOString();
      const results = sql.raw(
        `array[${rule.results.map((r) => `'${r.replace(/[^A-Z_]/g, '')}'`).join(',')}]::text[]`,
      );
      const rows = await tx
        .select({ id: cases.id, sample: cases.sample, samplePiiIndex: cases.samplePiiIndex })
        .from(cases)
        .where(
          and(
            rule.scope === 'project' ? eq(cases.projectId, projectId) : undefined,
            sql`(exists (select 1 from interviews i where i.case_id = ${cases.id}
                  and i.disposition = any(${results})
                  and i.status not in ('in_progress', 'rejected')
                  and i.submitted_at >= ${since}::timestamptz)
                or (${cases.status} = 'finalised' and ${cases.disposition} = any(${results})
                  and ${cases.updatedAt} >= ${since}::timestamptz))`,
          ),
        );
      const cs: { caseId: string; type: string; value: string }[] = [];
      if (rule.fields.some((f) => CONTACT_FIELDS.has(f)))
        for (const part of chunks(rows.map((r) => r.id)))
          if (part.length)
            cs.push(
              ...(await tx
                .select({ caseId: contacts.caseId, type: contacts.type, value: contacts.value })
                .from(contacts)
                .where(inArray(contacts.caseId, part))),
            );
      loaded.push({ rule, recent: new Recent(rows, cs) });
    }
    return new CrossChecker(loaded, pii);
  }

  /** The cases one field of the candidate points to (empty when it has no value). */
  private matches(recent: Recent, field: string, c: Candidate): Set<string> {
    if (CONTACT_FIELDS.has(field)) {
      const out = new Set<string>();
      for (const ct of c.contacts)
        if (ct.type === field)
          for (const id of recent.byContact.get(key(field, ct.value.toLowerCase())) ?? [])
            out.add(id);
      return out;
    }
    const value = c.sample[field];
    const n = norm(value);
    if (!n) return new Set();
    const out = new Set(recent.byField.get(key(field, n)) ?? []);
    // Personal fields elsewhere: every word of the value among the case's keyed hashes.
    const tokens = words(value).map((w) => this.pii.token(w));
    let common: Set<string> | undefined;
    for (const tk of tokens) {
      common = intersect(common, recent.byToken.get(tk) ?? new Set<string>());
      if (!common.size) break;
    }
    for (const id of common ?? []) out.add(id);
    return out;
  }

  /** The first rule the candidate breaks (its index), or null when it is eligible. */
  check(c: Candidate): number | null {
    for (const [i, { rule, recent }] of this.rules.entries()) {
      let same: Set<string> | undefined;
      for (const f of rule.fields) {
        same = intersect(same, this.matches(recent, f, c));
        if (!same.size) break;
      }
      if (same?.size) return i;
    }
    return null;
  }
}
