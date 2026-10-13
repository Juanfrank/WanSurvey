import { createHash } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface.js';
import { Redis } from 'ioredis';
import { IS_PUBLIC } from './auth-context.js';
import { SESSION_COOKIE } from './cookies.js';

/**
 * Rate-limit counters in Redis, so every API instance counts the same requests (in memory,
 * N instances would allow N times the limit). A fixed window per key; blocking when asked.
 * If Redis cannot answer, the request is let through: a cache outage must not stop fieldwork.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectionName: 'wansurvey-throttle',
    });
    this.redis.on('error', () => {
      // Reported by the requests that fail open; the connection retries by itself.
    });
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const k = `throttle:${throttlerName}:${key}`;
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      const [hits, ttlMs, blockMs] = (await this.redis.eval(
        `local hits = redis.call('INCR', KEYS[1])
         if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
         local ttl = redis.call('PTTL', KEYS[1])
         local block = redis.call('PTTL', KEYS[2])
         if block < 0 and hits > tonumber(ARGV[2]) and tonumber(ARGV[3]) > 0 then
           redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
           block = tonumber(ARGV[3])
         end
         return {hits, ttl, block}`,
        2,
        k,
        `${k}:blocked`,
        String(ttl),
        String(limit),
        String(blockDuration),
      )) as [number, number, number];
      const isBlocked = blockMs > 0;
      return {
        totalHits: hits,
        timeToExpire: Math.max(0, Math.ceil(ttlMs / 1000)),
        isBlocked,
        timeToBlockExpire: isBlocked ? Math.ceil(blockMs / 1000) : 0,
      };
    } catch {
      return {
        totalHits: 0,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }

  async close() {
    if (this.redis.status === 'ready') await this.redis.quit().catch(() => undefined);
    this.redis.disconnect();
  }
}

let shared: RedisThrottlerStorage | null = null;

/** The storage for this process: Redis when configured, else Nest's in-memory default. */
export function throttleStorage(redisUrl: string | undefined) {
  if (!redisUrl) return undefined;
  shared ??= new RedisThrottlerStorage(redisUrl);
  return shared;
}

export async function closeThrottleStorage() {
  await shared?.close();
  shared = null;
}

const hash = (v: string) => createHash('sha256').update(v).digest('base64url').slice(0, 22);

/**
 * Who a request counts against. Signed-in routes count per session, so a field office whose
 * interviewers share one public IP (NAT) does not share one quota. Public routes (sign-in,
 * respondents, links) count per client IP, so made-up cookies cannot get round their limits;
 * every route also has an overall per-IP ceiling (the `ip` throttler).
 */
export function sessionOrIp(req: Record<string, unknown>, context: ExecutionContext): string {
  const ip = String(req.ip ?? 'unknown');
  const handler = context.getHandler();
  const cls = context.getClass();
  const isPublic =
    Reflect.getMetadata(IS_PUBLIC, handler) === true ||
    Reflect.getMetadata(IS_PUBLIC, cls) === true;
  if (isPublic) return ip;
  const cookie = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  return cookie ? `s:${hash(cookie)}` : ip;
}
