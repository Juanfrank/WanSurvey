import { YES_NO_OPTIONS } from '@wansurvey/logic';
import { pick } from '@wansurvey/renderer';
import type { Code, Question } from '@wansurvey/schema';
import { flatten, isSection, type Draft, type TreeNode } from './tree.js';

export interface VarOption {
  name: string;
  /** Item id (equal to the name for questions created in the designer). */
  id: string;
  kind: 'question' | 'computed' | 'roster';
  questionType?: Question['type'];
  /** Short text to recognise it by. */
  text: string;
  codes?: { code: Code; label: string }[];
  numeric: boolean;
}

/** Variables a condition can refer to, in questionnaire order. */
export function variablesOf(draft: Draft, lang: string): VarOption[] {
  const out: VarOption[] = [];
  for (const { node } of flatten(draft)) {
    if (isSection(node)) continue;
    if (node.kind === 'question') {
      const opts =
        node.options && node.options.length
          ? node.options
          : node.answerSetId
            ? (draft.answerSets?.[node.answerSetId] ?? [])
            : node.type === 'yesno'
              ? YES_NO_OPTIONS
              : [];
      out.push({
        name: node.name,
        id: node.id,
        kind: 'question',
        questionType: node.type,
        text: pick(node.text, lang) ?? '',
        ...(opts.length
          ? { codes: opts.map((o) => ({ code: o.code, label: pick(o.label, lang) ?? '' })) }
          : {}),
        numeric: node.type === 'numeric' || node.type === 'scale',
      });
    } else if (node.kind === 'computed') {
      out.push({
        name: node.name,
        id: node.id,
        kind: 'computed',
        text: node.formula,
        numeric: node.valueType === 'number',
      });
    } else if (node.kind === 'roster') {
      out.push({
        name: node.name,
        id: node.id,
        kind: 'roster',
        text: pick(node.title, lang) ?? '',
        numeric: false,
      });
    }
  }
  return out;
}

/** Short label of a node for lists and pickers. */
export function nodeLabel(node: TreeNode, lang: string): string {
  if (isSection(node)) return pick(node.title, lang) ?? '';
  switch (node.kind) {
    case 'question':
    case 'static':
      return pick(node.text, lang) ?? '';
    case 'computed':
      return node.formula;
    case 'block':
    case 'roster':
      return pick(node.title, lang) ?? '';
    case 'pagebreak':
      return '';
  }
}

/** Display name: variable name for data items, id otherwise. */
export function nodeName(node: TreeNode): string {
  return 'name' in node && typeof node.name === 'string' ? node.name : node.id;
}
