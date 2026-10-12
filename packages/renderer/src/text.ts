import type { LocalizedText } from '@wansurvey/schema';

/** Text in the active language, falling back to the first available translation. */
export function pick(text: LocalizedText | undefined, lang: string): string | undefined {
  if (!text) return undefined;
  return text[lang] ?? text[lang.split('-')[0]!] ?? Object.values(text)[0];
}

/** DOM-safe id fragment for an answer key such as `HH[2].AGE`. */
export function keyId(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '-');
}
