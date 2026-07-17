import { createClient } from 'redis';
import { config } from '../config.js';

// An auth failure is never transient — a wrong password will still be wrong on
// the next attempt. node-redis's default strategy retries it forever, so
// connectRedis() would neither resolve nor reject and both server.ts and
// etl/index.ts, which await it at startup, would hang silently rather than
// crash. Give up immediately on auth so the process dies with a readable error;
// keep backing off and retrying everything else, which really is transient.
function reconnectStrategy(retries: number, cause: Error): number | Error {
  if (/WRONGPASS|NOAUTH|AUTH/i.test(cause?.message ?? '')) return cause;
  return Math.min(retries * 200, 5_000);
}

// password is undefined for a loopback instance, which node-redis reads as "no
// AUTH". duplicate() carries these options, so the SSE subscriber authenticates
// too without needing to know about any of this.
export const redisClient = createClient({
  socket: { host: config.redis.host, port: config.redis.port, reconnectStrategy },
  password: config.redis.password,
});

redisClient.on('error', (err) => console.error('Redis error:', err));

export async function connectRedis(): Promise<void> {
  await redisClient.connect();
}

export async function cacheGet(key: string): Promise<string | null> {
  return redisClient.get(key);
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  await redisClient.setEx(key, ttlSeconds, value);
}

export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>
): Promise<T> {
  const cached = await cacheGet(key);
  if (cached) return JSON.parse(cached) as T;
  const result = await fn();
  await cacheSet(key, JSON.stringify(result), ttlSeconds);
  return result;
}
