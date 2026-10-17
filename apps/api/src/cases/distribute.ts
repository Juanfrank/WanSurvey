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
