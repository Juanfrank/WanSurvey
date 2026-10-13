import { createHmac, hkdfSync } from 'node:crypto';
import { decryptField, encryptField } from '../common/crypto.js';

/** Case row columns that hold the sample. */
export interface SampleColumns {
  sample: unknown;
  samplePii?: string | null;
}

/** Words of a value as the search index keeps them: lower case, accents folded. */
export function words(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  return String(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}@.+-]+/u)
    .filter((w) => w.length > 0)
    .slice(0, 50);
}

/**
 * Field-level encryption of personal sample fields (H1). Personal fields (`sample_fields.pii`)
 * are kept out of `cases.sample` in `sample_pii`, one AES-256-GCM sealed JSON object per case,
 * with a keyed hash of each word in `sample_pii_index` so people allowed to see personal data
 * can still find a case by name. Values written before encryption (plain in `sample`) are
 * still read, and moved by the `pii.encrypt` job.
 */
export class PiiCipher {
  private readonly indexKey: Buffer;

  constructor(private readonly keyB64: string) {
    this.indexKey = Buffer.from(
      hkdfSync('sha256', Buffer.from(keyB64, 'base64'), Buffer.alloc(0), 'wansurvey-pii-index', 32),
    );
  }

  /** Keyed hash of one search word. */
  token(word: string): string {
    return createHmac('sha256', this.indexKey).update(word).digest('base64url').slice(0, 22);
  }

  /** Splits a sample into the plain part and the sealed personal part. */
  seal(
    sample: Record<string, unknown>,
    pii: Set<string>,
  ): {
    sample: Record<string, unknown>;
    samplePii: string | null;
    samplePiiIndex: string[] | null;
  } {
    const plain: Record<string, unknown> = {};
    const personal: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sample)) {
      if (pii.has(k)) {
        if (v !== null && v !== undefined && v !== '') personal[k] = v;
      } else plain[k] = v;
    }
    if (!Object.keys(personal).length)
      return { sample: plain, samplePii: null, samplePiiIndex: null };
    const index = [...new Set(Object.values(personal).flatMap(words))].map((w) => this.token(w));
    return {
      sample: plain,
      samplePii: encryptField(JSON.stringify(personal), this.keyB64),
      samplePiiIndex: index,
    };
  }

  /** The personal fields of a case. */
  open(samplePii: string | null | undefined): Record<string, unknown> {
    if (!samplePii) return {};
    return JSON.parse(decryptField(samplePii, this.keyB64)) as Record<string, unknown>;
  }

  /** The whole sample of a case: plain fields and personal ones. */
  read(row: SampleColumns): Record<string, unknown> {
    return { ...((row.sample ?? {}) as Record<string, unknown>), ...this.open(row.samplePii) };
  }
}
