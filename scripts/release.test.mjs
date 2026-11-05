import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  checkRepository,
  compare,
  cut,
  lintChangelog,
  next,
  releases,
  section,
} from './release.mjs';

const REPO = 'https://github.com/example/app';
const changelog = (unreleased = '### Added\n\n- A thing.\n') => `# Changelog

## [Unreleased]

${unreleased}
## [1.2.0] - 2026-03-01

### Fixed

- Something.

## [1.1.0] - 2026-02-01

### Added

- Something else.

[Unreleased]: ${REPO}/compare/v1.2.0...HEAD
[1.2.0]: ${REPO}/compare/v1.1.0...v1.2.0
[1.1.0]: ${REPO}/releases/tag/v1.1.0
`;

test('precedence follows SemVer 2.0.0 section 11', () => {
  const ordered = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1',
    '1.1.0',
    '2.0.0',
  ];
  for (let i = 1; i < ordered.length; i++)
    assert.ok(compare(ordered[i - 1], ordered[i]) < 0, `${ordered[i - 1]} < ${ordered[i]}`);
  assert.equal(compare('1.0.0+build.1', '1.0.0+build.2'), 0);
});

test('only valid Semantic Versions are accepted', () => {
  for (const bad of ['1', '1.2', '01.2.3', '1.2.3.4', 'v1.2.3', '1.2.3-', '1.2.3-01'])
    assert.throws(() => compare(bad, '1.0.0'), /not a Semantic Version/, bad);
});

test('next version: major, minor, patch, explicit, and never backwards', () => {
  assert.equal(next('1.2.3', 'major'), '2.0.0');
  assert.equal(next('1.2.3', 'minor'), '1.3.0');
  assert.equal(next('1.2.3', 'patch'), '1.2.4');
  assert.equal(next('1.2.3-rc.1', 'patch'), '1.2.3');
  assert.equal(next('1.2.3', '1.3.0-rc.1'), '1.3.0-rc.1');
  assert.throws(() => next('1.2.3', '1.2.3'), /not higher/);
  assert.throws(() => next('1.2.3', '1.0.0'), /not higher/);
  assert.throws(() => next('1.2.3', 'big'), /not a Semantic Version/);
});

test('reads releases and sections', () => {
  assert.deepEqual(releases(changelog()), [
    { version: '1.2.0', date: '2026-03-01' },
    { version: '1.1.0', date: '2026-02-01' },
  ]);
  assert.match(section(changelog(), '1.2.0'), /^### Fixed\n\n- Something\.$/);
  assert.match(section(changelog(), '1.1.0'), /Something else/);
  assert.equal(section(changelog(), '9.9.9'), null);
});

test('a well-formed CHANGELOG has no problems', () => {
  assert.deepEqual(lintChangelog(changelog()), []);
});

test('the linter finds what is wrong', () => {
  const bad = changelog()
    .replace('## [1.2.0] - 2026-03-01', '## [1.2.0]')
    .replace('### Fixed', '### Misc')
    .replace(/^\[1\.1\.0\]: .*\n/m, '');
  const found = lintChangelog(bad).join('\n');
  assert.match(found, /1\.2\.0 has no date/);
  assert.match(found, /"### Misc" is not a Keep a Changelog heading/);
  assert.match(found, /1\.1\.0 has no link reference/);
  assert.match(
    lintChangelog(changelog().replace('## [Unreleased]', '## [Next]')).join('\n'),
    /no "## \[Unreleased\]"/,
  );
  const unordered = changelog().replace('## [1.1.0] - 2026-02-01', '## [1.3.0] - 2026-02-01');
  assert.match(lintChangelog(unordered).join('\n'), /must come above/);
});

test('cutting a release moves Unreleased under the new version and fixes the links', () => {
  const out = cut(changelog(), '1.3.0', '2026-04-01', REPO);
  assert.deepEqual(lintChangelog(out), []);
  assert.deepEqual(
    releases(out).map((r) => r.version),
    ['1.3.0', '1.2.0', '1.1.0'],
  );
  assert.match(section(out, 'Unreleased'), /^$/);
  assert.match(section(out, '1.3.0'), /A thing/);
  assert.match(out, new RegExp(`\\[Unreleased\\]: ${REPO}/compare/v1\\.3\\.0\\.\\.\\.HEAD`));
  assert.match(out, new RegExp(`\\[1\\.3\\.0\\]: ${REPO}/compare/v1\\.2\\.0\\.\\.\\.v1\\.3\\.0`));
});

test('the first release gets a tag link; an empty Unreleased cannot be released', () => {
  const first = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- First.\n\n[Unreleased]: x\n';
  const out = cut(first, '0.1.0', '2026-01-01', REPO);
  assert.match(out, new RegExp(`\\[0\\.1\\.0\\]: ${REPO}/releases/tag/v0\\.1\\.0`));
  assert.throws(() => cut(changelog('\n'), '1.3.0', '2026-04-01', REPO), /nothing to release/);
  assert.throws(() => cut(changelog(), '1.2.0', '2026-04-01', REPO), /not higher/);
});

test('a checkout is checked: all packages on one version, CHANGELOG on the same', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-'));
  const pkg = (dir, version) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name: dir, version }));
  };
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', version: '1.2.0' }));
  pkg('apps/api', '1.2.0');
  pkg('packages/schema', '1.2.0');
  writeFileSync(join(root, 'CHANGELOG.md'), changelog());
  assert.deepEqual(checkRepository(root), []);

  pkg('packages/schema', '1.1.0');
  assert.match(checkRepository(root).join('\n'), /packages\/schema\/package\.json is 1\.1\.0/);
  pkg('packages/schema', '1.2.0');

  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', version: '1.1.0' }));
  pkg('apps/api', '1.1.0');
  pkg('packages/schema', '1.1.0');
  assert.match(
    checkRepository(root).join('\n'),
    /latest release is 1\.2\.0; package\.json says 1\.1\.0/,
  );
  assert.equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), changelog());
});
