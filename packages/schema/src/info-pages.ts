/**
 * The common contract of the informative pages (About, Privacy, Terms) shared by the institution's
 * applications (`Section` and `Page` in the shared contract): the same types, the same ids, the same facts. See docs/info-pages.md.
 */

/** A block of a page (named apart from the questionnaire sections of this package). */
export interface InfoSection {
  /** Stable, kebab-case, in English, the same in every language (the `#id` anchor). */
  id: string;
  title: string;
  paragraphs?: string[];
  /** A bulleted list after the paragraphs. */
  items?: string[];
  /** Links to pages of the application only: `to` starts with "/". */
  links?: { label: string; to: string }[];
}

export interface InfoPage {
  title: string;
  intro: string;
  sections: InfoSection[];
}

/** What the public endpoint says about the installation (no commit, no environment, no paths). */
export interface AboutFacts {
  version: string;
  /** ORG_NAME */
  organisation: string | null;
  /** PRIVACY_CONTACT */
  privacyContact: string | null;
  /** APP_AUTHOR */
  author: string | null;
  /** APP_HOLDER */
  holder: string | null;
  /** The optional services that are on (keys are the application's own). */
  services: Record<string, boolean>;
  /** Data of the application itself. */
  extra?: Record<string, string | number | boolean | null>;
  /** Only with a session, from the protected endpoint: it makes the `technical` section. */
  technical?: TechnicalFacts;
}

export interface TechnicalFacts {
  build: string;
  environment: 'production' | 'development';
  node: string;
}
