import { describe, expect, it } from 'vitest';
import { aboutPage, privacyPage, termsPage, type Facts } from '../src/about/content.js';

/**
 * The contract of the informative pages (docs/info-pages.md): ids and order, the same ids in every
 * language, the conditional `rights` section, no empty sections, links inside the application, the
 * contact fallback and the date of the privacy policy. Portable: change the facts and the ids that
 * are the application's own.
 */
const base: Facts = {
  version: '1.2.3',
  organisation: null,
  privacyContact: null,
  author: null,
  holder: null,
  services: {},
};
const full: Facts = {
  ...base,
  organisation: 'Instituto Demo',
  privacyContact: 'datos@demo.example',
  author: 'Ana Autora',
  holder: 'Editorial S.A.',
  services: { geocoder: true, sms: true, email: true, microsoftSignIn: true, passwordLogin: true },
  technical: { build: 'abc123', environment: 'production', node: '22.1.0' },
};
const builders = { about: aboutPage, privacy: privacyPage, terms: termsPage };
const ids = (p: { sections: { id: string }[] }) => p.sections.map((s) => s.id);
const text = (p: { title: string; intro: string; sections: object[] }) => JSON.stringify(p);

describe('About', () => {
  it('has what, who, version, access and contact, in that order; rights only with an author or holder', () => {
    expect(ids(aboutPage(base, false))).toEqual([
      'what',
      'who',
      'version',
      'access',
      'contact',
      'documents',
    ]);
    expect(ids(aboutPage({ ...base, author: 'Ana' }, false))).toEqual([
      'what',
      'who',
      'version',
      'rights',
      'access',
      'contact',
      'documents',
    ]);
    expect(ids(aboutPage({ ...base, holder: 'Editorial' }, true))).toContain('rights');
  });

  it('adds the technical section last, and only when the facts carry it', () => {
    expect(ids(aboutPage(base, true))).not.toContain('technical');
    expect(ids(aboutPage(full, true)).at(-1)).toBe('technical');
    const t = aboutPage(full, false).sections.at(-1)!;
    expect(t.items).toEqual(['Build: abc123', 'Mode: production', 'Node: 22.1.0']);
  });

  it('names the author and the holder, and says they do not answer for the survey data', () => {
    const r = aboutPage(full, true).sections.find((s) => s.id === 'rights')!;
    expect(r.paragraphs!.join(' ')).toMatch(/Autor: Ana Autora\./);
    expect(r.paragraphs!.join(' ')).toMatch(
      /Titular de los derechos de la aplicación: Editorial S\.A\./,
    );
    expect(r.paragraphs!.join(' ')).toMatch(/no son, por eso, responsables/);
  });

  it('says only the services that are on, and nothing of the build in the public version', () => {
    const off = text(aboutPage({ ...base, services: { passwordLogin: true } }, false));
    expect(off).not.toMatch(/SMS|Microsoft|E-mail to|Address search|web links or e-mail/);
    expect(off).toContain('Outreach by links, with answers');
    expect(off).toContain('Sign-in with e-mail and password');
    const on = text(aboutPage({ ...full, technical: undefined }, false));
    expect(on).toMatch(/SMS/);
    expect(on).toMatch(/Microsoft/);
    expect(on).not.toMatch(/abc123|production|22\.1\.0/);
  });

  it('says who runs it, or that an organisation does, and the contact or the fallback', () => {
    expect(text(aboutPage(full, true))).toContain('Esta instalación la administra Instituto Demo.');
    expect(text(aboutPage(base, true))).toContain(
      'Esta instalación la administra una organización.',
    );
    expect(text(aboutPage(full, false))).toContain('Write to datos@demo.example.');
    expect(text(aboutPage(base, false))).toContain('Write to your organisation’s administrator.');
    expect(text(aboutPage(base, true))).toContain('Escriba al administrador de su organización.');
    expect(aboutPage(full, true).sections.find((s) => s.id === 'version')!.paragraphs).toEqual([
      'Versión 1.2.3.',
    ]);
  });
});

describe.each(Object.entries(builders))('%s', (name, build) => {
  it.each([base, full])('has the same ids in both languages, unique and in kebab-case', (f) => {
    const es = ids(build(f, true));
    expect(es).toEqual(ids(build(f, false)));
    expect(new Set(es).size).toBe(es.length);
    for (const id of es) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it.each([base, full])('has no empty section and no external link', (f) => {
    for (const es of [true, false])
      for (const s of build(f, es).sections) {
        expect(s.title.trim(), `${name}/${s.id} title`).not.toBe('');
        const content =
          (s.paragraphs?.length ?? 0) + (s.items?.length ?? 0) + (s.links?.length ?? 0);
        expect(content, `${name}/${s.id} is empty`).toBeGreaterThan(0);
        for (const l of s.links ?? []) expect(l.to).toMatch(/^\//);
        expect(JSON.stringify(s)).not.toMatch(/https?:\/\//);
      }
  });

  // Writing conventions (docs/info-pages.md §5.1): what can be checked automatically.
  it.each([base, full])('writes titles, intros, paragraphs and bullets by the conventions', (f) => {
    for (const es of [true, false]) {
      const page = build(f, es);
      expect(page.intro, `${name} intro`).toMatch(/[.]$/);
      for (const s of page.sections) {
        const at = `${name}/${s.id} (${es ? 'es' : 'en'})`;
        // Not numbered, no final full stop or colon, capital only on the first word's letter.
        expect(s.title, `${at} title is numbered`).not.toMatch(/^\d+[.)]/);
        expect(s.title, `${at} title punctuation`).not.toMatch(/[.:]$/);
        for (const p of s.paragraphs ?? []) expect(p, `${at} paragraph`).toMatch(/[.:]$/);
        for (const i of s.items ?? []) {
          expect(i, `${at} bullet starts in a capital`).toMatch(/^[A-ZÁÉÍÓÚÑ0-9¿«“]/);
          // A sentence ends in a full stop; "Label: value" (a status) has none.
          const label = /^[^:.]{1,40}: .*[^.]$/.test(i);
          expect(label || i.endsWith('.'), `${at} bullet "${i.slice(0, 40)}"`).toBe(true);
        }
        // Inner references go by name, never by number.
        const all = [...(s.paragraphs ?? []), ...(s.items ?? [])].join(' ');
        expect(all, `${at} refers by number`).not.toMatch(/\b(secci[oó]n|section)\s+\d/i);
      }
    }
  });

  it('publishes no licence, changelog, roadmap or operational data', () => {
    const all = text(build(full, true)) + text(build(full, false));
    expect(all).not.toMatch(/changelog|registro de cambios|roadmap|hoja de ruta|licen[cs]e/i);
  });
});

describe('Privacy', () => {
  it('closes its introduction with the date of the update', () => {
    expect(privacyPage(base, true).intro).toMatch(/Última actualización: \d{4}-\d{2}-\d{2}\.$/);
    expect(privacyPage(base, false).intro).toMatch(/Last updated: \d{4}-\d{2}-\d{2}\.$/);
  });
});
