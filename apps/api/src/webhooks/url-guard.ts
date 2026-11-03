import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Where a webhook may not go: the server would be made to call the inside of its own network
 * (server-side request forgery). Loopback, private, link-local (the cloud metadata address
 * 169.254.169.254 among them), shared and reserved ranges, for both address families.
 */
const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, bits, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const addr = v4mapped ? v4mapped[1]! : address;
  const family = isIP(addr);
  if (!family) return false;
  return !blocked.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}

export class UnsafeUrlError extends Error {}

export interface ResolvedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

/**
 * Checks the address of a webhook and resolves it once; the delivery connects to the address
 * checked here, so a name that changes its answer between the check and the call cannot
 * lead somewhere else. With `allowPrivate` (tests and local development) http and private
 * addresses are accepted.
 */
export async function resolveTarget(raw: string, allowPrivate = false): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('Not a valid address');
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:'))
    throw new UnsafeUrlError('Only https addresses are accepted');
  if (url.username || url.password) throw new UnsafeUrlError('No credentials in the address');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const found = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true }).catch(() => {
        throw new UnsafeUrlError('The name does not resolve');
      });
  if (!found.length) throw new UnsafeUrlError('The name does not resolve');
  if (!allowPrivate && !found.every((f) => isPublicAddress(f.address)))
    throw new UnsafeUrlError('The address points to a private or reserved network');
  const first = found[0]!;
  return { url, address: first.address, family: first.family as 4 | 6 };
}
