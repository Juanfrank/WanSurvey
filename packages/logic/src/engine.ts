import {
  SKIP_END,
  SKIP_END_ROW,
  type AnswerOption,
  type Answers,
  type AnswerValue,
  type LocalizedText,
  type Mode,
  type Question,
  type Roster,
  type SpecialKind,
  type StaticText,
} from '@wansurvey/schema';
import type { Namespace } from './ast.js';
import type { CompiledQuestionnaire } from './compile.js';
import { evaluate, type Scope } from './evaluator.js';
import { seededRandom } from './hash.js';
import { formatKey, framesKey, parseKey, type Frame } from './keys.js';
import { questionOptions, type CompiledExpr, type CompiledNode } from './model.js';
import { renderTemplate } from './piping.js';
import {
  own,
  isAnswered,
  isSpecial,
  isoDate,
  looseEquals,
  parseIsoDate,
  special,
  toNumber,
  truthy,
  type Value,
} from './values.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InterviewContext {
  case?: Record<string, unknown>;
  interviewer?: Record<string, unknown>;
  project?: Record<string, unknown>;
  respondent?: Record<string, unknown>;
}

/** Answers quota questions; the server counts completes per cell. */
export interface QuotaProvider {
  isFull(quotaId: string): boolean;
}

export interface InterviewState {
  answers: Answers;
  /** Values cleared by a path change, restored automatically if the path returns. */
  stash: Record<string, AnswerValue>;
  /** Soft-check confirmations per answer key. */
  confirmations: Record<string, string[]>;
  visited: string[];
  /** Keys whose prefill has been applied (so clearing a prefilled answer sticks). */
  prefilled: string[];
  position: string | null;
  completed: boolean;
  language: string;
}

export interface InterviewOptions {
  mode: Mode;
  language?: string;
  context?: InterviewContext;
  /** Clock; only the date part is used by today(). Fixed per session for determinism. */
  now?: () => Date;
  /** Seed for option randomisation, normally the interview id. */
  seed?: string;
  quotas?: QuotaProvider;
  state?: Partial<InterviewState>;
}

export type EntryStatus = 'active' | 'hidden' | 'skipped' | 'notInMode' | 'ended';

export interface TraceEntry {
  key: string;
  id: string;
  kind: CompiledNode['kind'];
  status: EntryStatus;
  /** Human-readable reason for the status, for the designer's path tracer. */
  reason: string;
  depth: number;
  frames: Frame[];
}

export type AnswerSourceKind = 'interviewer' | 'respondent' | 'reviewer' | 'system';

export interface ChangeEvent {
  key: string;
  oldValue: AnswerValue;
  newValue: AnswerValue;
  source: AnswerSourceKind;
  reason?:
    'path_change' | 'path_restored' | 'prefill' | 'computed' | 'row_removed' | 'roster_resized';
}

export interface EndState {
  disposition: string;
  byKey: string;
  reason: 'endIf' | 'quota';
  quotaId?: string;
}

export interface ChangeResult {
  ok: boolean;
  error?: string;
  /** Answers removed because they fell off the path. */
  cleared: { key: string; value: AnswerValue }[];
  /** Answers brought back because the path returned to them. */
  restored: { key: string; value: AnswerValue }[];
  ended: EndState | null;
}

export interface ValidationMessage {
  ruleId: string;
  severity: 'error' | 'warning';
  message: string;
  confirmed?: boolean;
}

export interface ValidationResult {
  errors: ValidationMessage[];
  warnings: ValidationMessage[];
  /** True when there are no errors and every warning is confirmed. */
  canProceed: boolean;
}

export interface RenderedOption {
  code: string | number;
  label: string;
  exclusive?: boolean;
  otherSpecify?: boolean;
}

export interface NavigationResult {
  ok: boolean;
  key: string | null;
  done?: boolean;
  validation?: ValidationResult;
}

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

const MAX_ROWS = 100;
const ROW_END = -2;
const DEFAULT_MESSAGES = {
  required: 'An answer is required',
  invalidCode: 'Select one of the listed options',
  notNumber: 'Enter a number',
  integer: 'Enter a whole number',
  decimals: (n: number) => `Use at most ${n} decimal place(s)`,
  min: (n: unknown) => `The minimum is ${n}`,
  max: (n: unknown) => `The maximum is ${n}`,
  minSel: (n: number) => `Select at least ${n}`,
  maxSel: (n: number) => `Select at most ${n}`,
  exclusive: 'This option cannot be combined with others',
  maxLength: (n: number) => `Use at most ${n} characters`,
  pattern: 'The answer does not have the expected format',
  date: 'Enter a valid date',
  special: 'This answer is not available here',
  gridRow: 'Answer every row',
  ranking: 'Rank each option once',
};

// ---------------------------------------------------------------------------
// Scope backed by the interview
// ---------------------------------------------------------------------------

class InterviewScope implements Scope {
  constructor(
    private readonly s: InterviewSession,
    readonly frames: Frame[],
    private readonly code?: Value,
  ) {}
  get mode() {
    return this.s.mode;
  }
  get today() {
    return this.s.today;
  }
  get(name: string): Value | undefined {
    if (this.code !== undefined && name === 'code') return this.code;
    const info = own(this.s.compiled.vars, name);
    if (!info) return undefined;
    const chain = info.rosterChain;
    for (let i = 0; i < chain.length; i++) if (this.frames[i]?.name !== chain[i]) return null;
    const container = this.s.container(this.frames.slice(0, chain.length), false);
    return (own(container, name) as Value | undefined) ?? null;
  }
  namespace(ns: Namespace) {
    return this.s.context[ns];
  }
  rowIndex() {
    return this.frames.length ? this.frames[this.frames.length - 1]!.row : null;
  }
  rowScope(rosterName: string, row: number): Scope | null {
    const info = own(this.s.compiled.vars, rosterName);
    if (!info || info.kind !== 'roster') return null;
    const depth = info.rosterChain.length;
    for (let i = 0; i < depth; i++) if (this.frames[i]?.name !== info.rosterChain[i]) return null;
    return new InterviewScope(this.s, [...this.frames.slice(0, depth), { name: rosterName, row }]);
  }
  label(name: string, code: Value) {
    return this.s.labelOf(name, code);
  }
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

interface WalkState {
  entries: TraceEntry[];
  cleared: ChangeResult['cleared'];
  restored: ChangeResult['restored'];
  ended: EndState | null;
  skipToEnd: string | null;
}

/**
 * One interview: answers, routing, validation and navigation. Pure and synchronous; persistence
 * (IndexedDB, sync, server) wraps it. The same class runs in browsers, offline PWAs and on the server.
 */
export class InterviewSession {
  readonly mode: Mode;
  readonly context: InterviewContext;
  readonly today: string;
  language: string;

  private answers: Answers;
  private stash: Record<string, AnswerValue>;
  private confirmations: Record<string, string[]>;
  private visited: Set<string>;
  private prefilled: Set<string>;
  private position: string | null;
  private completed: boolean;
  private readonly seed: string;
  private readonly quotas: QuotaProvider | undefined;

  private trace_: TraceEntry[] = [];
  private path_: TraceEntry[] = [];
  private activeKeys = new Map<string, TraceEntry>();
  private ended: EndState | null = null;
  private events: ChangeEvent[] = [];
  /** Dependency-graph cache: node index → (slot|frames → value). */
  private cache = new Map<number, Map<string, Value>>();
  private walking: WalkState | null = null;

  constructor(
    readonly compiled: CompiledQuestionnaire,
    opts: InterviewOptions,
  ) {
    const q = compiled.questionnaire;
    this.mode = opts.mode;
    this.context = opts.context ?? {};
    this.today = isoDate((opts.now ?? (() => new Date()))().getTime());
    this.seed = opts.seed ?? '';
    this.quotas = opts.quotas;
    const st = opts.state ?? {};
    this.language = opts.language ?? st.language ?? q.defaultLanguage;
    this.answers = structuredCloneJson(st.answers ?? {});
    this.stash = structuredCloneJson(st.stash ?? {});
    this.confirmations = structuredCloneJson(st.confirmations ?? {});
    this.visited = new Set(st.visited ?? []);
    this.prefilled = new Set(st.prefilled ?? []);
    this.position = st.position ?? null;
    this.completed = st.completed ?? false;
    this.walk();
    if (this.position === null && !this.completed) this.position = this.path_[0]?.key ?? null;
  }

  // --- state access ----------------------------------------------------------

  getAnswers(): Answers {
    return structuredCloneJson(this.answers);
  }

  getAnswer(key: string): AnswerValue {
    const k = parseKey(key);
    if (!k) return null;
    return (this.container(k.frames, false)?.[k.name] as AnswerValue | undefined) ?? null;
  }

  state(): InterviewState {
    return {
      answers: structuredCloneJson(this.answers),
      stash: structuredCloneJson(this.stash),
      confirmations: structuredCloneJson(this.confirmations),
      visited: [...this.visited],
      prefilled: [...this.prefilled],
      position: this.position,
      completed: this.completed,
      language: this.language,
    };
  }

  /** Every node with its status and the reason (path tracer). */
  trace(): TraceEntry[] {
    return this.trace_;
  }

  /** Navigable items (questions and static texts) currently on the path, in order. */
  path(): TraceEntry[] {
    return this.path_;
  }

  pathKeys(): string[] {
    return this.path_.map((e) => e.key);
  }

  /** Change events since the last drain (for AnswerEvent / audit). */
  drainEvents(): ChangeEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  currentKey(): string | null {
    return this.completed ? null : this.position;
  }

  endState(): EndState | null {
    return this.ended;
  }

  status() {
    const questions = this.path_.filter((e) => e.kind === 'question');
    // Optional questions count as done once passed.
    const answered = questions.filter(
      (e) =>
        isAnswered(this.getAnswer(e.key) as Value) ||
        (this.visited.has(e.key) &&
          (this.compiled.nodes[own(this.compiled.byId, e.id)!]!.def as Question).required ===
            false),
    ).length;
    return {
      state: this.completed ? (this.ended ? 'ended' : 'completed') : 'in_progress',
      disposition: this.completed ? (this.ended?.disposition ?? 'COMPLETE') : null,
      answered,
      total: questions.length,
      /** Progress over the estimated path (not item count). */
      progress: questions.length === 0 ? 1 : answered / questions.length,
    } as const;
  }

  // --- answering -----------------------------------------------------------

  setAnswer(
    key: string,
    value: AnswerValue,
    source: AnswerSourceKind = 'interviewer',
  ): ChangeResult {
    const parsed = parseKey(key);
    if (!parsed) return fail(`Invalid key '${key}'`);
    const info = own(this.compiled.vars, parsed.name);
    if (!info || (info.kind !== 'question' && info.kind !== 'other'))
      return fail(`'${parsed.name}' is not a question`);
    const questionKey = formatKey(parsed.frames, this.compiled.nodes[info.node]!.name!);
    if (!this.activeKeys.has(questionKey)) return fail(`${questionKey} is not on the current path`);
    const node = this.compiled.nodes[info.node]!;
    if (info.kind === 'question') {
      const err = this.shapeError(node, value);
      if (err) return fail(err);
    } else if (value !== null && typeof value !== 'string') {
      return fail('Other-specify answers are text');
    }
    const normalised = normaliseEmpty(value);
    const old =
      (this.container(parsed.frames, false)?.[parsed.name] as AnswerValue | undefined) ?? null;
    if (jsonEqual(old, normalised))
      return { ok: true, cleared: [], restored: [], ended: this.ended };

    this.write(parsed.frames, parsed.name, normalised);
    delete this.stash[key];
    delete this.confirmations[key];
    this.events.push({ key, oldValue: old, newValue: normalised, source });
    // Deselecting an other-specify option clears its text.
    if (info.kind === 'question') this.syncOtherSpecify(node, parsed.frames, normalised, source);
    this.completed = false;
    return this.rewalk();
  }

  setSpecial(
    key: string,
    kind: SpecialKind,
    source: AnswerSourceKind = 'interviewer',
  ): ChangeResult {
    return this.setAnswer(key, special(kind), source);
  }

  clearAnswer(key: string, source: AnswerSourceKind = 'interviewer'): ChangeResult {
    return this.setAnswer(key, null, source);
  }

  confirmWarning(key: string, ruleId: string): void {
    const list = (this.confirmations[key] ??= []);
    if (!list.includes(ruleId)) list.push(ruleId);
  }

  /** Adds a row to an open roster ("add another"). Returns the new 1-based row number. */
  addRosterRow(rosterKey: string): number {
    const { frames, node } = this.rosterAt(rosterKey);
    const r = node.def as Roster;
    if (r.count.type !== 'open') throw new EngineError(`Roster ${r.name} does not accept new rows`);
    const container = this.container(frames, true)!;
    const rows = Array.isArray(container[r.name]) ? (container[r.name] as AnswerValue[]) : [];
    if (rows.length >= (r.count.max ?? MAX_ROWS)) throw new EngineError(`Roster ${r.name} is full`);
    rows.push({} as AnswerValue);
    container[r.name] = rows as AnswerValue;
    this.invalidate(r.name);
    this.rewalk();
    return rows.length;
  }

  /** Removes a row from an open roster; later rows shift up. */
  removeRosterRow(
    rosterKey: string,
    row: number,
    source: AnswerSourceKind = 'interviewer',
  ): ChangeResult {
    const { frames, node } = this.rosterAt(rosterKey);
    const r = node.def as Roster;
    if (r.count.type !== 'open') return fail(`Rows of ${r.name} are controlled by its count`);
    const container = this.container(frames, false);
    const rows = own(container, r.name);
    if (!Array.isArray(rows) || row < 1 || row > rows.length)
      return fail(`Row ${row} does not exist`);
    const [removed] = rows.splice(row - 1, 1);
    this.events.push({
      key: `${rosterKey}[${row}]`,
      oldValue: (removed ?? null) as AnswerValue,
      newValue: null,
      source,
      reason: 'row_removed',
    });
    this.invalidate(r.name);
    return this.rewalk();
  }

  setLanguage(lang: string): void {
    this.language = lang;
    this.cache.clear();
    this.rewalk();
  }

  // --- validation ------------------------------------------------------------

  validate(key: string): ValidationResult {
    const entry = this.activeKeys.get(key);
    const result: ValidationResult = { errors: [], warnings: [], canProceed: true };
    if (!entry || entry.kind !== 'question') return result;
    const node = this.compiled.nodes[own(this.compiled.byId, entry.id)!]!;
    const q = node.def as Question;
    const value = this.getAnswer(key) as Value;
    const scope = new InterviewScope(this, entry.frames);
    const error = (ruleId: string, message: string) =>
      result.errors.push({ ruleId, severity: 'error', message });

    if (!isAnswered(value)) {
      if (q.required !== false) error('required', DEFAULT_MESSAGES.required);
    } else {
      for (const m of this.builtInChecks(node, entry.frames, value)) error(m.ruleId, m.message);
      if (q.options?.some((o) => o.otherSpecify)) {
        const selected = Array.isArray(value) ? value : [value];
        const other = q.options.find(
          (o) => o.otherSpecify && selected.some((v) => looseEquals(v, o.code)),
        );
        const otherText = this.getAnswer(formatKey(entry.frames, `${q.name}_OTHER`));
        if (other && !isAnswered(otherText as Value))
          error('other_specify', 'Please specify "other"');
      }
      for (const rule of node.validations) {
        if (!rule.expr.ast || !truthy(evaluate(rule.expr.ast, scope))) continue;
        const def = q.validations!.find((v) => v.id === rule.id)!;
        const message = this.renderText(def.message, entry.frames) ?? rule.id;
        if (rule.severity === 'error') error(rule.id, message);
        else {
          const confirmed = (this.confirmations[key] ?? []).includes(rule.id);
          result.warnings.push({ ruleId: rule.id, severity: 'warning', message, confirmed });
        }
      }
    }
    result.canProceed = result.errors.length === 0 && result.warnings.every((w) => w.confirmed);
    return result;
  }

  // --- navigation ------------------------------------------------------------

  /** Validates the current item and moves to the next one on the path. */
  next(): NavigationResult {
    if (this.completed) return { ok: true, key: null, done: true };
    const idx = this.indexOnPath(this.position);
    if (idx === -1) {
      this.reposition();
      return { ok: false, key: this.position };
    }
    const key = this.position!;
    const validation = this.validate(key);
    if (!validation.canProceed) return { ok: false, key, validation };
    this.visited.add(key);
    const nextEntry = this.path_[idx + 1];
    if (!nextEntry) {
      this.completed = true;
      return { ok: true, key: null, done: true, validation };
    }
    this.position = nextEntry.key;
    return { ok: true, key: this.position, validation };
  }

  prev(): NavigationResult {
    if (this.completed) {
      this.completed = false;
      this.position = this.path_[this.path_.length - 1]?.key ?? null;
      return { ok: true, key: this.position };
    }
    const idx = this.indexOnPath(this.position);
    if (idx <= 0) return { ok: false, key: this.position };
    this.position = this.path_[idx - 1]!.key;
    return { ok: true, key: this.position };
  }

  /** Back to any answered/visited item; forward only to items already visited on this path. */
  canJumpTo(key: string): boolean {
    const target = this.indexOnPath(key);
    if (target === -1) return false;
    const current = this.completed ? this.path_.length : this.indexOnPath(this.position);
    if (target <= current) return true;
    return this.visited.has(key);
  }

  jumpTo(key: string): NavigationResult {
    if (!this.canJumpTo(key)) return { ok: false, key: this.position };
    this.completed = false;
    this.position = key;
    return { ok: true, key };
  }

  // --- presentation helpers ---------------------------------------------------

  /** Question/static text for the active mode and language, with pipes resolved. */
  text(key: string, field: 'text' | 'interviewerInstruction' | 'helpText' = 'text'): string | null {
    const entry = this.activeKeys.get(key);
    if (!entry) return null;
    const node = this.compiled.nodes[own(this.compiled.byId, entry.id)!]!;
    const def = node.def as Question | StaticText;
    const variant = def.variants?.[this.mode];
    const source = variant?.[field] ?? (field === 'text' ? def.text : undefined);
    return source ? this.renderText(source, entry.frames) : null;
  }

  renderText(
    text: LocalizedText,
    frames: Frame[] = [],
    placeholder?: (src: string) => string,
  ): string | null {
    const src = pickLanguage(text, this.language, this.compiled.questionnaire.defaultLanguage);
    if (src === null) return null;
    return renderTemplate(src, new InterviewScope(this, frames), {
      lang: this.language,
      ...(placeholder ? { placeholder } : {}),
      specialLabel: (k) => this.specialLabel(k as SpecialKind),
    });
  }

  /** Options to display for a question: filtered, randomised (seeded) and labelled. */
  optionsFor(key: string): { options: RenderedOption[]; special: SpecialKind[] } {
    const entry = this.activeKeys.get(key);
    if (!entry || entry.kind !== 'question') return { options: [], special: [] };
    const node = this.compiled.nodes[own(this.compiled.byId, entry.id)!]!;
    const q = node.def as Question;
    const visible = this.visibleOptions(node, entry.frames, key);
    return {
      options: visible.map((o) => ({
        code: o.code,
        label: this.renderText(o.label, entry.frames) ?? String(o.code),
        ...(o.exclusive ? { exclusive: true } : {}),
        ...(o.otherSpecify ? { otherSpecify: true } : {}),
      })),
      special: this.offeredSpecials(q),
    };
  }

  labelOf(name: string, code: Value): string | null {
    if (isSpecial(code)) return this.specialLabel(code.$special);
    const info = own(this.compiled.vars, name);
    if (!info || info.kind !== 'question') return null;
    const q = this.compiled.nodes[info.node]!.def as Question;
    const option = questionOptions(q, this.compiled.questionnaire).find((o) =>
      looseEquals(o.code, code),
    );
    return option
      ? pickLanguage(option.label, this.language, this.compiled.questionnaire.defaultLanguage)
      : null;
  }

  specialLabel(kind: SpecialKind): string {
    const cfg = this.compiled.questionnaire.settings.specialCodes[kind];
    return (
      pickLanguage(cfg.label, this.language, this.compiled.questionnaire.defaultLanguage) ?? kind
    );
  }

  // --- internals: storage ------------------------------------------------------

  /** Object holding the variables of the given roster rows (the answers root for no frames). */
  container(frames: Frame[], create: boolean): Record<string, AnswerValue> | null {
    let obj: Record<string, AnswerValue> = this.answers;
    for (const f of frames) {
      let rows = own(obj, f.name);
      if (!Array.isArray(rows)) {
        if (!create) return null;
        rows = [];
        obj[f.name] = rows;
      }
      let row = (rows as AnswerValue[])[f.row - 1];
      if (row === undefined || row === null || typeof row !== 'object' || Array.isArray(row)) {
        if (!create) return null;
        while ((rows as AnswerValue[]).length < f.row)
          (rows as AnswerValue[]).push({} as AnswerValue);
        row = (rows as AnswerValue[])[f.row - 1]!;
      }
      obj = row as Record<string, AnswerValue>;
    }
    return obj;
  }

  private write(frames: Frame[], name: string, value: AnswerValue) {
    const c = this.container(frames, value !== null);
    if (c) {
      if (value === null) delete c[name];
      else c[name] = value;
    }
    const info = own(this.compiled.vars, name);
    this.invalidate(info?.rosterChain[0] ?? name);
  }

  private invalidate(root: string) {
    for (const n of own(this.compiled.dependents, root) ?? []) this.cache.delete(n);
  }

  private cached(node: CompiledNode, slot: string, expr: CompiledExpr, frames: Frame[]): Value {
    if (!expr.ast) return null;
    let m = this.cache.get(node.index);
    if (!m) {
      m = new Map();
      this.cache.set(node.index, m);
    }
    const k = `${slot}|${framesKey(frames)}`;
    if (m.has(k)) return m.get(k)!;
    const v = evaluate(expr.ast, new InterviewScope(this, frames));
    m.set(k, v);
    return v;
  }

  // --- internals: routing walk ----------------------------------------------------

  private rewalk(): ChangeResult {
    const w = this.walk();
    if (this.position !== null && !this.activeKeys.has(this.position)) this.reposition();
    return { ok: true, cleared: w.cleared, restored: w.restored, ended: w.ended };
  }

  /**
   * Walks the questionnaire in document order and decides each node's status. Clearing happens
   * during the walk, so later conditions never see answers that fell off the path.
   */
  private walk(): WalkState {
    const w: WalkState = { entries: [], cleared: [], restored: [], ended: null, skipToEnd: null };
    this.walking = w;
    const roots = this.compiled.nodes.filter((n) => n.parent === null);
    const skip = { target: null as number | null, from: '' };
    for (const n of roots) this.visit(n, [], skip, 0);
    this.walking = null;
    this.trace_ = w.entries;
    this.path_ = w.entries.filter(
      (e) => e.status === 'active' && (e.kind === 'question' || e.kind === 'static'),
    );
    this.activeKeys = new Map(
      w.entries.filter((e) => e.status === 'active').map((e) => [e.key, e]),
    );
    this.ended = w.ended;
    return w;
  }

  private entry(
    node: CompiledNode,
    frames: Frame[],
    status: EntryStatus,
    reason: string,
    depth: number,
  ): TraceEntry {
    const key = node.name ? formatKey(frames, node.name) : formatKey(frames, node.id);
    const e: TraceEntry = { key, id: node.id, kind: node.kind, status, reason, depth, frames };
    this.walking!.entries.push(e);
    return e;
  }

  private visit(
    node: CompiledNode,
    frames: Frame[],
    skip: { target: number | null; from: string },
    depth: number,
  ): void {
    const w = this.walking!;
    if (w.ended)
      return this.off(
        node,
        frames,
        'ended',
        `Interview ended (${w.ended.disposition}) at ${w.ended.byKey}`,
        depth,
      );
    if (w.skipToEnd)
      return this.off(node, frames, 'skipped', `Skipped to end by ${w.skipToEnd}`, depth);
    if (skip.target !== null) {
      if (skip.target === node.index) skip.target = null;
      else if (!(skip.target > node.index && skip.target <= node.end)) {
        return this.off(node, frames, 'skipped', `Skipped by rule on ${skip.from}`, depth);
      }
    }
    if (node.showIf && !truthy(this.cached(node, 'showIf', node.showIf, frames))) {
      if (skip.target !== null && skip.target > node.index && skip.target <= node.end)
        skip.target = null;
      return this.off(node, frames, 'hidden', `Hidden: show if ${node.showIf.src} is false`, depth);
    }
    const variants = (node.def as Question).variants;
    if (variants?.[this.mode]?.visibleInMode === false) {
      return this.off(node, frames, 'notInMode', `Not shown in ${this.mode}`, depth);
    }

    switch (node.kind) {
      case 'section':
      case 'block': {
        this.entry(
          node,
          frames,
          'active',
          node.showIf ? `Shown: ${node.showIf.src} is true` : 'On path',
          depth,
        );
        for (const c of node.children) this.visit(this.compiled.nodes[c]!, frames, skip, depth + 1);
        return;
      }
      case 'roster':
        return this.visitRoster(node, frames, depth);
      case 'question':
        return this.visitQuestion(node, frames, skip, depth);
      case 'computed': {
        this.entry(node, frames, 'active', `Computed: ${node.formula!.src}`, depth);
        const v = this.cached(node, 'formula', node.formula!, frames);
        const value = (isAnswered(v) ? v : null) as AnswerValue;
        const old =
          (this.container(frames, false)?.[node.name!] as AnswerValue | undefined) ?? null;
        if (!jsonEqual(old, value)) {
          this.write(frames, node.name!, value);
          this.events.push({
            key: formatKey(frames, node.name!),
            oldValue: old,
            newValue: value,
            source: 'system',
            reason: 'computed',
          });
        }
        return;
      }
      default:
        this.entry(
          node,
          frames,
          'active',
          node.showIf ? `Shown: ${node.showIf.src} is true` : 'On path',
          depth,
        );
        return;
    }
  }

  private visitRoster(node: CompiledNode, frames: Frame[], depth: number) {
    const r = node.def as Roster;
    const key = formatKey(frames, r.name);
    this.restoreIfMissing(frames, r.name, key);
    const container = this.container(frames, false);
    const existing = Array.isArray(own(container, r.name))
      ? (own(container!, r.name) as AnswerValue[])
      : [];
    let n: number;
    let reason: string;
    if (r.count.type === 'fixed') {
      n = r.count.n;
      reason = `${n} fixed row(s)`;
    } else if (r.count.type === 'expression') {
      const v = toNumber(this.cached(node, 'count', node.rosterCount!, frames));
      n = v === null ? 0 : Math.max(0, Math.min(r.count.max ?? MAX_ROWS, Math.trunc(v)));
      reason = `${n} row(s) from ${r.count.expr}`;
    } else {
      n = Math.min(existing.length, r.count.max ?? MAX_ROWS);
      reason = `${n} row(s) added`;
    }
    this.entry(node, frames, 'active', reason, depth);
    this.resizeRows(frames, r.name, key, existing, n);
    for (let row = 1; row <= n; row++) {
      const rowFrames = [...frames, { name: r.name, row }];
      const rowSkip = { target: null as number | null, from: '' };
      for (const c of node.children)
        this.visit(this.compiled.nodes[c]!, rowFrames, rowSkip, depth + 1);
    }
  }

  private resizeRows(
    frames: Frame[],
    name: string,
    key: string,
    existing: AnswerValue[],
    n: number,
  ) {
    const w = this.walking!;
    if (existing.length === n) return;
    const container = this.container(frames, n > 0)!;
    const rows = existing.slice();
    if (rows.length > n) {
      for (let row = rows.length; row > n; row--) {
        const removed = rows.pop()!;
        const rowKey = `${key}[${row}]`;
        if (removed && typeof removed === 'object' && Object.keys(removed).length > 0) {
          this.stash[rowKey] = removed;
          w.cleared.push({ key: rowKey, value: removed });
          this.events.push({
            key: rowKey,
            oldValue: removed,
            newValue: null,
            source: 'system',
            reason: 'path_change',
          });
        }
      }
    } else {
      for (let row = rows.length + 1; row <= n; row++) {
        const rowKey = `${key}[${row}]`;
        const back = this.stash[rowKey];
        if (back !== undefined) {
          delete this.stash[rowKey];
          rows.push(back);
          w.restored.push({ key: rowKey, value: back });
          this.events.push({
            key: rowKey,
            oldValue: null,
            newValue: back,
            source: 'system',
            reason: 'path_restored',
          });
        } else rows.push({} as AnswerValue);
      }
    }
    if (container) {
      if (rows.length === 0) delete container[name];
      else container[name] = rows as AnswerValue;
    }
    const info = own(this.compiled.vars, name);
    this.invalidate(info?.rosterChain[0] ?? name);
  }

  private visitQuestion(
    node: CompiledNode,
    frames: Frame[],
    skip: { target: number | null; from: string },
    depth: number,
  ) {
    const w = this.walking!;
    const q = node.def as Question;
    const key = formatKey(frames, q.name);
    this.restoreIfMissing(frames, q.name, key);
    this.restoreIfMissing(frames, `${q.name}_OTHER`, formatKey(frames, `${q.name}_OTHER`));

    let value = (this.container(frames, false)?.[q.name] as Value | undefined) ?? null;
    if (!isAnswered(value) && node.prefill && !this.prefilled.has(key)) {
      const v = evaluate(node.prefill.ast!, new InterviewScope(this, frames));
      if (isAnswered(v) && !this.shapeError(node, v as AnswerValue)) {
        this.write(frames, q.name, v as AnswerValue);
        this.prefilled.add(key);
        this.events.push({
          key,
          oldValue: null,
          newValue: v as AnswerValue,
          source: 'system',
          reason: 'prefill',
        });
        value = v;
      }
    }
    this.entry(
      node,
      frames,
      'active',
      node.showIf ? `Shown: ${node.showIf.src} is true` : 'On path',
      depth,
    );
    if (!isAnswered(value)) return;

    for (const rule of node.endIf) {
      if (truthy(this.cached(node, `endIf:${rule.expr.src}`, rule.expr, frames))) {
        w.ended = { disposition: rule.disposition, byKey: key, reason: 'endIf' };
        return;
      }
    }
    if (this.quotas && frames.length === 0) {
      for (const quota of this.compiled.quotas) {
        if (!quota.expr.ast || !quota.expr.refs.includes(q.name)) continue;
        if (
          truthy(evaluate(quota.expr.ast, new InterviewScope(this, []))) &&
          this.quotas.isFull(quota.id)
        ) {
          w.ended = {
            disposition: quota.disposition,
            byKey: key,
            reason: 'quota',
            quotaId: quota.id,
          };
          return;
        }
      }
    }
    for (const s of node.skips) {
      if (!truthy(this.cached(node, `skip:${s.to}:${s.expr.src}`, s.expr, frames))) continue;
      if (s.target === SKIP_END) w.skipToEnd = key;
      else if (s.target === SKIP_END_ROW) {
        skip.target = ROW_END;
        skip.from = key;
      } else if (typeof s.target === 'number') {
        skip.target = s.target;
        skip.from = key;
      }
      return;
    }
  }

  private restoreIfMissing(frames: Frame[], name: string, key: string) {
    const back = this.stash[key];
    if (back === undefined) return;
    const current = this.container(frames, false)?.[name];
    if (current !== undefined && current !== null) return;
    delete this.stash[key];
    this.write(frames, name, back);
    this.walking!.restored.push({ key, value: back });
    this.events.push({
      key,
      oldValue: null,
      newValue: back,
      source: 'system',
      reason: 'path_restored',
    });
  }

  /** Marks a node (and its subtree) off the path and moves its answers to the stash. */
  private off(
    node: CompiledNode,
    frames: Frame[],
    status: EntryStatus,
    reason: string,
    depth: number,
  ) {
    const w = this.walking!;
    this.entry(node, frames, status, reason, depth);
    const clear = (name: string) => {
      const c = this.container(frames, false);
      const v = own(c, name);
      if (v === undefined || v === null) return;
      const key = formatKey(frames, name);
      this.write(frames, name, null);
      if (node.kind !== 'computed') {
        this.stash[key] = v;
        w.cleared.push({ key, value: v });
      }
      this.events.push({
        key,
        oldValue: v,
        newValue: null,
        source: 'system',
        reason: 'path_change',
      });
      delete this.confirmations[key];
    };
    switch (node.kind) {
      case 'question':
        clear(node.name!);
        clear(`${node.name!}_OTHER`);
        return;
      case 'computed':
      case 'roster':
        clear(node.name!);
        return;
      case 'section':
      case 'block':
        for (const c of node.children)
          this.off(this.compiled.nodes[c]!, frames, status, reason, depth + 1);
        return;
      default:
        return;
    }
  }

  private reposition() {
    const firstOpen = this.path_.find(
      (e) => !this.visited.has(e.key) && !isAnswered(this.getAnswer(e.key) as Value),
    );
    this.position = firstOpen?.key ?? this.path_[this.path_.length - 1]?.key ?? null;
  }

  private indexOnPath(key: string | null): number {
    if (key === null) return -1;
    return this.path_.findIndex((e) => e.key === key);
  }

  private rosterAt(rosterKey: string): { frames: Frame[]; node: CompiledNode } {
    const parsed = parseKey(rosterKey);
    const info = parsed ? own(this.compiled.vars, parsed.name) : undefined;
    if (!parsed || !info || info.kind !== 'roster')
      throw new EngineError(`'${rosterKey}' is not a roster`);
    if (!this.activeKeys.has(rosterKey))
      throw new EngineError(`${rosterKey} is not on the current path`);
    return { frames: parsed.frames, node: this.compiled.nodes[info.node]! };
  }

  // --- internals: answer checks ---------------------------------------------------

  private offeredSpecials(q: Question): SpecialKind[] {
    const settings = this.compiled.questionnaire.settings;
    const out: SpecialKind[] = [];
    const offered = (kind: 'DK' | 'RF') =>
      settings.specialCodes[kind].offeredIn.includes(this.mode) ||
      (this.mode === 'CAWI' && settings.cawiShowSpecialCodes);
    if (q.allowDK !== false && offered('DK')) out.push('DK');
    if (q.allowRefused !== false && offered('RF')) out.push('RF');
    return out;
  }

  private visibleOptions(node: CompiledNode, frames: Frame[], key: string): AnswerOption[] {
    const q = node.def as Question;
    let options = questionOptions(q, this.compiled.questionnaire);
    if (node.optionFilter?.ast) {
      const ast = node.optionFilter.ast;
      options = options.filter((o) =>
        truthy(evaluate(ast, new InterviewScope(this, frames, o.code))),
      );
    }
    if (q.randomizeOptions) {
      const rnd = seededRandom(`${this.seed}:${key}`);
      const movable = options.filter((o) => !o.fixedPosition);
      for (let i = movable.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [movable[i], movable[j]] = [movable[j]!, movable[i]!];
      }
      let m = 0;
      options = options.map((o) => (o.fixedPosition ? o : movable[m++]!));
    }
    return options;
  }

  /** Structural check of a value against the question type; rejects malformed input. */
  private shapeError(node: CompiledNode, value: AnswerValue): string | null {
    if (value === null) return null;
    const q = node.def as Question;
    if (isSpecial(value)) {
      if (value.$special === 'NA') return DEFAULT_MESSAGES.special;
      return null; // whether DK/RF is offered is a validation error, not a shape error
    }
    const isCode = (v: unknown) => typeof v === 'number' || typeof v === 'string';
    switch (q.type) {
      case 'single':
      case 'yesno':
        return isCode(value) ? null : 'Expected a single code';
      case 'multi':
      case 'ranking':
        return Array.isArray(value) && value.every(isCode) ? null : 'Expected a list of codes';
      case 'numeric':
      case 'scale':
        return typeof value === 'number' && Number.isFinite(value)
          ? null
          : DEFAULT_MESSAGES.notNumber;
      case 'text':
      case 'time':
        return typeof value === 'string' ? null : 'Expected text';
      case 'date':
      case 'datetime':
        return typeof value === 'string' ? null : DEFAULT_MESSAGES.date;
      case 'grid':
        return value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          Object.values(value).every((v) => isCode(v) || isSpecial(v))
          ? null
          : 'Expected one code per row';
    }
  }

  private builtInChecks(
    node: CompiledNode,
    frames: Frame[],
    value: Value,
  ): { ruleId: string; message: string }[] {
    const q = node.def as Question;
    const out: { ruleId: string; message: string }[] = [];
    const add = (ruleId: string, message: string) => out.push({ ruleId, message });
    if (isSpecial(value)) {
      if (!this.offeredSpecials(q).includes(value.$special))
        add('special', DEFAULT_MESSAGES.special);
      return out;
    }
    const key = formatKey(frames, q.name);
    const options = this.visibleOptions(node, frames, key);
    const inOptions = (c: Value) => options.some((o) => looseEquals(o.code, c));
    switch (q.type) {
      case 'single':
      case 'yesno':
        if (!inOptions(value)) add('invalid_code', DEFAULT_MESSAGES.invalidCode);
        break;
      case 'multi': {
        const arr = value as Value[];
        if (!arr.every(inOptions)) add('invalid_code', DEFAULT_MESSAGES.invalidCode);
        if (new Set(arr.map(String)).size !== arr.length)
          add('invalid_code', 'Each option can be selected once');
        if (q.minSelections !== undefined && arr.length < q.minSelections)
          add('min_selections', DEFAULT_MESSAGES.minSel(q.minSelections));
        if (q.maxSelections !== undefined && arr.length > q.maxSelections)
          add('max_selections', DEFAULT_MESSAGES.maxSel(q.maxSelections));
        const exclusive = options.filter((o) => o.exclusive).map((o) => o.code);
        if (arr.length > 1 && arr.some((c) => exclusive.some((e) => looseEquals(e, c))))
          add('exclusive', DEFAULT_MESSAGES.exclusive);
        break;
      }
      case 'ranking': {
        const arr = value as Value[];
        if (!arr.every(inOptions) || new Set(arr.map(String)).size !== arr.length)
          add('ranking', DEFAULT_MESSAGES.ranking);
        break;
      }
      case 'numeric': {
        const n = value as number;
        const decimals = q.decimals ?? 0;
        if (decimals === 0 && !Number.isInteger(n)) add('integer', DEFAULT_MESSAGES.integer);
        else if (
          decimals > 0 &&
          Math.abs(Math.round(n * 10 ** decimals) - n * 10 ** decimals) > 1e-6
        ) {
          add('decimals', DEFAULT_MESSAGES.decimals(decimals));
        }
        if (q.min !== undefined && n < q.min) add('min', DEFAULT_MESSAGES.min(q.min));
        if (q.max !== undefined && n > q.max) add('max', DEFAULT_MESSAGES.max(q.max));
        break;
      }
      case 'scale': {
        const n = value as number;
        const min = q.scale?.min ?? q.min ?? (q.scale?.style === 'nps' ? 0 : undefined);
        const max = q.scale?.max ?? q.max ?? (q.scale?.style === 'nps' ? 10 : undefined);
        if (min !== undefined && n < min) add('min', DEFAULT_MESSAGES.min(min));
        if (max !== undefined && n > max) add('max', DEFAULT_MESSAGES.max(max));
        const step = q.scale?.step ?? 1;
        if (min !== undefined && Math.abs((n - min) / step - Math.round((n - min) / step)) > 1e-9)
          add('step', `Use steps of ${step}`);
        break;
      }
      case 'text': {
        const s = value as string;
        if (q.maxLength !== undefined && s.length > q.maxLength)
          add('max_length', DEFAULT_MESSAGES.maxLength(q.maxLength));
        if (q.pattern !== undefined) {
          let re: RegExp | null = null;
          try {
            re = new RegExp(`^(?:${q.pattern})$`, 'u');
          } catch {
            re = null;
          }
          if (re && !re.test(s)) add('pattern', DEFAULT_MESSAGES.pattern);
        }
        break;
      }
      case 'time':
        if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value as string))
          add('time', 'Enter a valid time (HH:MM)');
        break;
      case 'date':
      case 'datetime': {
        const ms = parseIsoDate(value);
        if (ms === null || (q.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value as string))) {
          add('date', DEFAULT_MESSAGES.date);
          break;
        }
        const bound = (
          lit: string | undefined,
          expr: CompiledExpr | undefined,
          slot: string,
        ): Value => (expr ? this.cached(node, slot, expr, frames) : (lit ?? null));
        const min = bound(q.minDate, node.minDate, 'minDate');
        const max = bound(q.maxDate, node.maxDate, 'maxDate');
        const minMs = parseIsoDate(min);
        const maxMs = parseIsoDate(max);
        if (minMs !== null && ms < minMs) add('min_date', DEFAULT_MESSAGES.min(min));
        if (maxMs !== null && ms > maxMs) add('max_date', DEFAULT_MESSAGES.max(max));
        break;
      }
      case 'grid': {
        const obj = value as Record<string, Value>;
        const rows = q.rows ?? [];
        for (const [row, code] of Object.entries(obj)) {
          if (!rows.some((r) => String(r.code) === row)) add('grid_row', `Unknown row ${row}`);
          else if (!isSpecial(code) && !inOptions(code))
            add('invalid_code', DEFAULT_MESSAGES.invalidCode);
        }
        if (q.required !== false && rows.some((r) => !isAnswered(obj[String(r.code)] ?? null)))
          add('grid_rows', DEFAULT_MESSAGES.gridRow);
        break;
      }
    }
    return out;
  }

  private syncOtherSpecify(
    node: CompiledNode,
    frames: Frame[],
    value: AnswerValue,
    source: AnswerSourceKind,
  ) {
    const q = node.def as Question;
    const others = (q.options ?? []).filter((o) => o.otherSpecify);
    if (others.length === 0) return;
    const selected = Array.isArray(value) ? value : [value];
    const stillOther = others.some((o) => selected.some((v) => looseEquals(v as Value, o.code)));
    const otherName = `${q.name}_OTHER`;
    const current = this.container(frames, false)?.[otherName];
    if (!stillOther && current !== undefined && current !== null) {
      this.write(frames, otherName, null);
      this.events.push({
        key: formatKey(frames, otherName),
        oldValue: current,
        newValue: null,
        source,
      });
    }
  }
}

// ---------------------------------------------------------------------------

export function createInterview(
  compiled: CompiledQuestionnaire,
  opts: InterviewOptions,
): InterviewSession {
  return new InterviewSession(compiled, opts);
}

export interface VerificationResult {
  match: boolean;
  serverPath: string[];
  /** On the client path but not the server's. */
  unexpected: string[];
  /** On the server path but missing from the client's. */
  missing: string[];
  /** Answers the server would clear (off its path). */
  offPathAnswers: string[];
}

/**
 * Server-side re-run on submit: replays the submitted answers and compares the resulting path
 * with the one the client reported. Any mismatch is flagged for review.
 */
export function verifySubmission(
  compiled: CompiledQuestionnaire,
  opts: Omit<InterviewOptions, 'state'>,
  answers: Answers,
  clientPath: string[],
): VerificationResult {
  const session = new InterviewSession(compiled, { ...opts, state: { answers } });
  const serverPath = session.pathKeys();
  const server = new Set(serverPath);
  const client = new Set(clientPath);
  const offPath = session
    .drainEvents()
    .filter((e) => e.reason === 'path_change')
    .map((e) => e.key);
  const unexpected = clientPath.filter((k) => !server.has(k));
  const missing = serverPath.filter((k) => !client.has(k));
  return {
    match: unexpected.length === 0 && missing.length === 0 && offPath.length === 0,
    serverPath,
    unexpected,
    missing,
    offPathAnswers: offPath,
  };
}

// ---------------------------------------------------------------------------

function fail(error: string): ChangeResult {
  return { ok: false, error, cleared: [], restored: [], ended: null };
}

function normaliseEmpty(v: AnswerValue): AnswerValue {
  if (v === '' || (Array.isArray(v) && v.length === 0)) return null;
  return v;
}

function pickLanguage(text: LocalizedText, lang: string, fallback: string): string | null {
  return text[lang] ?? text[fallback] ?? Object.values(text)[0] ?? null;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function structuredCloneJson<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
