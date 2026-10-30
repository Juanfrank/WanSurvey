import { BlockList, isIP } from 'node:net';
import type { NextFunction, Request, Response } from 'express';

/** The address as the proxy saw it: App Service writes `ip:port`, and IPv4 may come mapped. */
export function clientAddress(raw: string | undefined): string {
  let ip = (raw ?? '').trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1]!;
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  return ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
}

/**
 * /health answers only the addresses in HEALTH_ALLOWED_IPS (single IPs and CIDR ranges); anyone
 * else gets the 404 of a route that does not exist. An empty list lets everyone in.
 */
export function healthAccess(allowed: string[]) {
  const list = new BlockList();
  for (const entry of allowed) {
    const [addr, bits] = entry.split('/') as [string, string | undefined];
    const family = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) list.addAddress(addr, family);
    else list.addSubnet(addr, Number(bits), family);
  }
  return (req: Request, res: Response, next: NextFunction) => {
    if (!allowed.length || (req.path !== '/health' && req.path !== '/health/')) return next();
    const ip = clientAddress(req.ip);
    const family = isIP(ip);
    if (family && list.check(ip, family === 6 ? 'ipv6' : 'ipv4')) return next();
    // In the log, so the address App Service really uses can be found and allowed.
    req.log?.warn({ ip: req.ip }, 'health: address not in HEALTH_ALLOWED_IPS');
    res.status(404).json({ message: 'Cannot GET /health', error: 'Not Found', statusCode: 404 });
  };
}
