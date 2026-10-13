import type { CompiledQuestionnaire } from '@wansurvey/logic';

/** A small least-recently-used map: the newest entries stay, the oldest go past `max`. */
export class Lru<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // Used again: move it to the newest end.
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: K, value: V) {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }

  get size() {
    return this.map.size;
  }
}

/** Compiled questionnaires by version id (immutable rows), per process. */
export const compiledCache = new Lru<string, CompiledQuestionnaire>(100);
