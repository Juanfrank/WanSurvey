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
 * If Redis cannot answer, this instance counts on its own until it is back: the limits hold
 * (per instance, so a little looser), and sign-in can still not be guessed at freely, while
 * ordinary work goes on under limits set well above it.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly redis: Redis;
  /** Counters while Redis is unreachable: key → hits, window end, block end. */
  private readonly local = new Map<string, { hits: number; until: number; blocked: number }>();

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
      return this.countHere(k, ttl, limit, blockDuration);
    }
  }

  /** The same fixed window, in this process's memory. */
  countHere(k: string, ttl: number, limit: number, blockDuration: number): ThrottlerStorageRecord {
    const now = Date.now();
    if (this.local.size > 50_000)
      for (const [key, v] of this.local)
        if (v.until <= now && v.blocked <= now) this.local.delete(key);
    let c = this.local.get(k);
    if (!c || c.until <= now) {
      c = { hits: 0, until: now + ttl, blocked: c && c.blocked > now ? c.blocked : 0 };
      this.local.set(k, c);
    }
    c.hits++;
    if (c.blocked <= now && c.hits > limit && blockDuration > 0) c.blocked = now + blockDuration;
    const isBlocked = c.blocked > now;
    return {
      totalHits: c.hits,
      timeToExpire: Math.max(0, Math.ceil((c.until - now) / 1000)),
      isBlocked,
      timeToBlockExpire: isBlocked ? Math.ceil((c.blocked - now) / 1000) : 0,
    };
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
