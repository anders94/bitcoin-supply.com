import { Response } from 'express';
import { redisClient } from './redis.js';
import { getTip } from './tip.js';

// SSE clients connect to the web server process, but block events originate in
// the separate ETL process — they are bridged over a Redis pub/sub channel.
const CHANNEL = 'sse:blocks';

// Blocks arrive ~11 minutes apart, so without this the stream sits silent long
// enough for any intermediary to assume it died: nginx's default
// proxy_read_timeout is 60s, and it was cutting every connection at exactly
// that, leaving browsers in a connect/60s/drop/reconnect loop forever. A
// comment line keeps it warm through any proxy without needing one configured.
// 20s leaves margin under both a 60s and a stricter 30s idle timeout.
const HEARTBEAT_MS = 20_000;

const clients = new Set<Response>();

export async function addSSEClient(res: Response): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // nginx buffers proxied responses by default, which would hold block events
  // in a 4k buffer that a few bytes per 11 minutes will never fill. This is the
  // app-side equivalent of `proxy_buffering off`, so the stream works without
  // the proxy needing to know about it.
  res.setHeader('X-Accel-Buffering', 'no');
  // Flush headers immediately so the client's onopen fires without waiting on
  // the tip lookup below.
  res.write('data: {"type":"connected"}\n\n');
  clients.add(res);

  // ': ' marks an SSE comment — it keeps the socket alive but never reaches
  // the client's onmessage, so nothing has to know about it.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref();

  res.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });

  // Seed the current tip. A client that was disconnected when a block landed
  // missed that event permanently — nothing re-sends it — so without this the
  // header stays stale until the next block, up to ~11 minutes later.
  try {
    const tip = await getTip();
    if (tip.height > 0 && !res.writableEnded) {
      broadcastTo(res, { type: 'block', block_number: tip.height, block_timestamp: tip.timestamp });
    }
  } catch { /* non-fatal: the next block event will correct it */ }
}

function broadcastTo(client: Response, event: object): void {
  client.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function broadcastSSE(event: object): void {
  for (const client of clients) {
    broadcastTo(client, event);
  }
}

// How long to wait on a publish before giving up on it. A publish to Redis on
// the local network should take single-digit milliseconds; this is only ever
// reached when something is wrong.
const PUBLISH_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Called by the ETL process. Best-effort by design: it is awaited inside the
// live sync's block loop, so an unhandled rejection would abort the whole batch
// and leave the ETL crawling one block per poll. The live tip is cosmetic;
// indexing the chain is not, and it must not depend on this.
//
// The timeout matters as much as the catch. node-redis queues commands while
// disconnected rather than rejecting, so a bare await here would stall the sync
// loop indefinitely waiting to reconnect — silently, with no error to catch.
export async function publishSSE(event: object): Promise<void> {
  try {
    await withTimeout(redisClient.publish(CHANNEL, JSON.stringify(event)), PUBLISH_TIMEOUT_MS);
  } catch (err) {
    console.error('SSE publish failed (non-fatal):', (err as Error).message);
  }
}

// Called by the web server process at startup.
export async function initSSESubscriber(): Promise<void> {
  const subscriber = redisClient.duplicate();
  subscriber.on('error', (err) => console.error('Redis subscriber error:', err));
  await subscriber.connect();
  await subscriber.subscribe(CHANNEL, (message) => {
    try {
      broadcastSSE(JSON.parse(message));
    } catch (err) {
      console.error('Bad SSE message on', CHANNEL, err);
    }
  });
}
