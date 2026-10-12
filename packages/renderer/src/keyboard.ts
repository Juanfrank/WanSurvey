/**
 * Resolves digits typed in quick succession to an option code. `wait` means a longer code
 * could still match, so the runner keeps listening briefly before giving up.
 */
export function matchTypedCode(
  buffer: string,
  codes: readonly (string | number)[],
): { code: string | number | null; wait: boolean } {
  const exact = codes.find((c) => String(c) === buffer) ?? null;
  const longer = codes.some((c) => String(c) !== buffer && String(c).startsWith(buffer));
  return { code: exact, wait: longer };
}

/** True when the key event comes from a field where digits and Enter mean typing. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return !['radio', 'checkbox', 'button', 'submit', 'range'].includes(el.type);
  }
  return el.isContentEditable;
}

export const TYPED_CODE_TIMEOUT_MS = 700;
