/** Source span (character offsets into the expression) for diagnostics. */
export interface Span {
  start: number;
  end: number;
}

export type BinaryOp =
  '+' | '-' | '*' | '/' | '^' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or';

export type Node =
  | { type: 'num'; value: number; span: Span }
  | { type: 'str'; value: string; span: Span }
  | { type: 'bool'; value: boolean; span: Span }
  | { type: 'null'; span: Span }
  | { type: 'var'; name: string; span: Span }
  | { type: 'member'; object: Node; property: string; span: Span }
  | { type: 'index'; object: Node; index: Node; span: Span }
  | { type: 'call'; name: string; args: Node[]; span: Span }
  | { type: 'unary'; op: '-' | 'not'; arg: Node; span: Span }
  | { type: 'binary'; op: BinaryOp; left: Node; right: Node; span: Span }
  | { type: 'in'; value: Node; list: Node[]; negated: boolean; span: Span }
  | { type: 'between'; value: Node; low: Node; high: Node; span: Span };

export type NodeOf<T extends Node['type']> = Extract<Node, { type: T }>;

/** Namespaces addressable with dotted access, e.g. `case.region`. */
export const NAMESPACES = ['case', 'interviewer', 'project', 'respondent'] as const;
export type Namespace = (typeof NAMESPACES)[number];

/** Identifiers with a built-in meaning. */
export const RESERVED_IDENTIFIERS = ['mode', 'index', ...NAMESPACES] as const;
