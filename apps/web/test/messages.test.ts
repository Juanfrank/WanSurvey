import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { messagesEn, messagesEs } from '../src/messages-i18n.js';

const logic = (file: string) =>
  readFileSync(resolve(process.cwd(), '../../packages/logic/src', file), 'utf8');

const MSG_ID = /\bid: '([a-z_]+)'/g;
/** The analyzer's question checks use their code as the message id. */
const QUESTION_ERR = /\berr\('([a-z_]+)'/g;
/** So do the model's problems. */
const MODEL_CODE = /\bcode: '([a-z_]+)'/g;

/** Every message id the given source files can produce. */
function idsIn(files: string[], pattern = MSG_ID): string[] {
  const ids = new Set<string>();
  for (const f of files) for (const m of logic(f).matchAll(pattern)) ids.add(m[1]!);
  return [...ids].sort();
}

describe('message catalogues', () => {
  const groups = {
    diag: [
      ...idsIn(['typecheck.ts', 'analyzer.ts']),
      ...idsIn(['analyzer.ts'], QUESTION_ERR),
      ...idsIn(['model.ts'], MODEL_CODE),
    ],
    scenarioCheck: idsIn(['scenario.ts']),
    mappingMsg: idsIn(['diff.ts']),
  } as const;

  for (const [group, ids] of Object.entries(groups) as [keyof typeof groups, string[]][]) {
    it(`has English and Spanish text for every ${group} id`, () => {
      expect(ids.length).toBeGreaterThan(3);
      const en = messagesEn[group] as Record<string, string>;
      const es = messagesEs[group] as Record<string, string>;
      expect(ids.filter((id) => !en[id])).toEqual([]);
      expect(ids.filter((id) => !es[id])).toEqual([]);
    });
  }

  it('has the same keys in both languages', () => {
    for (const group of ['diag', 'scenarioCheck', 'mappingMsg', 'apiError'] as const)
      expect(Object.keys(messagesEs[group]).sort()).toEqual(Object.keys(messagesEn[group]).sort());
  });
});
