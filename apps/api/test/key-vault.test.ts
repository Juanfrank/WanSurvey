import { describe, expect, it, vi } from 'vitest';
import { parseKeyVaultReference, SecretResolver } from '../src/common/key-vault.js';

const URI = '@Microsoft.KeyVault(SecretUri=https://wan.vault.azure.net/secrets/entra-secret/)';

describe('Key Vault references', () => {
  it('reads both forms of the reference', () => {
    expect(parseKeyVaultReference(URI)).toEqual({
      vault: 'https://wan.vault.azure.net',
      name: 'entra-secret',
    });
    expect(
      parseKeyVaultReference(
        '@Microsoft.KeyVault(SecretUri=https://wan.vault.azure.net/secrets/s/0123abcd)',
      ),
    ).toEqual({ vault: 'https://wan.vault.azure.net', name: 's', version: '0123abcd' });
    expect(
      parseKeyVaultReference('@Microsoft.KeyVault(VaultName=wan;SecretName=s;SecretVersion=7)'),
    ).toEqual({ vault: 'https://wan.vault.azure.net', name: 's', version: '7' });
  });

  it('does not take a secret, or a reference that is not well formed, for one', () => {
    expect(parseKeyVaultReference('a-plain-secret')).toBeNull();
    expect(parseKeyVaultReference('@Microsoft.KeyVault(SecretUri=http://x/secrets/s)')).toBeNull();
    expect(parseKeyVaultReference('@Microsoft.KeyVault(VaultName=wan)')).toBeNull();
    expect(SecretResolver.isReference('a-plain-secret')).toBe(false);
    expect(SecretResolver.isReference(URI)).toBe(true);
  });
});

describe('SecretResolver', () => {
  const identity = { getToken: vi.fn(async () => ({ token: 'tok' })) };
  const reply = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('gives back a secret written in the setting without going anywhere', async () => {
    const fetcher = reply({});
    const r = new SecretResolver(identity, fetcher as unknown as typeof fetch);
    expect(await r.resolve('direct-secret')).toBe('direct-secret');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a reference from Key Vault with the managed identity, and keeps it for a while', async () => {
    const fetcher = reply({ value: 'from-vault' });
    const r = new SecretResolver(identity, fetcher as unknown as typeof fetch);
    expect(await r.resolve(URI)).toBe('from-vault');
    expect(await r.resolve(URI)).toBe('from-vault');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://wan.vault.azure.net/secrets/entra-secret?api-version=7.4');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(identity.getToken).toHaveBeenCalledWith('https://vault.azure.net/.default');
  });

  it('says what went wrong, without the secret', async () => {
    const denied = new SecretResolver(identity, reply({}, 403) as unknown as typeof fetch);
    await expect(denied.resolve(URI)).rejects.toThrow(/Key Vault: HTTP 403.*entra-secret/);
    const empty = new SecretResolver(identity, reply({ value: '' }) as unknown as typeof fetch);
    await expect(empty.resolve(URI)).rejects.toThrow(/has no value/);
    await expect(
      new SecretResolver(identity).resolve('@Microsoft.KeyVault(Oops=1)'),
    ).rejects.toThrow(/not well formed/);
  });
});
