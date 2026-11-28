import { z } from 'zod';

/**
 * The regional formats offered to an organisation (BCP 47): how dates, times and numbers are
 * written (decimal and thousands separators, day before or after the month, 24 or 12 hours),
 * apart from the language of the interface. Any other well-formed locale is accepted too.
 */
export const FORMAT_LOCALES = [
  'es-PE',
  'es-ES',
  'es-MX',
  'es-AR',
  'es-CO',
  'es-CL',
  'en-US',
  'en-GB',
  'pt-BR',
  'pt-PT',
  'fr-FR',
] as const;

/** The locale in its canonical spelling (`es-pe` → `es-PE`), or null when it is not one. */
export function canonicalLocale(tag: string): string | null {
  try {
    const [canonical] = Intl.getCanonicalLocales(tag);
    if (!canonical) return null;
    // A language the runtime has no data for would silently fall back to another one.
    if (!Intl.NumberFormat.supportedLocalesOf(canonical).length) return null;
    // Latin digits and an ASCII minus only (not ١٫٥ nor −1,5): numbers in readable exports
    // must still read as numbers in a spreadsheet.
    return /^-[0-9]/.test(new Intl.NumberFormat(canonical).format(-1.5)) ? canonical : null;
  } catch {
    return null;
  }
}

/** An organisation's regional format, stored canonical; null follows the language. */
export const FormatLocale = z
  .string()
  .max(35)
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'Not a locale (BCP 47, e.g. es-PE)')
  .transform((tag, ctx) => {
    const canonical = canonicalLocale(tag);
    if (!canonical) {
      ctx.addIssue({ code: 'custom', message: 'Unknown locale' });
      return z.NEVER;
    }
    return canonical;
  });
