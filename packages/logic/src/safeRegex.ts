/**
 * A regular-expression matcher that cannot be made slow by its pattern: it runs a Thompson NFA, so
 * the time is the length of the text times the size of the pattern, with no backtracking (the
 * built-in `RegExp` can take minutes on `(a+)+$`). The patterns come from people who write the
 * rules of a project, and the texts from files they load, so a pattern must not hang the server.
 *
 * What it understands: literals, `.`, classes `[a-z0-9_]` and `[^…]`, the escapes `\d \D \w \W \s \S`
 * (and `\.` and the like for a literal), groups `( … )`, alternation `|`, the quantifiers
 * `* + ? {n} {n,} {n,m}` (up to 100), and the anchors `^` and `$`. Without anchors a pattern may
 * match anywhere in the text. Case does not matter. No back-references, no look-around.
 */

export class RegexError extends Error {}

type Node =
  | { t: 'empty' }
  | { t: 'test'; f: (c: string) => boolean }
  | { t: 'seq'; xs: Node[] }
  | { t: 'alt'; xs: Node[] }
  | { t: 'rep'; x: Node; min: number; max: number }
  | { t: 'bol' }
  | { t: 'eol' };

const MAX_REPEAT = 100;
const MAX_STATES = 20_000;
const MAX_PATTERN = 500;

const isDigit = (c: string) => c >= '0' && c <= '9';
const isWord = (c: string) => /[\p{L}\p{N}_]/u.test(c);
const isSpace = (c: string) => /\s/u.test(c);
const lower = (c: string) => c.toLowerCase();

const ESCAPES: Record<string, (c: string) => boolean> = {
  d: isDigit,
  D: (c) => !isDigit(c),
  w: isWord,
  W: (c) => !isWord(c),
  s: isSpace,
  S: (c) => !isSpace(c),
};

function parse(pattern: string): Node {
  if (pattern.length > MAX_PATTERN) throw new RegexError('the pattern is too long');
  const cs = Array.from(pattern);
  let i = 0;
  const fail = (m: string): never => {
    throw new RegexError(m);
  };

  const literal = (ch: string): Node => ({ t: 'test', f: (c) => lower(c) === lower(ch) });

  function escapeTest(): Node {
    const e = cs[i++];
    if (e === undefined) return fail('a backslash with nothing after it');
    const f = ESCAPES[e];
    if (f) return { t: 'test', f };
    if (/[A-Za-z0-9]/.test(e)) return fail(`\\${e} is not supported`);
    return literal(e);
  }

  function parseClass(): Node {
    const negate = cs[i] === '^';
    if (negate) i++;
    const tests: ((c: string) => boolean)[] = [];
    let first = true;
    for (;;) {
      const c = cs[i++];
      if (c === undefined) return fail('a [ was never closed');
      if (c === ']' && !first) break;
      first = false;
      if (c === '\\') {
        const e = cs[i++];
        if (e === undefined) return fail('a backslash with nothing after it');
        const f = ESCAPES[e];
        if (f) tests.push(f);
        else tests.push((x) => lower(x) === lower(e));
        continue;
      }
      if (cs[i] === '-' && cs[i + 1] !== undefined && cs[i + 1] !== ']') {
        const hi = cs[i + 1]!;
        i += 2;
        if (hi < c) fail(`the range ${c}-${hi} runs backwards`);
        tests.push((x) => {
          const l = lower(x);
          const u = x.toUpperCase();
          return (l >= c && l <= hi) || (u >= c && u <= hi) || (x >= c && x <= hi);
        });
      } else tests.push((x) => lower(x) === lower(c));
    }
    return { t: 'test', f: (c) => tests.some((f) => f(c)) !== negate };
  }

  function number(): number {
    let s = '';
    while (cs[i] !== undefined && isDigit(cs[i]!)) s += cs[i++];
    return s === '' ? -1 : Number(s);
  }

  function atom(): Node {
    const c = cs[i++]!;
    switch (c) {
      case '(': {
        const inner = alt();
        if (cs[i++] !== ')') fail('a ( was never closed');
        return inner;
      }
      case '[':
        return parseClass();
      case '.':
        return { t: 'test', f: () => true };
      case '^':
        return { t: 'bol' };
      case '$':
        return { t: 'eol' };
      case '\\':
        return escapeTest();
      case '*':
      case '+':
      case '?':
        return fail(`${c} has nothing to repeat`);
      case ')':
        return fail('a ) with no ( before it');
      default:
        return literal(c);
    }
  }

  function repeat(): Node {
    let x = atom();
    for (;;) {
      const c = cs[i];
      if (c === '*') {
        i++;
        x = { t: 'rep', x, min: 0, max: Infinity };
      } else if (c === '+') {
        i++;
        x = { t: 'rep', x, min: 1, max: Infinity };
      } else if (c === '?') {
        i++;
        x = { t: 'rep', x, min: 0, max: 1 };
      } else if (c === '{') {
        const save = i;
        i++;
        const min = number();
        let max = min;
        if (cs[i] === ',') {
          i++;
          max = number();
          if (max === -1) max = Infinity;
        }
        if (min < 0 || cs[i] !== '}') {
          // Not a quantifier: a literal brace.
          i = save + 1;
          x = { t: 'seq', xs: [x, literal('{')] };
          continue;
        }
        i++;
        if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT))
          fail(`a repeat above ${MAX_REPEAT}`);
        if (max < min) fail('a repeat that runs backwards');
        x = { t: 'rep', x, min, max };
      } else return x;
    }
  }

  function seq(): Node {
    const xs: Node[] = [];
    while (i < cs.length && cs[i] !== '|' && cs[i] !== ')') xs.push(repeat());
    return xs.length === 1 ? xs[0]! : xs.length ? { t: 'seq', xs } : { t: 'empty' };
  }

  function alt(): Node {
    const xs = [seq()];
    while (cs[i] === '|') {
      i++;
      xs.push(seq());
    }
    return xs.length === 1 ? xs[0]! : { t: 'alt', xs };
  }

  const tree = alt();
  if (i < cs.length) fail('a ) with no ( before it');
  return tree;
}

type State =
  | { k: 'test'; f: (c: string) => boolean; out: number }
  | { k: 'split'; a: number; b: number }
  | { k: 'bol'; out: number }
  | { k: 'eol'; out: number }
  | { k: 'match' };

interface Program {
  states: State[];
  start: number;
  /** Starts with ^: the match can only begin at the first character. */
  anchored: boolean;
}

function compile(pattern: string): Program {
  const tree = parse(pattern);
  const states: State[] = [];
  const add = (s: State) => {
    if (states.length >= MAX_STATES) throw new RegexError('the pattern is too large');
    states.push(s);
    return states.length - 1;
  };
  const comp = (n: Node, next: number): number => {
    switch (n.t) {
      case 'empty':
        return next;
      case 'test':
        return add({ k: 'test', f: n.f, out: next });
      case 'bol':
        return add({ k: 'bol', out: next });
      case 'eol':
        return add({ k: 'eol', out: next });
      case 'seq': {
        let t = next;
        for (let j = n.xs.length - 1; j >= 0; j--) t = comp(n.xs[j]!, t);
        return t;
      }
      case 'alt': {
        const starts = n.xs.map((x) => comp(x, next));
        let t = starts[starts.length - 1]!;
        for (let j = starts.length - 2; j >= 0; j--) t = add({ k: 'split', a: starts[j]!, b: t });
        return t;
      }
      case 'rep': {
        let t = next;
        if (n.max === Infinity) {
          const loop = add({ k: 'split', a: -1, b: next });
          (states[loop] as { a: number }).a = comp(n.x, loop);
          t = loop;
        } else {
          for (let j = 0; j < n.max - n.min; j++) t = add({ k: 'split', a: comp(n.x, t), b: next });
        }
        for (let j = 0; j < n.min; j++) t = comp(n.x, t);
        return t;
      }
    }
  };
  const match = add({ k: 'match' });
  const start = comp(tree, match);
  const first = tree.t === 'bol' || (tree.t === 'seq' && tree.xs[0]?.t === 'bol');
  return { states, start, anchored: first };
}

const cache = new Map<string, Program | RegexError>();

function program(pattern: string): Program {
  let p = cache.get(pattern);
  if (p === undefined) {
    try {
      p = compile(pattern);
    } catch (e) {
      p = e instanceof RegexError ? e : new RegexError('the pattern cannot be read');
    }
    if (cache.size >= 200) cache.delete(cache.keys().next().value!);
    cache.set(pattern, p);
  }
  if (p instanceof RegexError) throw p;
  return p;
}

/** The error in a pattern, or null when it is fine. */
export function regexProblem(pattern: string): string | null {
  try {
    program(pattern);
    return null;
  } catch (e) {
    return e instanceof RegexError ? e.message : 'the pattern cannot be read';
  }
}

/** Whether the pattern matches somewhere in the text (anchors with ^ and $). Throws RegexError. */
export function regexTest(pattern: string, text: string): boolean {
  const { states, start, anchored } = program(pattern);
  const chars = Array.from(text);
  const n = chars.length;
  let current = new Set<number>();
  let matched = false;

  // Adds a state and everything reachable without reading a character.
  const follow = (set: Set<number>, s: number, pos: number) => {
    const stack = [s];
    while (stack.length) {
      const id = stack.pop()!;
      if (set.has(id)) continue;
      const st = states[id]!;
      if (st.k === 'split') {
        set.add(id);
        stack.push(st.a, st.b);
      } else if (st.k === 'bol') {
        set.add(id);
        if (pos === 0) stack.push(st.out);
      } else if (st.k === 'eol') {
        set.add(id);
        if (pos === n) stack.push(st.out);
      } else {
        set.add(id);
        if (st.k === 'match') matched = true;
      }
    }
  };

  for (let pos = 0; pos <= n; pos++) {
    if (pos === 0 || !anchored) follow(current, start, pos);
    if (matched) return true;
    if (pos === n) break;
    const ch = chars[pos]!;
    const next = new Set<number>();
    for (const id of current) {
      const st = states[id]!;
      if (st.k === 'test' && st.f(ch)) follow(next, st.out, pos + 1);
    }
    if (matched) return true;
    current = next;
  }
  return false;
}
