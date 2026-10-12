import { Questionnaire, type ContainerItem, type QuestionnaireInput } from '@wansurvey/schema';

export const en = (s: string) => ({ en: s });

export function single(id: string, extra: Record<string, unknown> = {}): ContainerItem {
  return {
    kind: 'question',
    id,
    name: id,
    type: 'single',
    text: en(id),
    options: [
      { code: 1, label: en('One') },
      { code: 2, label: en('Two') },
    ],
    ...extra,
  } as ContainerItem;
}

export function num(id: string, extra: Record<string, unknown> = {}): ContainerItem {
  return {
    kind: 'question',
    id,
    name: id,
    type: 'numeric',
    text: en(id),
    ...extra,
  } as ContainerItem;
}

export function q(items: ContainerItem[], extra: Partial<QuestionnaireInput> = {}): Questionnaire {
  return Questionnaire.parse({
    id: 'T',
    title: en('Test'),
    defaultLanguage: 'en',
    languages: ['en'],
    sections: [{ id: 'S1', title: en('S1'), items }],
    ...extra,
  });
}
