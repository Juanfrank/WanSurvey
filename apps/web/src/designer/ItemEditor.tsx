import * as Tabs from '@radix-ui/react-tabs';
import {
  QUESTION_TYPES,
  type Block,
  type Computed,
  type ContainerItem,
  type Question,
  type QuestionType,
  type Roster,
  type Section,
  type StaticText,
} from '@wansurvey/schema';
import { useEffect, useRef, useState, type ReactNode } from 'react';
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
import { PIPE_EXAMPLES } from './i18n.js';
import { OptionsEditor } from './OptionsEditor.js';
import {
  isSection,
  locate,
  renameVariable,
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
          <h2 className="text-lg font-semibold">{t('designer.kind.pagebreak')}</h2>
          <Hint>{t('designer.pagebreakHelp')}</Hint>
          <NameField {...props} node={node} />
        </div>
      );
  }
}

type Patch = <T extends TreeNode>(p: Partial<T>, coalesce?: string) => void;

/** Variable name (or id): checked for format and clashes; renaming updates every reference. */
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
  return (
    <div ref={ref}>
      <TextField
        label={label}
        mono
        value={current}
        hint={hasName ? t('designer.renameHelp') : undefined}
        error={error}
        onCommit={(next) => {
          const name = next.trim();
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
        }}
      />
    </div>
  );
}

function Heading({ kind, name }: { kind: string; name: string }) {
  return (
    <h2 className="flex items-baseline gap-2 text-lg font-semibold">
      <span>{kind}</span>
      <span className="font-mono text-base text-slate-500">{name}</span>
    </h2>
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
      <Heading kind={t('designer.kind.section')} name={props.node.id} />
      <NameField {...props} node={props.node} />
      <LocalizedField
        label={t('designer.title')}
        value={props.node.title}
        languages={langs}
        onChange={(title) => props.patch<Section>({ title: title ?? {} }, 'title')}
      />
      <ShowIf {...props} value={props.node.showIf} />
    </div>
  );
}

function BlockEditor(props: EditorProps & { node: Block; patch: Patch }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <Heading kind={t('designer.kind.block')} name={props.node.id} />
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
      <Heading kind={t('designer.kind.roster')} name={props.node.name} />
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
      <Heading kind={t('designer.kind.computed')} name={props.node.name} />
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
          <Heading kind={t('designer.kind.static')} name={props.node.id} />
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
      <Heading kind={t(`designer.type.${q.type}`)} name={q.name} />
      <NameField {...props} node={q} />
      <SelectField
        label={t('designer.questionType')}
        value={q.type}
        options={QUESTION_TYPES.map((x) => ({ value: x, label: t(`designer.type.${x}`) }))}
        onChange={changeType}
      />
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
