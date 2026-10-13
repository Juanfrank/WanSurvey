/* global URL, process, console */
// What a web respondent downloads before the first question (H6): the app entry and the
// respondent route with everything they import statically, JavaScript and CSS, gzipped.
// Fails when over budget, so growth is a decision rather than an accident.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST = new URL('../dist/', import.meta.url).pathname;
const BUDGET_KB = Number(process.env.RESPONDENT_BUDGET_KB ?? 240);
// Chunks by name: the respondent page is shared by invitation and open links.
const ROUTES = ['RespondentPage', 'OpenLinkPage'];

const manifest = JSON.parse(readFileSync(join(DIST, '.vite/manifest.json'), 'utf8'));
const entry = Object.keys(manifest).find((k) => manifest[k].isEntry);
const size = (file) => gzipSync(readFileSync(join(DIST, file))).length;

let failed = false;
for (const route of ROUTES) {
  const key = Object.keys(manifest).find((k) => manifest[k].name === route);
  if (!key) throw new Error(`${route} is not a chunk; update the route list`);
  const files = new Set();
  const walk = (key) => {
    const chunk = manifest[key];
    if (!chunk || files.has(chunk.file)) return;
    files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const dep of chunk.imports ?? []) walk(dep);
  };
  walk(entry);
  walk(key);
  const total = [...files].reduce((n, f) => n + size(f), 0) / 1024;
  const ok = total <= BUDGET_KB;
  failed ||= !ok;
  console.log(
    `${ok ? 'ok  ' : 'OVER'} ${route}: ${total.toFixed(1)} KB gzipped (budget ${BUDGET_KB} KB, ${files.size} files)`,
  );
}
process.exit(failed ? 1 : 0);
