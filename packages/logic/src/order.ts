import type { ItemOrder } from '@wansurvey/schema';
import { seededRandom } from './hash.js';

/**
 * The order in which the items of a section or block are shown, for one interview: `random`
 * shuffles them, `rotate` starts the same sequence at another item. Fixed items keep their
 * place. Seeded (normally the interview id and the container's key), so every device and the
 * server see the same order.
 */
export function orderItems<T extends string>(
  ids: readonly T[],
  order: ItemOrder,
  seed: string,
): T[] {
  const fixed = new Set(order.fixed ?? []);
  const movable = ids.filter((id) => !fixed.has(id));
  if (movable.length < 2) return [...ids];
  const rnd = seededRandom(seed);
  let placed: T[];
  if (order.type === 'rotate') {
    const start = Math.floor(rnd() * movable.length);
    placed = [...movable.slice(start), ...movable.slice(0, start)];
  } else {
    placed = movable.slice();
    for (let i = placed.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [placed[i], placed[j]] = [placed[j]!, placed[i]!];
    }
  }
  let m = 0;
  return ids.map((id) => (fixed.has(id) ? id : placed[m++]!));
}
