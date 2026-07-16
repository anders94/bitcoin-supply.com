import { Response } from 'express';
import { redisClient } from './redis.js';

// SSE clients connect to the web server process, but block events originate in
// the separate ETL process — they are bridged over a Redis pub/sub channel.
const CHANNEL = 'sse:blocks';

const clients = new Set<Response>();

export function addSSEClient(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write('data: {"type":"connected"}\n\n');
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function broadcastSSE(event: object): void {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    client.write(data);
  }
}

// Called by the ETL process.
export async function publishSSE(event: object): Promise<void> {
  await redisClient.publish(CHANNEL, JSON.stringify(event));
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
