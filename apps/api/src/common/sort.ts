/** Orders texts by code unit: the same as `.sort()` without arguments, but explicit and locale-free. */
export const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
