/** Removes underscores from both ends, in one pass (a regular expression for it can be quadratic). */
export function trimUnderscores(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === '_') start++;
  while (end > start && s[end - 1] === '_') end--;
  return s.slice(start, end);
}

/** The text before the first `[` (a variable's name without its roster position). */
export function beforeBracket(s: string): string {
  const i = s.indexOf('[');
  return i < 0 ? s : s.slice(0, i);
}
