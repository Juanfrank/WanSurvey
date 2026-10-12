import { NAMESPACES, type Node, type Span } from './ast.js';
import { FUNCTIONS, type TypeTag } from './functions.js';
import type { VariableInfo } from './model.js';
import { own } from './values.js';

/** Static type of an expression. `row` is one roster row; `roster` an array of rows. */
export type StaticType =
  | { t: Exclude<TypeTag, 'roster'> }
  | { t: 'roster'; roster: string }
  | { t: 'row'; roster: string }
  | { t: 'null' };

/** A translatable message: an id (`diag.<id>` in the app catalogues) and its parameters. */
export interface MessageRef {
  id: string;
  params?: Record<string, string | number>;
}

export interface TypeIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  span: Span;
  msg?: MessageRef;
}

export interface TypeEnv {
  vars: Record<string, VariableInfo>;
  /** Rosters enclosing the expression, outermost first. */
  rosterChain: string[];
  /** True inside an option filter, where `code` is bound to the option being tested. */
  codeBound?: boolean;
  specialCodes?: (string | number)[];
}

const NS = new Set<string>(NAMESPACES);
const ANY: StaticType = { t: 'any' };

export function typecheck(node: Node, env: TypeEnv): { type: StaticType; issues: TypeIssue[] } {
  const issues: TypeIssue[] = [];
  const type = new Checker(env, issues).check(node, env.rosterChain);
  return { type, issues };
}

function isPrefix(prefix: string[], of: string[]): boolean {
  return prefix.length <= of.length && prefix.every((p, i) => of[i] === p);
}

class Checker {
  constructor(
    private readonly env: TypeEnv,
    private readonly issues: TypeIssue[],
  ) {}

  private err(code: string, message: string, span: Span, msg?: MessageRef) {
    this.issues.push({ severity: 'error', code, message, span, ...(msg ? { msg } : {}) });
  }

  check(node: Node, chain: string[]): StaticType {
    switch (node.type) {
      case 'num':
        return { t: 'number' };
      case 'str':
        return { t: 'string' };
      case 'bool':
        return { t: 'boolean' };
      case 'null':
        return { t: 'null' };
      case 'var':
        return this.checkVar(node, chain);
      case 'member':
        return this.checkMember(node, chain);
      case 'index': {
        const obj = this.check(node.object, chain);
        const idx = this.check(node.index, chain);
        if (idx.t !== 'number' && idx.t !== 'any' && idx.t !== 'code' && idx.t !== 'string') {
          this.err('type_mismatch', 'Index must be a number', node.index.span, {
            id: 'index_number',
          });
        }
        if (obj.t === 'roster') return { t: 'row', roster: obj.roster };
        if (obj.t === 'array') return { t: 'code' };
        if (obj.t === 'any') return ANY;
        this.err(
          'type_mismatch',
          'Only rosters, multi-choice answers and grids can be indexed',
          node.span,
          { id: 'index_target' },
        );
        return ANY;
      }
      case 'call':
        return this.checkCall(node, chain);
      case 'unary': {
        const a = this.check(node.arg, chain);
        if (node.op === 'not') return { t: 'boolean' };
        this.expectNumber(a, node.arg.span, "Unary '-'");
        return { t: 'number' };
      }
      case 'binary':
        return this.checkBinary(node, chain);
      case 'in': {
        const v = this.check(node.value, chain);
        const list = node.list.map((n) => this.check(n, chain));
        list.forEach((t, i) =>
          this.expectComparable(v.t === 'array' ? { t: 'code' } : v, t, node.list[i]!.span),
        );
        node.list.forEach((n) => this.checkCode(node.value, n));
        return { t: 'boolean' };
      }
      case 'between': {
        const v = this.check(node.value, chain);
        const lo = this.check(node.low, chain);
        const hi = this.check(node.high, chain);
        if (!['number', 'date', 'string', 'code', 'any'].includes(v.t)) {
          this.err('type_mismatch', "'between' needs a number or date", node.value.span, {
            id: 'between_type',
          });
        }
        this.expectComparable(v, lo, node.low.span);
        this.expectComparable(v, hi, node.high.span);
        return { t: 'boolean' };
      }
    }
  }

  private checkVar(node: Extract<Node, { type: 'var' }>, chain: string[]): StaticType {
    const info = own(this.env.vars, node.name);
    if (info) {
      if (!isPrefix(info.rosterChain, chain)) {
        const roster = info.rosterChain[info.rosterChain.length - 1];
        this.err(
          'roster_scope',
          `'${node.name}' belongs to roster ${roster}; outside it use ${roster}[n].${node.name}, any(${roster}, …) or ${roster}.${node.name}`,
          node.span,
          { id: 'roster_scope', params: { name: node.name, roster: roster ?? '' } },
        );
        return ANY;
      }
      if (info.type === 'roster') return { t: 'roster', roster: info.name };
      return { t: info.type } as StaticType;
    }
    if (node.name === 'mode') return { t: 'string' };
    if (node.name === 'index') {
      if (chain.length === 0)
        this.err('roster_scope', "'index' is only available inside a roster", node.span, {
          id: 'index_outside',
        });
      return { t: 'number' };
    }
    if (node.name === 'code' && this.env.codeBound) return { t: 'code' };
    if (NS.has(node.name)) return ANY;
    this.err('unknown_variable', `Unknown variable '${node.name}'`, node.span, {
      id: 'unknown_variable',
      params: { name: node.name },
    });
    return ANY;
  }

  private checkMember(node: Extract<Node, { type: 'member' }>, chain: string[]): StaticType {
    if (
      node.object.type === 'var' &&
      NS.has(node.object.name) &&
      !own(this.env.vars, node.object.name)
    )
      return ANY;
    const obj = this.check(node.object, chain);
    if (obj.t === 'any') return ANY;
    if (obj.t === 'roster' || obj.t === 'row') {
      const child = own(this.env.vars, node.property);
      const expectedChain = [...(own(this.env.vars, obj.roster)?.rosterChain ?? []), obj.roster];
      if (!child || child.rosterChain.join('.') !== expectedChain.join('.')) {
        this.err(
          'unknown_variable',
          `Roster ${obj.roster} has no variable '${node.property}'`,
          node.span,
          { id: 'roster_no_variable', params: { roster: obj.roster, name: node.property } },
        );
        return ANY;
      }
      if (obj.t === 'roster') return child.type === 'roster' ? ANY : { t: 'array' };
      if (child.type === 'roster') return { t: 'roster', roster: child.name };
      return { t: child.type } as StaticType;
    }
    this.err('type_mismatch', `Cannot read '.${node.property}' here`, node.span, {
      id: 'member_here',
      params: { name: node.property },
    });
    return ANY;
  }

  private checkCall(node: Extract<Node, { type: 'call' }>, chain: string[]): StaticType {
    const fn = own(FUNCTIONS, node.name);
    if (!fn) {
      this.err('unknown_function', `Unknown function '${node.name}'`, node.span, {
        id: 'unknown_function',
        params: { name: node.name },
      });
      node.args.forEach((a) => this.check(a, chain));
      return ANY;
    }
    const n = node.args.length;
    if (n < fn.minArgs || (fn.maxArgs !== undefined && n > fn.maxArgs)) {
      const expected =
        fn.maxArgs === undefined
          ? `at least ${fn.minArgs}`
          : fn.minArgs === fn.maxArgs
            ? `${fn.minArgs}`
            : `${fn.minArgs}–${fn.maxArgs}`;
      this.err('arity', `${node.name}() takes ${expected} argument(s), got ${n}`, node.span, {
        id: 'arity',
        params: { name: node.name, expected, got: n },
      });
    }
    node.args.forEach((arg, i) => {
      if (fn.rosterArg !== undefined && i === fn.rosterArg) {
        const t = this.check(arg, chain);
        if (t.t !== 'roster' && t.t !== 'any')
          this.err('type_mismatch', `${node.name}() needs a roster`, arg.span, {
            id: 'needs_roster',
            params: { name: node.name },
          });
        return;
      }
      if (fn.rosterArg !== undefined && i === fn.rosterArg + 1) {
        const r = node.args[fn.rosterArg];
        const info = r && r.type === 'var' ? own(this.env.vars, r.name) : undefined;
        this.check(arg, info?.type === 'roster' ? [...info.rosterChain, info.name] : chain);
        return;
      }
      if (fn.varArgs?.includes(i) && !['var', 'member', 'index'].includes(arg.type)) {
        this.err('type_mismatch', `${node.name}() needs a question variable`, arg.span, {
          id: 'needs_question',
          params: { name: node.name },
        });
      }
      const t = this.check(arg, chain);
      if (node.name === 'contains' && i === 0 && !['array', 'string', 'any'].includes(t.t)) {
        this.err('type_mismatch', 'contains() needs a multi-choice or text answer', arg.span, {
          id: 'contains_type',
        });
      }
      if (
        ['age', 'datediff'].includes(node.name) &&
        i < 2 &&
        !['date', 'string', 'any'].includes(t.t)
      ) {
        this.err('type_mismatch', `${node.name}() needs dates`, arg.span, {
          id: 'needs_dates',
          params: { name: node.name },
        });
      }
    });
    return fn.returns === 'roster' ? ANY : ({ t: fn.returns } as StaticType);
  }

  private checkBinary(node: Extract<Node, { type: 'binary' }>, chain: string[]): StaticType {
    const l = this.check(node.left, chain);
    const r = this.check(node.right, chain);
    switch (node.op) {
      case 'and':
      case 'or':
        return { t: 'boolean' };
      case '==':
      case '!=':
      case '<':
      case '<=':
      case '>':
      case '>=':
        if (l.t === 'null' || r.t === 'null') {
          if (node.op !== '==' && node.op !== '!=')
            this.err('type_mismatch', 'null can only be tested with == or !=', node.span, {
              id: 'null_test',
            });
          return { t: 'boolean' };
        }
        if ((l.t === 'array' || r.t === 'array') && l.t !== 'any' && r.t !== 'any') {
          this.err(
            'type_mismatch',
            'Multi-choice answers cannot be compared directly; use contains() or in (…)',
            node.span,
            { id: 'multi_compare' },
          );
          return { t: 'boolean' };
        }
        this.expectComparable(l, r, node.span);
        this.checkCode(node.left, node.right);
        this.checkCode(node.right, node.left);
        return { t: 'boolean' };
      case '+':
        if (l.t === 'string' && r.t === 'string') return { t: 'string' };
      // falls through
      default:
        if (l.t === 'date' && r.t === 'date' && node.op === '-') {
          this.err(
            'type_mismatch',
            'Subtracting dates is not supported; use datediff(a, b, "days")',
            node.span,
            { id: 'date_subtract' },
          );
          return ANY;
        }
        this.expectNumber(l, node.left.span, `'${node.op}'`);
        this.expectNumber(r, node.right.span, `'${node.op}'`);
        return { t: 'number' };
    }
  }

  private expectNumber(t: StaticType, span: Span, what: string) {
    if (!['number', 'any', 'code', 'null'].includes(t.t)) {
      this.err('type_mismatch', `${what} needs numbers, got ${t.t}`, span, {
        id: 'needs_numbers',
        params: { what, got: t.t },
      });
    }
  }

  private expectComparable(a: StaticType, b: StaticType, span: Span) {
    if (a.t === 'any' || b.t === 'any' || a.t === 'null' || b.t === 'null') return;
    const group = (t: string) =>
      t === 'number' || t === 'code' ? 'num' : t === 'string' || t === 'date' ? 'str' : t;
    if (a.t === 'code' || b.t === 'code') return; // codes may be numeric or string
    if (group(a.t) !== group(b.t))
      this.err('type_mismatch', `Cannot compare ${a.t} with ${b.t}`, span, {
        id: 'cannot_compare',
        params: { a: a.t, b: b.t },
      });
  }

  /** A coded variable compared with a literal that is not one of its codes is an error (L13). */
  private checkCode(varNode: Node, litNode: Node) {
    if (varNode.type !== 'var' || (litNode.type !== 'num' && litNode.type !== 'str')) return;
    const info = own(this.env.vars, varNode.name);
    if (!info?.codes || (info.type !== 'code' && info.type !== 'array')) return;
    const lit = litNode.value;
    const known = [...info.codes, ...(this.env.specialCodes ?? [])];
    if (!known.some((c) => String(c) === String(lit))) {
      this.err(
        'unknown_code',
        `Code ${JSON.stringify(lit)} is not in the answer set of ${info.name}`,
        litNode.span,
        { id: 'unknown_code', params: { code: String(lit), name: info.name } },
      );
    }
  }
}
