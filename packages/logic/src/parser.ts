import type { BinaryOp, Node, Span } from './ast.js';
import { LogicSyntaxError, tokenize, type Token } from './lexer.js';

/**
 * Recursive-descent parser for the logic language. Precedence, lowest first:
 *   or · and · not · comparison / in / between · + - · * / % · unary - · ^ (right-assoc) · postfix
 * Expressions are only ever parsed to an AST and interpreted; nothing is eval'd.
 */
export function parse(src: string): Node {
  const p = new Parser(tokenize(src));
  const node = p.parseExpression();
  p.expectEof();
  return node;
}

/** Parse without throwing; returns the error for diagnostics. */
export function tryParse(
  src: string,
): { ok: true; node: Node } | { ok: false; error: LogicSyntaxError } {
  try {
    return { ok: true, node: parse(src) };
  } catch (e) {
    if (e instanceof LogicSyntaxError) return { ok: false, error: e };
    throw e;
  }
}

const COMPARISON = new Set(['==', '!=', '<', '<=', '>', '>=']);

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }
  private next(): Token {
    const t = this.peek();
    if (t.type !== 'eof') this.pos++;
    return t;
  }
  private isKeyword(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === 'keyword' && t.value === value;
  }
  private isOp(value: string): boolean {
    const t = this.peek();
    return t.type === 'op' && t.value === value;
  }
  private isPunct(value: string): boolean {
    const t = this.peek();
    return t.type === 'punct' && t.value === value;
  }
  private expectPunct(value: string): Token {
    const t = this.peek();
    if (t.type !== 'punct' || t.value !== value) {
      throw new LogicSyntaxError(`Expected '${value}' but found ${describe(t)}`, t.span);
    }
    return this.next();
  }
  expectEof(): void {
    const t = this.peek();
    if (t.type !== 'eof') throw new LogicSyntaxError(`Unexpected ${describe(t)}`, t.span);
  }

  parseExpression(): Node {
    return this.parseOr();
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.isKeyword('or')) {
      this.next();
      const right = this.parseAnd();
      left = bin('or', left, right);
    }
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseNot();
    while (this.isKeyword('and')) {
      this.next();
      const right = this.parseNot();
      left = bin('and', left, right);
    }
    return left;
  }

  private parseNot(): Node {
    if (this.isKeyword('not')) {
      const t = this.next();
      const arg = this.parseNot();
      return { type: 'unary', op: 'not', arg, span: { start: t.span.start, end: arg.span.end } };
    }
    return this.parseComparison();
  }

  private parseComparison(): Node {
    const left = this.parseAdditive();
    const t = this.peek();
    if (t.type === 'op' && COMPARISON.has(t.value)) {
      this.next();
      const right = this.parseAdditive();
      const node = bin(t.value as BinaryOp, left, right);
      this.rejectChainedComparison();
      return node;
    }
    // `x not in (...)`
    if (this.isKeyword('not') && this.isKeyword('in', 1)) {
      this.next();
      this.next();
      return this.finishIn(left, true);
    }
    if (this.isKeyword('in')) {
      this.next();
      return this.finishIn(left, false);
    }
    if (this.isKeyword('between')) {
      this.next();
      const low = this.parseAdditive();
      if (!this.isKeyword('and')) {
        throw new LogicSyntaxError("Expected 'and' in 'between … and …'", this.peek().span);
      }
      this.next();
      const high = this.parseAdditive();
      this.rejectChainedComparison();
      return {
        type: 'between',
        value: left,
        low,
        high,
        span: { start: left.span.start, end: high.span.end },
      };
    }
    return left;
  }

  private rejectChainedComparison(): void {
    const t = this.peek();
    if (
      (t.type === 'op' && COMPARISON.has(t.value)) ||
      this.isKeyword('in') ||
      this.isKeyword('between')
    ) {
      throw new LogicSyntaxError('Comparisons cannot be chained; combine them with and/or', t.span);
    }
  }

  private finishIn(value: Node, negated: boolean): Node {
    this.expectPunct('(');
    const list: Node[] = [];
    if (!this.isPunct(')')) {
      do {
        list.push(this.parseAdditive());
      } while (this.isPunct(',') && this.next());
    }
    const close = this.expectPunct(')');
    if (list.length === 0) throw new LogicSyntaxError("'in' needs at least one value", close.span);
    this.rejectChainedComparison();
    return {
      type: 'in',
      value,
      list,
      negated,
      span: { start: value.span.start, end: close.span.end },
    };
  }

  private parseAdditive(): Node {
    let left = this.parseMultiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().value as BinaryOp;
      left = bin(op, left, this.parseMultiplicative());
    }
    return left;
  }

  private parseMultiplicative(): Node {
    let left = this.parseUnary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next().value as BinaryOp;
      left = bin(op, left, this.parseUnary());
    }
    return left;
  }

  private parseUnary(): Node {
    if (this.isOp('-')) {
      const t = this.next();
      const arg = this.parseUnary();
      return { type: 'unary', op: '-', arg, span: { start: t.span.start, end: arg.span.end } };
    }
    if (this.isOp('+')) {
      this.next();
      return this.parseUnary();
    }
    return this.parsePower();
  }

  private parsePower(): Node {
    const base = this.parsePostfix();
    if (this.isOp('^')) {
      this.next();
      return bin('^', base, this.parseUnary());
    }
    return base;
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary();
    for (;;) {
      if (this.isPunct('.')) {
        this.next();
        const t = this.next();
        if (t.type !== 'ident' && t.type !== 'keyword') {
          throw new LogicSyntaxError(
            `Expected a field name after '.' but found ${describe(t)}`,
            t.span,
          );
        }
        node = {
          type: 'member',
          object: node,
          property: t.value,
          span: { start: node.span.start, end: t.span.end },
        };
      } else if (this.isPunct('[')) {
        this.next();
        const index = this.parseExpression();
        const close = this.expectPunct(']');
        node = {
          type: 'index',
          object: node,
          index,
          span: { start: node.span.start, end: close.span.end },
        };
      } else {
        return node;
      }
    }
  }

  private parsePrimary(): Node {
    const t = this.next();
    switch (t.type) {
      case 'num':
        return { type: 'num', value: Number(t.value), span: t.span };
      case 'str':
        return { type: 'str', value: t.value, span: t.span };
      case 'keyword':
        if (t.value === 'true' || t.value === 'false')
          return { type: 'bool', value: t.value === 'true', span: t.span };
        if (t.value === 'null') return { type: 'null', span: t.span };
        throw new LogicSyntaxError(`Unexpected '${t.value}'`, t.span);
      case 'ident': {
        if (this.isPunct('(')) {
          this.next();
          const args: Node[] = [];
          if (!this.isPunct(')')) {
            do {
              args.push(this.parseExpression());
            } while (this.isPunct(',') && this.next());
          }
          const close = this.expectPunct(')');
          return {
            type: 'call',
            name: t.value,
            args,
            span: { start: t.span.start, end: close.span.end },
          };
        }
        return { type: 'var', name: t.value, span: t.span };
      }
      case 'punct':
        if (t.value === '(') {
          const inner = this.parseExpression();
          this.expectPunct(')');
          return inner;
        }
        throw new LogicSyntaxError(`Unexpected '${t.value}'`, t.span);
      case 'eof':
        throw new LogicSyntaxError('Unexpected end of expression', t.span);
      default:
        throw new LogicSyntaxError(`Unexpected ${describe(t)}`, t.span);
    }
  }
}

function bin(op: BinaryOp, left: Node, right: Node): Node {
  const span: Span = { start: left.span.start, end: right.span.end };
  return { type: 'binary', op, left, right, span };
}

function describe(t: Token): string {
  return t.type === 'eof' ? 'end of expression' : `'${t.value}'`;
}
