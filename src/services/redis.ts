import { createClient } from 'redis';
import { config } from '../config.js';

export const redisClient = createClient({
  socket: { host: config.redis.host, port: config.redis.port }
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
