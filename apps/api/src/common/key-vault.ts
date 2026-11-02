import { ManagedIdentity } from '../exports/storage.js';

/**
 * A secret setting is either the secret itself or a reference to Azure Key Vault:
 * `@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/<name>[/<version>])` or
 * `@Microsoft.KeyVault(VaultName=<vault>;SecretName=<name>[;SecretVersion=<version>])`.
 * App Service resolves its references before the app starts, so there the app only sees the
 * secret; anywhere else (a container, a virtual machine) the reference arrives as text and is
 * resolved here with the app's managed identity (AZURE_CLIENT_ID for a user-assigned one).
 */
export interface KeyVaultReference {
  vault: string;
  name: string;
  version?: string;
}

const REFERENCE = /^@Microsoft\.KeyVault\((.*)\)$/s;

export function parseKeyVaultReference(value: string): KeyVaultReference | null {
  const inner = REFERENCE.exec(value.trim())?.[1];
  if (inner === undefined) return null;
  const parts = Object.fromEntries(
    inner.split(';').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim()];
    }),
  ) as Record<string, string | undefined>;
  if (parts.secreturi) {
    let url: URL;
    try {
      url = new URL(parts.secreturi);
    } catch {
      return null;
    }
    const [kind, name, version] = url.pathname.split('/').filter(Boolean);
    if (url.protocol !== 'https:' || kind !== 'secrets' || !name) return null;
    return { vault: url.origin, name, ...(version ? { version } : {}) };
  }
  if (parts.vaultname && parts.secretname) {
    // The vault's address in the public cloud; sovereign clouds give SecretUri.
    return {
      vault: `https://${parts.vaultname}.vault.azure.net`,
      name: parts.secretname,
      ...(parts.secretversion ? { version: parts.secretversion } : {}),
    };
  }
  return null;
}

export interface TokenSource {
  getToken(scope: string): Promise<{ token: string }>;
}

/** The secret behind a setting: the value itself, or what Key Vault holds for a reference. */
export class SecretResolver {
  private readonly cache = new Map<string, { value: string; at: number }>();

  constructor(
    private readonly identity: TokenSource = new ManagedIdentity(process.env.AZURE_CLIENT_ID),
    private readonly fetcher: typeof fetch = fetch,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  /** Whether the setting is a Key Vault reference (rather than a secret written in it). */
  static isReference(value: string): boolean {
    return REFERENCE.test(value.trim());
  }

  async resolve(value: string): Promise<string> {
    if (!SecretResolver.isReference(value)) return value;
    const ref = parseKeyVaultReference(value);
    if (!ref) throw new Error('A Key Vault reference in a setting is not well formed');
    const key = `${ref.vault}/${ref.name}/${ref.version ?? ''}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const { token } = await this.identity.getToken('https://vault.azure.net/.default');
    const url = `${ref.vault}/secrets/${encodeURIComponent(ref.name)}${
      ref.version ? `/${encodeURIComponent(ref.version)}` : ''
    }?api-version=7.4`;
    const res = await this.fetcher(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok)
      throw new Error(
        `Key Vault: HTTP ${res.status} reading the secret ${ref.name} of ${ref.vault}`,
      );
    const body = (await res.json()) as { value?: string };
    if (typeof body.value !== 'string' || !body.value)
      throw new Error(`Key Vault: the secret ${ref.name} has no value`);
    this.cache.set(key, { value: body.value, at: Date.now() });
    return body.value;
  }
}
