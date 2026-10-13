import {
  own,
  questionOptions,
  type CompiledNode,
  type CompiledQuestionnaire,
} from '@wansurvey/logic';
import {
  SKIP_END,
  SKIP_END_ROW,
  type Question,
  type Roster,
  type Section,
  type StaticText,
} from '@wansurvey/schema';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { describeCondition, type DescribeContext } from './describe.js';
import { RENDERER_NS } from './i18n.js';
import { pick } from './text.js';

export interface PaperFormProps {
  compiled: CompiledQuestionnaire;
  lang: string;
}

/** Pipes cannot be resolved on paper: `{{NAME}}` becomes «NAME», conditional text shows both forms. */
export function paperText(src: string): string {
  return src
    .replace(/\{\{#if [^}]*\}\}([\s\S]*?)\{\{else\}\}([\s\S]*?)\{\{\/if\}\}/g, '[$1 / $2]')
    .replace(/\{\{#if [^}]*\}\}([\s\S]*?)\{\{\/if\}\}/g, '[$1]')
    .replace(
      /\{\{\s*([^}|]+?)\s*(\|[^}]*)?\}\}/g,
      (_m, expr: string) => `«${expr.replace(/^roster\./, '')}»`,
    );
}

/**
 * The questionnaire as a printable paper form (PAPI): numbered questions, codes beside
 * options, routing printed as instructions, rosters repeated.
 */
export function PaperForm({ compiled, lang }: PaperFormProps) {
  const { t } = useTranslation(RENDERER_NS);
  const q = compiled.questionnaire;

  // Paper numbers in document order, for questions visible in PAPI.
  const numbers = new Map<string, string>();
  let n = 0;
  for (const node of compiled.nodes) {
    if (node.kind !== 'question') continue;
    if ((node.def as Question).variants?.PAPI?.visibleInMode === false) continue;
    numbers.set(node.id, `Q${++n}`);
  }
  const numberOfVar = (name: string) => {
    const info = own(compiled.vars, name);
    return info ? (numbers.get(compiled.nodes[info.node]!.id) ?? name) : name;
  };

  const ctx: DescribeContext = {
    ref: numberOfVar,
    label: (name, code) => {
      const info = own(compiled.vars, name);
      if (!info || info.kind !== 'question') return null;
      const def = compiled.nodes[info.node]!.def as Question;
      const o = questionOptions(def, q).find((x) => String(x.code) === String(code));
      return o ? (pick(o.label, lang) ?? null) : null;
    },
    t: (key, vars) => t(key, vars),
  };

  const targetText = (target: number | string | null): string => {
    if (target === SKIP_END) return t('paper.toEnd');
    if (target === SKIP_END_ROW) return t('paper.endOfRow');
    if (typeof target !== 'number') return '?';
    const node = compiled.nodes[target]!;
    if (node.kind === 'question') return numbers.get(node.id) ?? node.id;
    if (node.kind === 'section') return pick((node.def as Section).title, lang) ?? node.id;
    // Block/roster: its first question.
    const first = compiled.nodes.slice(node.index, node.end + 1).find((x) => numbers.has(x.id));
    return first ? numbers.get(first.id)! : node.id;
  };

  const specialCodes = Object.entries(q.settings.specialCodes).filter(
    ([kind, cfg]) => kind !== 'NA' && cfg.offeredIn.includes('PAPI'),
  );

  const routing = (node: CompiledNode) => (
    <>
      {node.skips.map((s, i) =>
        s.expr.ast ? (
          <p key={`s${i}`} className="paper-route font-semibold">
            {t('paper.ifGoTo', {
              condition: describeCondition(s.expr.ast, ctx),
              target: targetText(s.target),
            })}
          </p>
        ) : null,
      )}
      {node.endIf.map((e, i) =>
        e.expr.ast ? (
          <p key={`e${i}`} className="paper-route font-semibold">
            {t('paper.ifEnd', {
              condition: describeCondition(e.expr.ast, ctx),
              disposition: e.disposition,
            })}
          </p>
        ) : null,
      )}
    </>
  );

  const askIf = (node: CompiledNode) =>
    node.showIf?.ast ? (
      <p className="paper-askif italic">
        {t('paper.askIf', { condition: describeCondition(node.showIf.ast, ctx) })}
      </p>
    ) : null;

  const boxes = (count: number, label: string) => (
    <span className="paper-boxes inline-flex" role="img" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="inline-block size-7 border border-slate-800" />
      ))}
    </span>
  );

  const answerArea = (def: Question): ReactNode => {
    const options = questionOptions(def, q);
    const optionList = (hint: string) => (
      <>
        <p className="text-sm italic">{hint}</p>
        <ul className="paper-options ml-4">
          {options.map((o) => (
            <li key={String(o.code)} className="flex gap-3">
              <span className="w-10 text-right font-mono font-semibold">{o.code}</span>
              <span>{pick(o.label, lang)}</span>
              {o.otherSpecify ? (
                <span className="flex-1 border-b border-dotted border-slate-800" />
              ) : null}
            </li>
          ))}
        </ul>
      </>
    );
    switch (def.type) {
      case 'single':
      case 'yesno':
        return optionList(t('paper.selectOne'));
      case 'multi':
        return optionList(t('paper.selectAll'));
      case 'numeric': {
        const digits = Math.max(2, String(Math.trunc(Math.abs(def.max ?? 9999))).length);
        return (
          <p className="flex items-center gap-2">
            {boxes(digits, t('paper.writeNumber'))}
            {def.decimals ? (
              <>
                <span>{(1.5).toLocaleString(lang).charAt(1)}</span>
                {boxes(def.decimals, t('paper.writeNumber'))}
              </>
            ) : null}
            {def.unit ? <span>{pick(def.unit, lang)}</span> : null}
          </p>
        );
      }
      case 'text':
        return (
          <div aria-label={t('paper.writeIn')} role="img" className="flex flex-col gap-5 pt-3">
            {Array.from({ length: (def.maxLength ?? 0) > 120 ? 3 : 1 }, (_, i) => (
              <span key={i} className="block border-b border-slate-800" />
            ))}
          </div>
        );
      case 'date':
      case 'datetime':
        return (
          <p className="font-mono">
            __ / __ / ____ <span className="ml-2 text-sm">({t('paper.dateFormat')})</span>
            {def.type === 'datetime' ? <span className="ml-4">__ : __</span> : null}
          </p>
        );
      case 'time':
        return (
          <p className="font-mono">
            __ : __ <span className="ml-2 text-sm">({t('paper.timeFormat')})</span>
          </p>
        );
      case 'scale': {
        const s = def.scale!;
        const points: number[] = [];
        for (
          let v = s.min;
          v <= s.max;
          v += s.step ?? (s.style === 'slider' ? Math.max(1, (s.max - s.min) / 10) : 1)
        ) {
          points.push(Math.round(v));
        }
        return (
          <div>
            <p className="flex flex-wrap gap-3 font-mono font-semibold">
              {points.map((v) => (
                <span key={v}>{v}</span>
              ))}
            </p>
            <p className="flex justify-between text-sm">
              <span>{pick(s.minLabel, lang)}</span>
              <span>{pick(s.maxLabel, lang)}</span>
            </p>
          </div>
        );
      }
      case 'grid':
        return (
          <table className="paper-grid border-collapse text-sm">
            <thead>
              <tr>
                <td />
                {options.map((o) => (
                  <th
                    key={String(o.code)}
                    scope="col"
                    className="border border-slate-800 px-2 py-1"
                  >
                    {pick(o.label, lang)} <span className="font-mono">({o.code})</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(def.rows ?? []).map((r) => (
                <tr key={String(r.code)}>
                  <th scope="row" className="border border-slate-800 px-2 py-1 text-left">
                    {pick(r.label, lang)}
                  </th>
                  {options.map((o) => (
                    <td
                      key={String(o.code)}
                      className="border border-slate-800 px-2 py-1 text-center font-mono"
                    >
                      {o.code}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        );
      case 'ranking':
        return (
          <>
            <p className="text-sm italic">{t('paper.rankHint')}</p>
            <ul className="ml-4">
              {options.map((o) => (
                <li key={String(o.code)} className="flex items-center gap-3">
                  {boxes(1, t('paper.writeNumber'))}
                  <span>{pick(o.label, lang)}</span>
                </li>
              ))}
            </ul>
          </>
        );
    }
  };

  const renderNode = (index: number): ReactNode => {
    const node = compiled.nodes[index]!;
    switch (node.kind) {
      case 'section': {
        const def = node.def as Section;
        return (
          <section key={node.id} className="paper-section flex flex-col gap-5">
            <h2 className="border-b-2 border-slate-800 pb-1 text-xl font-bold">
              {pick(def.title, lang)}
            </h2>
            {askIf(node)}
            {node.children.map(renderNode)}
          </section>
        );
      }
      case 'block':
        return (
          <div key={node.id} className="flex flex-col gap-5">
            {askIf(node)}
            {node.children.map(renderNode)}
          </div>
        );
      case 'roster': {
        const def = node.def as Roster;
        const rows = def.count.type === 'fixed' ? def.count.n : Math.min(def.count.max ?? 10, 10);
        const childQs = compiled.nodes
          .slice(node.index + 1, node.end + 1)
          .filter(
            (x) => x.kind === 'question' && x.rosterChain.at(-1) === def.name && numbers.has(x.id),
          );
        return (
          <div
            key={node.id}
            className="paper-roster flex flex-col gap-4 rounded border-2 border-slate-800 p-3"
          >
            <h3 className="font-bold">{pick(def.title, lang) ?? def.name}</h3>
            {askIf(node)}
            <p className="text-sm italic">{t('paper.rosterRows', { n: String(rows) })}</p>
            {node.children.map(renderNode)}
            <table className="border-collapse text-sm">
              <thead>
                <tr>
                  <th scope="col" className="border border-slate-800 px-2 py-1">
                    #
                  </th>
                  {childQs.map((c) => (
                    <th key={c.id} scope="col" className="border border-slate-800 px-2 py-1">
                      {numbers.get(c.id)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: rows }, (_, r) => (
                  <tr key={r}>
                    <th scope="row" className="border border-slate-800 px-2 py-1">
                      {r + 1}
                    </th>
                    {childQs.map((c) => (
                      <td key={c.id} className="h-8 min-w-16 border border-slate-800" />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      case 'question': {
        const def = node.def as Question;
        if (def.variants?.PAPI?.visibleInMode === false) return null;
        const variant = def.variants?.PAPI;
        const text = pick(variant?.text ?? def.text, lang) ?? '';
        const instruction = pick(variant?.interviewerInstruction, lang);
        return (
          <div
            key={node.id}
            className="paper-question flex gap-3 break-inside-avoid"
            data-paper-q={numbers.get(node.id)}
          >
            <span className="w-12 shrink-0 font-bold">{numbers.get(node.id)}</span>
            <div className="flex flex-1 flex-col gap-2">
              {askIf(node)}
              <p className="font-medium">{paperText(text)}</p>
              {instruction ? (
                <p className="text-sm font-semibold uppercase">{instruction}</p>
              ) : null}
              {answerArea(def)}
              {(() => {
                const offered = specialCodes.filter(
                  ([kind]) =>
                    !(kind === 'DK' && def.allowDK === false) &&
                    !(kind === 'RF' && def.allowRefused === false),
                );
                return offered.length ? (
                  <p className="flex gap-4 text-sm">
                    {offered.map(([kind, cfg]) => (
                      <span key={kind}>
                        <span className="font-mono font-semibold">{cfg.code}</span>{' '}
                        {pick(cfg.label, lang)}
                      </span>
                    ))}
                  </p>
                ) : null;
              })()}
              {routing(node)}
            </div>
          </div>
        );
      }
      case 'static': {
        const def = node.def as StaticText;
        const text = pick(def.variants?.PAPI?.text ?? def.text, lang) ?? '';
        return (
          <p key={node.id} className="paper-static italic">
            {paperText(text)}
          </p>
        );
      }
      case 'pagebreak':
        return <hr key={node.id} className="paper-pagebreak break-after-page border-dashed" />;
      default:
        return null;
    }
  };

  return (
    <article className="paper mx-auto flex max-w-3xl flex-col gap-6 bg-white p-8 font-serif text-slate-900 print:p-0">
      <header>
        <h1 className="text-2xl font-bold">{pick(q.title, lang)}</h1>
        <p className="text-sm italic">{t('paper.interviewerCopy')}</p>
      </header>
      {compiled.nodes.filter((x) => x.parent === null).map((x) => renderNode(x.index))}
    </article>
  );
}
