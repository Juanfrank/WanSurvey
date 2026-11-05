#!/usr/bin/env node
// Releases: one product version (SemVer 2.0.0) for the whole repository, and a CHANGELOG in the
// Keep a Changelog 1.1.0 format. See docs/releasing.md.
//
//   node scripts/release.mjs check                  versions and CHANGELOG agree (run by CI)
//   node scripts/release.mjs bump <major|minor|patch|alpha|beta|rc|release|X.Y.Z[-pre]> [--dry-run]
//                                                   cut a release: versions, CHANGELOG, links
//   node scripts/release.mjs notes [X.Y.Z]          the CHANGELOG section of a release
//                                                   (the latest one by default), for release notes
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The regular expression of semver.org, section "Is there a suggested regular expression". */
export const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

export function parse(version) {
  const m = SEMVER.exec(version);
  if (!m)
    throw new Error(`"${version}" is not a Semantic Version (X.Y.Z, optionally -pre-release)`);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null };
}

/** Precedence, as in SemVer 2.0.0 section 11 (build metadata is ignored). Negative: a < b. */
export function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const p = x.pre.split('.');
  const q = y.pre.split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const n = /^\d+$/.test(p[i]);
    const m = /^\d+$/.test(q[i]);
    if (n && m) {
      if (+p[i] !== +q[i]) return +p[i] - +q[i];
    } else if (n !== m) return n ? -1 : 1;
    else if (p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

export const CHANNELS = ['alpha', 'beta', 'rc'];

/**
 * The next version for `major`, `minor`, `patch`; for a pre-release channel (`alpha`, `beta`,
 * `rc`: the next number of the channel, or the first of a later channel); for `release` (the
 * pre-release becomes its plain version); or an explicit version. Never goes backwards.
 */
export function next(current, how) {
  const c = parse(current);
  const base = `${c.major}.${c.minor}.${c.patch}`;
  let v;
  if (how === 'major') v = `${c.major + 1}.0.0`;
  else if (how === 'minor') v = `${c.major}.${c.minor + 1}.0`;
  else if (how === 'patch') v = `${c.major}.${c.minor}.${c.patch + (c.pre ? 0 : 1)}`;
  else if (how === 'release') {
    if (!c.pre) throw new Error(`${current} is already a release`);
    v = base;
  } else if (CHANNELS.includes(how)) {
    const m = /^(alpha|beta|rc)\.(\d+)$/.exec(c.pre ?? '');
    if (m && m[1] === how) v = `${base}-${how}.${+m[2] + 1}`;
    else if (m && CHANNELS.indexOf(how) > CHANNELS.indexOf(m[1])) v = `${base}-${how}.1`;
    else
      throw new Error(
        `${current} cannot go to ${how}: give an exact version (e.g. ${c.major}.${c.minor + 1}.0-${how}.1)`,
      );
  } else {
    parse(how);
    v = how;
  }
  if (compare(v, current) <= 0) throw new Error(`${v} is not higher than ${current}`);
  return v;
}

const releaseHeading = /^## \[(\d[^\]]*)\](?: - (\d{4}-\d{2}-\d{2}))?(?: \[YANKED\])?\s*$/;

/** The released versions in the CHANGELOG, top first, with their dates. */
export function releases(changelog) {
  const out = [];
  for (const line of changelog.split('\n')) {
    const m = releaseHeading.exec(line);
    if (m) out.push({ version: m[1], date: m[2] ?? null });
  }
  return out;
}

/** The body of a section: from its heading to the next `## ` heading or the link references. */
export function section(changelog, name) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${name}]`));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++)
    if (lines[i].startsWith('## ') || /^\[[^\]]+\]: /.test(lines[i])) {
      end = i;
      break;
    }
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
}

/** Problems with a CHANGELOG, as a list of messages (empty when it is in order). */
export function lintChangelog(changelog) {
  const problems = [];
  if (!/^## \[Unreleased\]\s*$/m.test(changelog))
    problems.push('there is no "## [Unreleased]" section');
  const list = releases(changelog);
  for (const r of list) {
    if (!SEMVER.test(r.version)) problems.push(`"${r.version}" is not a Semantic Version`);
    if (!r.date) problems.push(`${r.version} has no date (## [${r.version}] - YYYY-MM-DD)`);
    if (!new RegExp(`^\\[${r.version.replace(/[.+]/g, '\\$&')}\\]: https?://`, 'm').test(changelog))
      problems.push(`${r.version} has no link reference at the foot of the file`);
  }
  if (!/^\[Unreleased\]: https?:\/\//m.test(changelog))
    problems.push('the [Unreleased] link reference is missing at the foot of the file');
  for (let i = 1; i < list.length; i++)
    if (SEMVER.test(list[i].version) && SEMVER.test(list[i - 1].version)) {
      if (compare(list[i - 1].version, list[i].version) <= 0)
        problems.push(`${list[i - 1].version} must come above ${list[i].version} (newest first)`);
      if (list[i - 1].date && list[i].date && list[i - 1].date < list[i].date)
        problems.push(`${list[i - 1].version} is dated before ${list[i].version}`);
    }
  for (const m of changelog.matchAll(/^### (.+)$/gm))
    if (!SECTIONS.includes(m[1].trim()))
      problems.push(`"### ${m[1]}" is not a Keep a Changelog heading (${SECTIONS.join(', ')})`);
  return problems;
}

/** The CHANGELOG with `[Unreleased]` turned into the release `version` dated `date`. */
export function cut(changelog, version, date, repo) {
  const body = section(changelog, 'Unreleased');
  if (body === null) throw new Error('there is no [Unreleased] section');
  if (!/^\s*[-*] /m.test(body)) throw new Error('[Unreleased] has no entries: nothing to release');
  const previous = releases(changelog)[0]?.version ?? null;
  if (previous && compare(version, previous) <= 0)
    throw new Error(`${version} is not higher than the last release, ${previous}`);
  let out = changelog.replace(
    /^## \[Unreleased\]\s*$/m,
    `## [Unreleased]\n\n## [${version}] - ${date}`,
  );
  const unreleased = `[Unreleased]: ${repo}/compare/v${version}...HEAD`;
  const link = previous
    ? `[${version}]: ${repo}/compare/v${previous}...v${version}`
    : `[${version}]: ${repo}/releases/tag/v${version}`;
  out = /^\[Unreleased\]: .*$/m.test(out)
    ? out.replace(/^\[Unreleased\]: .*$/m, `${unreleased}\n${link}`)
    : `${out.trimEnd()}\n\n${unreleased}\n${link}\n`;
  return out;
}

/** The package.json files that carry the product version, root first. */
export function packageFiles(root) {
  const files = [join(root, 'package.json')];
  for (const dir of ['apps', 'packages'])
    if (existsSync(join(root, dir)))
      for (const d of readdirSync(join(root, dir)).sort()) {
        const f = join(root, dir, d, 'package.json');
        if (existsSync(f)) files.push(f);
      }
  return files;
}

const versionOf = (file) => JSON.parse(readFileSync(file, 'utf8')).version;

/** Problems with the versions in a checkout; empty when the repository is in order. */
export function checkRepository(root) {
  const problems = [];
  const files = packageFiles(root);
  const rootVersion = versionOf(files[0]);
  if (!rootVersion || !SEMVER.test(rootVersion))
    return [`package.json: "${rootVersion}" is not a Semantic Version`];
  for (const f of files.slice(1))
    if (versionOf(f) !== rootVersion)
      problems.push(
        `${f.slice(root.length + 1)} is ${versionOf(f)}; the product version is ${rootVersion}`,
      );
  const changelogFile = join(root, 'CHANGELOG.md');
  if (!existsSync(changelogFile)) return [...problems, 'CHANGELOG.md is missing'];
  const changelog = readFileSync(changelogFile, 'utf8');
  problems.push(...lintChangelog(changelog));
  const top = releases(changelog)[0]?.version;
  if (top && top !== rootVersion)
    problems.push(`CHANGELOG.md's latest release is ${top}; package.json says ${rootVersion}`);
  return problems;
}

function setVersion(file, version) {
  const text = readFileSync(file, 'utf8');
  const out = text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
  if (out === text && versionOf(file) !== version)
    throw new Error(`could not set the version in ${file}`);
  writeFileSync(file, out);
}

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const [command, arg] = argv;
  if (command === 'check') {
    const problems = checkRepository(root);
    if (problems.length) {
      console.error(problems.map((p) => `- ${p}`).join('\n'));
      process.exit(1);
    }
    console.log(`Versions and CHANGELOG are in order (${versionOf(join(root, 'package.json'))}).`);
  } else if (command === 'bump') {
    if (!arg)
      throw new Error(
        'usage: release.mjs bump <major|minor|patch|alpha|beta|rc|release|X.Y.Z> [--dry-run]',
      );
    const dry = argv.includes('--dry-run');
    const problems = checkRepository(root);
    if (problems.length)
      throw new Error(`fix these first:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    const files = packageFiles(root);
    const version = next(versionOf(files[0]), arg);
    const repo = JSON.parse(readFileSync(files[0], 'utf8')).repository?.url?.replace(/\.git$/, '');
    if (!repo) throw new Error('package.json needs "repository.url" for the CHANGELOG links');
    const date = new Date().toISOString().slice(0, 10);
    const changelogFile = join(root, 'CHANGELOG.md');
    const changelog = cut(readFileSync(changelogFile, 'utf8'), version, date, repo);
    if (dry) {
      console.log(`Would release ${version} (${date}):\n\n${section(changelog, version)}`);
      return;
    }
    writeFileSync(changelogFile, changelog);
    for (const f of files) setVersion(f, version);
    console.log(
      `Released ${version} in the files. Now:\n` +
        `  1. read the CHANGELOG section and fix its words (git diff)\n` +
        `  2. git commit -am "chore(release): v${version}"\n` +
        `  3. after CI is green: git tag -a v${version} -m "v${version}" && git push origin v${version}\n` +
        `  4. publish the release notes: node scripts/release.mjs notes ${version}`,
    );
  } else if (command === 'notes') {
    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    const version = arg ?? releases(changelog)[0]?.version;
    const body = version && section(changelog, version);
    if (!body) throw new Error(`no CHANGELOG section for ${version ?? 'a release'}`);
    console.log(body);
  } else {
    console.error(
      'usage: release.mjs check | bump <major|minor|patch|alpha|beta|rc|release|X.Y.Z> [--dry-run] | notes [X.Y.Z]',
    );
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
