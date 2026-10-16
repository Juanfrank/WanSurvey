import * as Tabs from '@radix-ui/react-tabs';
import {
  type Block,
  type Computed,
  type ContainerItem,
  type Question,
  type QuestionType,
  type Roster,
  type Section,
  type StaticText,
} from '@wansurvey/schema';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ConditionBuilder } from './ConditionBuilder.js';
import {
  CheckField,
  clean,
  Group,
  Hint,
  LocalizedField,
  NumberField,
  SelectField,
  TextField,
} from './fields.js';
import { ExpressionField, LogicEditor } from './LogicEditor.js';
import { KindIcon, questionMenu } from './kinds.js';
import { below, Menu } from './Menu.js';
import { PIPE_EXAMPLES } from './i18n.js';
import { OptionsEditor } from './OptionsEditor.js';
import { ScriptsEditor } from './Scripts.js';
import {
  isSection,
  locate,
  renameVariable,
  sectionOf,
  sectionRoot,
  updateNode,
  usedNames,
  type Draft,
  type TreeNode,
} from './tree.js';
import { VariantsEditor } from './VariantsEditor.js';
import type { VarOption } from './vars.js';

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CHOICE: QuestionType[] = ['single', 'multi', 'ranking', 'grid'];

export interface EditorProps {
  draft: Draft;
  id: string;
  lang: string;
  variables: VarOption[];
  change(next: Draft, coalesce?: string): void;
  /** Bumped to move focus to the name field (F2 in the outline). */
  focusNameSignal: number;
  /** Renaming can change the item id; the selection follows it. */
  select(id: string): void;
}

const tabCls =
  '-mb-px border-b-2 border-transparent px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-navy data-[state=active]:border-indigo-600 data-[state=active]:font-semibold data-[state=active]:text-indigo-ink-600';

/** Property panel for the node selected in the outline. */
export function ItemEditor(props: EditorProps) {
  const { t } = useTranslation();
  const at = locate(props.draft, props.id);
  if (!at) return <p className="text-sm text-slate-600">{t('designer.nothingSelected')}</p>;
  const node = at.node;
  const patch = <T extends TreeNode>(p: Partial<T>, coalesce?: string) =>
    props.change(
      updateNode(props.draft, props.id, (n) => clean({ ...n, ...p }) as TreeNode),
      coalesce ? `${props.id}:${coalesce}` : undefined,
    );

  if (isSection(node)) return <SectionEditor {...props} node={node} patch={patch} />;
  switch (node.kind) {
    case 'question':
      return <QuestionEditor {...props} node={node} patch={patch} />;
    case 'static':
      return <StaticEditor {...props} node={node} patch={patch} />;
    case 'computed':
      return <ComputedEditor {...props} node={node} patch={patch} />;
    case 'block':
      return <BlockEditor {...props} node={node} patch={patch} />;
    case 'roster':
      return <RosterEditor {...props} node={node} patch={patch} />;
    case 'pagebreak':
      return (
        <div className="flex flex-col gap-3">
          <Hint>{t('designer.pagebreakHelp')}</Hint>
          <NameField {...props} node={node} />
        </div>
      );
  }
}

type Patch = <T extends TreeNode>(p: Partial<T>, coalesce?: string) => void;

/**
 * Variable name (or id): checked for format and clashes; renaming updates every reference.
 * Variables start with the root of their section (A in SEC_A), shown fixed before the part
 * that can be edited; together they are the name.
 */
function NameField({
  draft,
  id,
  node,
  change,
  focusNameSignal,
  select,
}: EditorProps & { node: TreeNode }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [id]);
  // Focus only when F2 is pressed after this editor opened, not when it mounts.
  const signalAtMount = useRef(focusNameSignal);
  useEffect(() => {
    if (focusNameSignal !== signalAtMount.current) ref.current?.querySelector('input')?.focus();
  }, [focusNameSignal]);
  const hasName = 'name' in node && typeof node.name === 'string';
  const current = hasName ? (node as { name: string }).name : node.id;
  const label = hasName ? t('designer.variableName') : t('designer.itemId');
  const section = hasName && !isSection(node) ? sectionOf(draft, id) : null;
  const root = section ? sectionRoot(section) : '';
  const rooted = !root || current.startsWith(root);
  const suffix = root && rooted ? current.slice(root.length) : current;

  const commit = (typed: string) => {
    const name = `${root}${typed.trim()}`;
    if (name === current) return setError(null);
    if (!NAME_RE.test(name)) {
      setError(t('designer.badName'));
      return;
    }
    const used = usedNames(draft);
    used.delete(current);
    used.delete(node.id);
    if (used.has(name)) {
      setError(t('designer.nameTaken', { name }));
      return;
    }
    setError(null);
    if (hasName) {
      const next = renameVariable(draft, id, name);
      change(next);
      if (!locate(next, id)) select(name);
    } else {
      change(updateNode(draft, id, (n) => ({ ...n, id: name })));
      select(name);
    }
  };

  if (!root)
    return (
      <div ref={ref}>
        <TextField
          label={label}
          mono
          value={current}
          hint={hasName ? t('designer.renameHelp') : undefined}
          error={error}
          onCommit={commit}
        />
      </div>
    );
  return (
    <div ref={ref} className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-sm font-medium text-slate-700">
        {label}
      </label>
      <div className="flex items-stretch">
        <span
          className="flex items-center rounded-l-md border border-r-0 border-slate-300 bg-slate-100 px-2.5 font-mono text-sm text-slate-700"
          title={t('designer.rootFixed', { root, section: section!.id })}
          data-testid="name-root"
        >
          {root}
        </span>
        <SuffixInput
          id={inputId}
          value={suffix}
          invalid={!!error}
          describedBy={`${inputId}-hint${error ? ` ${inputId}-err` : ''}`}
          onCommit={commit}
        />
      </div>
      <p id={`${inputId}-hint`} className="text-xs text-slate-600">
        {t('designer.rootHelp', { root, section: section!.id })}{' '}
        {!rooted ? t('designer.rootMissing', { root }) : ''} {t('designer.renameHelp')}
      </p>
      {error ? (
        <p id={`${inputId}-err`} className="text-sm text-red-ink-800">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SuffixInput({
  id,
  value,
  invalid,
  describedBy,
  onCommit,
}: {
  id: string;
  value: string;
  invalid: boolean;
  describedBy: string;
  onCommit(v: string): void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <input
      id={id}
      className="min-w-0 flex-1 rounded-r-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 aria-[invalid=true]:border-red-600"
      value={local}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      autoComplete="off"
      spellCheck={false}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => onCommit(local)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(local);
        }
      }}
    />
  );
}

/** The question type as a menu button: the same grouped list, with icons, as the add button. */
function TypePicker({ value, onChange }: { value: QuestionType; onChange(t: QuestionType): void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <span id={id} className="text-sm font-medium text-slate-700">
        {t('designer.questionType')}
      </span>
      <button
        ref={ref}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-labelledby={`${id} ${id}-v`}
        className="flex w-full items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-left text-sm hover:border-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-60"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
          }
        }}
        data-testid="type-picker"
      >
        <KindIcon k={value} />
        <span id={`${id}-v`} className="flex-1">
          {t(`designer.type.${value}`)}
        </span>
        <span aria-hidden className="text-slate-500">
          ▾
        </span>
      </button>
      {open ? (
        <Menu
          label={t('designer.questionType')}
          entries={questionMenu(t, onChange, value)}
          at={below(ref.current)}
          minWidth={Math.max(240, ref.current?.offsetWidth ?? 0)}
          onClose={() => {
            setOpen(false);
            ref.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

function ShowIf(props: EditorProps & { value: string | undefined; patch: Patch }) {
  const { t } = useTranslation();
  return (
    <ConditionBuilder
      label={t('designer.logic.showIf')}
      hint={t('designer.logic.showIfHelp')}
      value={props.value}
      variables={props.variables}
      onChange={(showIf) => props.patch({ showIf })}
    />
  );
}

function SectionEditor(props: EditorProps & { node: Section; patch: Patch }) {
  const { t } = useTranslation();
  const langs = props.draft.languages;
  return (
    <div className="flex flex-col gap-4">
      <NameField {...props} node={props.node} />
      <LocalizedField
        label={t('designer.title')}
        value={props.node.title}
        languages={langs}
        onChange={(title) => props.patch<Section>({ title: title ?? {} }, 'title')}
      />
      <TextField
        label={t('designer.sectionRoot')}
        mono
        value={sectionRoot(props.node)}
        hint={t('designer.sectionRootHelp')}
        onCommit={(v) => {
          const prefix = v.trim();
          if (prefix && !/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(prefix)) return;
          props.patch<Section>({ prefix: prefix || undefined });
        }}
      />
      <ShowIf {...props} value={props.node.showIf} />
      <ScriptsEditor
        draft={props.draft}
        change={props.change}
        place={{ sectionId: props.node.id }}
        title={t('designer.scriptsHere')}
        hint={t('designer.scriptsSectionHelp')}
      />
    </div>
  );
}

function BlockEditor(props: EditorProps & { node: Block; patch: Patch }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <Hint>{t('designer.blockHelp')}</Hint>
      <NameField {...props} node={props.node} />
      <LocalizedField
        label={t('designer.title')}
        value={props.node.title}
        languages={props.draft.languages}
        keepEmpty={false}
        onChange={(title) => props.patch<Block>({ title }, 'title')}
      />
      <ShowIf {...props} value={props.node.showIf} />
    </div>
  );
}

function RosterEditor(props: EditorProps & { node: Roster; patch: Patch }) {
  const { t } = useTranslation();
  const c = props.node.count;
  const max = c.type === 'fixed' ? undefined : c.max;
  return (
    <div className="flex flex-col gap-4">
      <Hint>{t('designer.rosterHelp')}</Hint>
      <NameField {...props} node={props.node} />
      <LocalizedField
        label={t('designer.title')}
        value={props.node.title}
        languages={props.draft.languages}
        keepEmpty={false}
        onChange={(title) => props.patch<Roster>({ title }, 'title')}
      />
      <Group title={t('designer.roster.count')}>
        <SelectField
          label={t('designer.roster.countType')}
          value={c.type}
          options={[
            { value: 'fixed', label: t('designer.roster.fixed') },
            { value: 'expression', label: t('designer.roster.expression') },
            { value: 'open', label: t('designer.roster.open') },
          ]}
          onChange={(type) =>
            props.patch<Roster>({
              count:
                type === 'fixed'
                  ? { type, n: 3 }
                  : type === 'expression'
                    ? { type, expr: props.variables.find((v) => v.numeric)?.name ?? '1', max: 20 }
                    : { type, max: 20 },
            })
          }
        />
        {c.type === 'fixed' ? (
          <NumberField
            label={t('designer.roster.rows')}
            integer
            value={c.n}
            onChange={(n) => props.patch<Roster>({ count: { type: 'fixed', n: n ?? 0 } })}
          />
        ) : null}
        {c.type === 'expression' ? (
          <ExpressionField
            label={t('designer.roster.fromAnswer')}
            value={c.expr}
            variables={props.variables}
            onChange={(expr) => props.patch<Roster>({ count: { ...c, expr: expr ?? '' } }, 'count')}
          />
        ) : null}
        {c.type !== 'fixed' ? (
          <NumberField
            label={t('designer.roster.max')}
            integer
            value={max}
            onChange={(m) => props.patch<Roster>({ count: clean({ ...c, max: m }) })}
          />
        ) : null}
      </Group>
      <ExpressionField
        label={t('designer.roster.rowLabel')}
        hint={t('designer.roster.rowLabelHelp')}
        value={props.node.rowLabel}
        variables={props.variables}
        onChange={(rowLabel) => props.patch<Roster>({ rowLabel }, 'rowLabel')}
      />
      <ShowIf {...props} value={props.node.showIf} />
    </div>
  );
}

function ComputedEditor(props: EditorProps & { node: Computed; patch: Patch }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <Hint>{t('designer.computedHelp')}</Hint>
      <NameField {...props} node={props.node} />
      <SelectField
        label={t('designer.valueType')}
        value={props.node.valueType}
        options={(['number', 'string', 'boolean', 'date', 'code'] as const).map((v) => ({
          value: v,
          label: t(`designer.valueTypes.${v}`),
        }))}
        onChange={(valueType) => props.patch<Computed>({ valueType })}
      />
      <ExpressionField
        label={t('designer.formula')}
        value={props.node.formula}
        variables={props.variables.filter((v) => v.name !== props.node.name)}
        onChange={(formula) => props.patch<Computed>({ formula: formula ?? '' }, 'formula')}
      />
      <ShowIf {...props} value={props.node.showIf} />
    </div>
  );
}

function StaticEditor(props: EditorProps & { node: StaticText; patch: Patch }) {
  const { t } = useTranslation();
  return (
    <EditorTabs
      basics={
        <>
          <NameField {...props} node={props.node} />
          <SelectField
            label={t('designer.static.role')}
            value={props.node.role ?? 'info'}
            options={(['info', 'instruction', 'consent'] as const).map((r) => ({
              value: r,
              label: t(`designer.static.${r}`),
            }))}
            onChange={(role) =>
              props.patch<StaticText>({ role: role === 'info' ? undefined : role })
            }
          />
          <LocalizedField
            label={t('designer.text')}
            value={props.node.text}
            languages={props.draft.languages}
            multiline
            hint={t('designer.pipingHelp', PIPE_EXAMPLES)}
            onChange={(text) => props.patch<StaticText>({ text: text ?? {} }, 'text')}
          />
          <ScriptsEditor
            draft={props.draft}
            change={props.change}
            place={{ itemId: props.node.id }}
            title={t('designer.scriptsHere')}
            hint={t('designer.scriptsItemHelp')}
          />
        </>
      }
      logic={<ShowIf {...props} value={props.node.showIf} />}
      modes={
        <VariantsEditor
          variants={props.node.variants}
          baseText={props.node.text}
          languages={props.draft.languages}
          modes={props.draft.modes}
          isQuestion={false}
          onChange={(variants) => props.patch<StaticText>({ variants }, 'variants')}
        />
      }
    />
  );
}

function EditorTabs({
  basics,
  logic,
  modes,
}: {
  basics: ReactNode;
  logic: ReactNode;
  modes: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Tabs.Root defaultValue="basics" className="flex flex-col gap-4">
      <Tabs.List
        aria-label={t('designer.editorTabs')}
        className="flex gap-1 border-b border-slate-200"
      >
        <Tabs.Trigger value="basics" className={tabCls}>
          {t('designer.tab.basics')}
        </Tabs.Trigger>
        <Tabs.Trigger value="logic" className={tabCls}>
          {t('designer.tab.logic')}
        </Tabs.Trigger>
        <Tabs.Trigger value="modes" className={tabCls}>
          {t('designer.tab.modes')}
        </Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="basics" className="flex flex-col gap-4">
        {basics}
      </Tabs.Content>
      <Tabs.Content value="logic">{logic}</Tabs.Content>
      <Tabs.Content value="modes">{modes}</Tabs.Content>
    </Tabs.Root>
  );
}

function QuestionEditor(props: EditorProps & { node: Question; patch: Patch }) {
  const { t } = useTranslation();
  const q = props.node;
  const langs = props.draft.languages;
  const answerSets = Object.keys(props.draft.answerSets ?? {});
  const p = (x: Partial<Question>, coalesce?: string) => props.patch<Question>(x, coalesce);

  const changeType = (type: QuestionType) => {
    const next: Partial<Question> = { type };
    const empty = Object.fromEntries(langs.map((l) => [l, '']));
    if (CHOICE.includes(type) && !q.options?.length && !q.answerSetId) {
      next.options = [
        { code: 1, label: { ...empty } },
        { code: 2, label: { ...empty } },
      ];
    }
    if (type === 'grid' && !q.rows?.length) next.rows = [{ code: 1, label: { ...empty } }];
    if (type === 'scale' && !q.scale) next.scale = { style: 'likert', min: 1, max: 5 };
    props.change(
      updateNode(props.draft, props.id, (n) => clean({ ...n, ...next }) as ContainerItem),
    );
  };

  const basics = (
    <>
      <NameField {...props} node={q} />
      <TypePicker value={q.type} onChange={changeType} />
      <LocalizedField
        label={t('designer.wording')}
        value={q.text}
        languages={langs}
        multiline
        hint={t('designer.pipingHelp', PIPE_EXAMPLES)}
        onChange={(text) => p({ text: text ?? {} }, 'text')}
      />
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <CheckField
          label={t('designer.required')}
          checked={q.required !== false}
          onChange={(on) => p({ required: on ? undefined : false })}
        />
        <CheckField
          label={t('designer.allowDK')}
          checked={q.allowDK !== false}
          onChange={(on) => p({ allowDK: on ? undefined : false })}
        />
        <CheckField
          label={t('designer.allowRefused')}
          checked={q.allowRefused !== false}
          onChange={(on) => p({ allowRefused: on ? undefined : false })}
        />
        <CheckField
          label={t('designer.personal')}
          checked={!!q.personal}
          onChange={(on) => p({ personal: on || undefined })}
        />
      </div>

      {CHOICE.includes(q.type) ? (
        <Group title={t('designer.answers')}>
          {answerSets.length ? (
            <SelectField
              label={t('designer.answerSet')}
              value={q.answerSetId ?? ''}
              options={[
                { value: '', label: t('designer.ownOptions') },
                ...answerSets.map((s) => ({ value: s, label: s })),
              ]}
              onChange={(answerSetId) =>
                p(
                  answerSetId
                    ? { answerSetId, options: undefined }
                    : {
                        answerSetId: undefined,
                        options: structuredClone(
                          props.draft.answerSets?.[q.answerSetId ?? ''] ?? [],
                        ),
                      },
                )
              }
            />
          ) : null}
          {!q.answerSetId ? (
            <OptionsEditor
              label={t('designer.options')}
              rows={q.options ?? []}
              languages={langs}
              onChange={(options) => p({ options }, 'options')}
            />
          ) : null}
          {q.type !== 'grid' ? (
            <CheckField
              label={t('designer.randomize')}
              checked={!!q.randomizeOptions}
              onChange={(on) => p({ randomizeOptions: on || undefined })}
            />
          ) : null}
          {q.type === 'multi' ? (
            <div className="grid grid-cols-2 gap-3">
              <NumberField
                label={t('designer.minSelections')}
                integer
                value={q.minSelections}
                onChange={(minSelections) => p({ minSelections })}
              />
              <NumberField
                label={t('designer.maxSelections')}
                integer
                value={q.maxSelections}
                onChange={(maxSelections) => p({ maxSelections })}
              />
            </div>
          ) : null}
        </Group>
      ) : null}

      {q.type === 'grid' ? (
        <OptionsEditor
          label={t('designer.gridRows')}
          rows={q.rows ?? []}
          languages={langs}
          flags={false}
          addLabel={t('designer.opt.addRow')}
          onChange={(rows) => p({ rows }, 'rows')}
        />
      ) : null}

      {q.type === 'numeric' ? (
        <Group title={t('designer.numberRules')}>
          <div className="grid grid-cols-3 gap-3">
            <NumberField label={t('designer.min')} value={q.min} onChange={(min) => p({ min })} />
            <NumberField label={t('designer.max')} value={q.max} onChange={(max) => p({ max })} />
            <NumberField
              label={t('designer.decimals')}
              integer
              value={q.decimals}
              onChange={(decimals) => p({ decimals })}
            />
          </div>
          <LocalizedField
            label={t('designer.unit')}
            value={q.unit}
            languages={langs}
            keepEmpty={false}
            onChange={(unit) => p({ unit }, 'unit')}
          />
          <Hint>{t('designer.softRangeHelp')}</Hint>
        </Group>
      ) : null}

      {q.type === 'text' ? (
        <Group title={t('designer.textRules')}>
          <SelectField
            label={t('designer.textFormat')}
            value={q.format ?? ''}
            options={(['', 'phone', 'email'] as const).map((f) => ({
              value: f,
              label: t(`designer.textFormats.${f || 'plain'}`),
            }))}
            onChange={(format) => p({ format: format || undefined })}
          />
          <NumberField
            label={t('designer.maxLength')}
            integer
            value={q.maxLength}
            onChange={(maxLength) => p({ maxLength })}
          />
          <TextField
            label={t('designer.pattern')}
            mono
            value={q.pattern}
            hint={t('designer.patternHelp')}
            onChange={(pattern) => p({ pattern: pattern || undefined }, 'pattern')}
          />
        </Group>
      ) : null}

      {q.type === 'date' || q.type === 'datetime' ? (
        <Group title={t('designer.dateRules')}>
          <TextField
            label={t('designer.minDate')}
            mono
            value={q.minDate}
            hint={t('designer.dateHelp')}
            onChange={(minDate) => p({ minDate: minDate || undefined }, 'minDate')}
          />
          <TextField
            label={t('designer.maxDate')}
            mono
            value={q.maxDate}
            hint={t('designer.dateHelp')}
            onChange={(maxDate) => p({ maxDate: maxDate || undefined }, 'maxDate')}
          />
          {q.type === 'date' ? (
            <CheckField
              label={t('designer.approximateDate')}
              checked={!!q.approximateDate}
              onChange={(on) => p({ approximateDate: on || undefined })}
            />
          ) : null}
        </Group>
      ) : null}

      {q.type === 'scale' && q.scale ? (
        <Group title={t('designer.scale')}>
          <SelectField
            label={t('designer.scaleStyle')}
            value={q.scale.style}
            options={(['likert', 'nps', 'slider'] as const).map((s) => ({
              value: s,
              label: t(`designer.scaleStyles.${s}`),
            }))}
            onChange={(style) =>
              p({
                scale:
                  style === 'nps'
                    ? { ...q.scale!, style, min: 0, max: 10 }
                    : { ...q.scale!, style },
              })
            }
          />
          {q.scale.style !== 'slider' ? (
            <SelectField
              label={t('designer.palette')}
              value={q.scale.palette ?? ''}
              options={(['', 'diverging', 'sequential', 'nps'] as const).map((v) => ({
                value: v,
                label: t(`designer.palettes.${v || 'none'}`),
              }))}
              onChange={(palette) =>
                p({ scale: clean({ ...q.scale!, palette: palette || undefined }) })
              }
            />
          ) : null}
          <div className="grid grid-cols-3 gap-3">
            <NumberField
              label={t('designer.min')}
              value={q.scale.min}
              onChange={(min) => p({ scale: { ...q.scale!, min: min ?? 0 } })}
            />
            <NumberField
              label={t('designer.max')}
              value={q.scale.max}
              onChange={(max) => p({ scale: { ...q.scale!, max: max ?? 0 } })}
            />
            <NumberField
              label={t('designer.step')}
              value={q.scale.step}
              onChange={(step) => p({ scale: clean({ ...q.scale!, step }) })}
            />
          </div>
          <LocalizedField
            label={t('designer.minLabel')}
            value={q.scale.minLabel}
            languages={langs}
            keepEmpty={false}
            onChange={(minLabel) => p({ scale: clean({ ...q.scale!, minLabel }) }, 'minLabel')}
          />
          <LocalizedField
            label={t('designer.maxLabel')}
            value={q.scale.maxLabel}
            languages={langs}
            keepEmpty={false}
            onChange={(maxLabel) => p({ scale: clean({ ...q.scale!, maxLabel }) }, 'maxLabel')}
          />
        </Group>
      ) : null}
      <ScriptsEditor
        draft={props.draft}
        change={props.change}
        place={{ itemId: q.id }}
        title={t('designer.scriptsHere')}
        hint={t('designer.scriptsItemHelp')}
      />
    </>
  );

  return (
    <EditorTabs
      basics={basics}
      logic={
        <LogicEditor
          node={q}
          draft={props.draft}
          variables={props.variables}
          lang={props.lang}
          onPatch={(x) => p(x, 'logic')}
        />
      }
      modes={
        <VariantsEditor
          variants={q.variants}
          baseText={q.text}
          languages={langs}
          modes={props.draft.modes}
          isQuestion
          onChange={(variants) => p({ variants }, 'variants')}
        />
      }
    />
  );
}
