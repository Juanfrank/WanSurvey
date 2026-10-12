/** A point found for an address, with how precise the match is. */
export interface GeoPoint {
  lat: number;
  lng: number;
  /** e.g. `house`, `street`, `city` (Nominatim's address type), or `not_found`. */
  quality: string;
}

/**
 * Turns addresses into coordinates. A port: Nominatim (OpenStreetMap) is the first adapter;
 * a commercial service or a self-hosted Nominatim plugs in the same way.
 */
export interface Geocoder {
  readonly name: string;
  /** null when nothing matches. Throws on service errors. */
  geocode(address: string): Promise<GeoPoint | null>;
}

export const GEOCODER = Symbol('GEOCODER');

/** Collapses case, spacing and punctuation, so the same address is looked up once. */
export function normaliseAddress(address: string): string {
  return address
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[.,;#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Nominatim, following its usage policy: an identifying User-Agent with a contact e-mail, at
 * most one request per second, and results cached so an address is never asked twice.
 */
export class NominatimGeocoder implements Geocoder {
  readonly name = 'nominatim';
  private readonly cache = new Map<string, GeoPoint | null>();
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly email: string,
    private readonly minIntervalMs = 1000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  geocode(address: string): Promise<GeoPoint | null> {
    const key = normaliseAddress(address);
    if (!key) return Promise.resolve(null);
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key)!);
    // Requests run one after another, spaced by the minimum interval.
    const run = this.queue.then(async () => {
      if (this.cache.has(key)) return this.cache.get(key)!;
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      const url = new URL('/search', this.baseUrl);
      url.searchParams.set('q', address);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('limit', '1');
      url.searchParams.set('addressdetails', '0');
      url.searchParams.set('email', this.email);
      const res = await this.fetchImpl(url, {
        headers: { 'User-Agent': `WanSurvey/0.1 (${this.email})`, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`Geocoder answered ${res.status}`);
      const body = (await res.json()) as {
        lat: string;
        lon: string;
        addresstype?: string;
        type?: string;
      }[];
      const hit = body[0];
      const point = hit
        ? {
            lat: Number(hit.lat),
            lng: Number(hit.lon),
            quality: hit.addresstype ?? hit.type ?? 'unknown',
          }
        : null;
      this.cache.set(key, point);
      return point;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
