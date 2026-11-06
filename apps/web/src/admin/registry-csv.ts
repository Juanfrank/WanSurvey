/** Splits one line of a delimited file, with quotes ("" inside a quoted cell is a quote). */
function cells(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * A delimited text (comma, semicolon or tab, from the header line) as rows keyed by the header
 * names in lower case. Cells with line breaks are not supported; the files of the registry are one
 * line per person.
 */
export function parseTable(text: string): Record<string, string>[] {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    .split(/\r?\n/)
    .filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0]!;
  const sep = [',', ';', '\t'].reduce((best, s) =>
    head.split(s).length > head.split(best).length ? s : best,
  );
  const names = cells(head, sep).map((h) => h.toLowerCase());
  return lines.slice(1).map((l) => {
    const row = cells(l, sep);
    return Object.fromEntries(names.map((n, i) => [n, row[i] ?? '']));
  });
}

/** The first non-empty cell among the names the column may go by; undefined when none. */
export function pick(row: Record<string, string>, names: string[]): string | undefined {
  for (const n of names) if (row[n]) return row[n];
  return undefined;
}
