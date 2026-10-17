import { randomInt } from 'node:crypto';

/** Shuffles in place (Fisher–Yates with a cryptographic source), so no one can predict it. */
export function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/**
 * Hands cases out at random and evenly: the cases are shuffled, then each goes to whoever has
 * the fewest so far (ties in a random order). With `held`, what each person already holds
 * counts, so the totals come out even; without it, the new cases are split evenly.
 */
export function distribute(
  caseIds: string[],
  people: string[],
  held: Map<string, number> = new Map(),
): Map<string, string[]> {
  const out = new Map(people.map((p) => [p, [] as string[]]));
  const load = new Map(people.map((p) => [p, held.get(p) ?? 0]));
  const order = shuffle([...people]);
  for (const id of shuffle([...caseIds])) {
    let best = order[0]!;
    for (const p of order) if (load.get(p)! < load.get(best)!) best = p;
    out.get(best)!.push(id);
    load.set(best, load.get(best)! + 1);
    // Rotate, so ties do not always favour the same person.
    order.push(order.shift()!);
  }
  return out;
}

/**
 * How many new cases each person gets, in proportion to `weights` (largest remainder, ties at
 * random). `base` is what already counts towards each share ("even out": the cases held);
 * whoever is already past their share gets none. `room` caps what each may receive: whoever
 * reaches it drops out and the rest is shared among the others; what no one has room for
 * stays unassigned.
 */
export function quotas(
  people: string[],
  weights: Map<string, number>,
  count: number,
  base: Map<string, number> = new Map(),
  room: Map<string, number> = new Map(),
): Map<string, number> {
  const out = new Map(people.map((p) => [p, 0]));
  let left = count;
  let active = people.filter((p) => (weights.get(p) ?? 0) > 0 && (room.get(p) ?? Infinity) > 0);
  while (left > 0 && active.length) {
    const W = active.reduce((s, p) => s + weights.get(p)!, 0);
    const T = left + active.reduce((s, p) => s + (base.get(p) ?? 0) + out.get(p)!, 0);
    const ideal = new Map(
      active.map((p) => [p, (weights.get(p)! / W) * T - (base.get(p) ?? 0) - out.get(p)!]),
    );
    // Already past their share: nothing more, and the shares are worked out again without them.
    const past = active.filter((p) => ideal.get(p)! <= 0);
    if (past.length) {
      active = active.filter((p) => !past.includes(p));
      continue;
    }
    // Reaching their limit: they get up to it, and leave.
    const full = active.filter((p) => ideal.get(p)! >= (room.get(p) ?? Infinity) - out.get(p)!);
    if (full.length) {
      for (const p of full) {
        const give = Math.min(left, room.get(p)! - out.get(p)!);
        out.set(p, out.get(p)! + give);
        left -= give;
      }
      active = active.filter((p) => !full.includes(p));
      continue;
    }
    // Whole parts first, then one more to the largest remainders (ties in a random order).
    const order = shuffle([...active]);
    for (const p of order) {
      const whole = Math.floor(ideal.get(p)!);
      out.set(p, out.get(p)! + whole);
      left -= whole;
    }
    order.sort((a, b) => (ideal.get(b)! % 1) - (ideal.get(a)! % 1));
    for (const p of order) {
      if (left <= 0) break;
      out.set(p, out.get(p)! + 1);
      left--;
    }
    break;
  }
  return out;
}

/** The cases, in a random order, cut into the amounts given. */
export function deal(caseIds: string[], amounts: Map<string, number>): Map<string, string[]> {
  const ids = shuffle([...caseIds]);
  const out = new Map<string, string[]>();
  let at = 0;
  for (const p of shuffle([...amounts.keys()])) {
    const n = amounts.get(p)!;
    out.set(p, ids.slice(at, at + n));
    at += n;
  }
  return out;
}

/** Completes and days worked in a recent window. */
export interface Output {
  completes: number;
  days: number;
}

/**
 * Productivity (completes per day worked), pulled towards the team's by `m` days of the team's
 * pace, so someone with little history is neither rewarded nor punished for it. With no
 * history in the team, everyone weighs the same.
 */
export function productivity(
  people: string[],
  output: Map<string, Output>,
  m = 3,
): Map<string, number> {
  let c = 0;
  let d = 0;
  for (const p of people) {
    c += output.get(p)?.completes ?? 0;
    d += output.get(p)?.days ?? 0;
  }
  if (!c || !d) return new Map(people.map((p) => [p, 1]));
  const team = c / d;
  return new Map(
    people.map((p) => {
      const o = output.get(p) ?? { completes: 0, days: 0 };
      return [p, (o.completes + m * team) / (o.days + m)];
    }),
  );
}

/**
 * The fair weights: productivity counts, but softly (square root) and only so far, between
 * `low` and `high` times the team's mean.
 */
export function fairWeights(
  productivityOf: Map<string, number>,
  low = 0.8,
  high = 1.2,
): Map<string, number> {
  const soft = new Map([...productivityOf].map(([p, v]) => [p, Math.sqrt(v)]));
  const mean = [...soft.values()].reduce((s, v) => s + v, 0) / (soft.size || 1);
  return new Map(
    [...soft].map(([p, v]) => [p, Math.min(high * mean, Math.max(low * mean, v)) / mean]),
  );
}
