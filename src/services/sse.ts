import { Response } from 'express';
import { getTip, refreshTip } from './tip.js';

// Block events used to be bridged from the ETL over Redis pub/sub, which forced
// both processes onto one Redis instance. They are on different machines, so
// that meant either exposing Redis across the network or never delivering the
// events at all. Instead the web server watches the tip itself.
//
// Blocks arrive ~11 minutes apart (measured: 664s mean), so a 15s poll spots one
// within ~2% of the interval — for an indicator that reads "3m ago", nobody can
// tell. The cost is four index scans a minute of a single row, and it doubles as
// what keeps the tip cache warm. In exchange Redis stays loopback-only with no
// password, and the ETL needs no Redis at all.
const POLL_MS = 15_000;

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

let lastSeenHeight = 0;

async function pollForNewBlock(): Promise<void> {
  try {
    const tip = await refreshTip();
    // Guard on > 0 so a transient database failure can never broadcast a zero
    // tip and blank the header on every connected client.
    if (tip.height > 0 && tip.height !== lastSeenHeight) {
      lastSeenHeight = tip.height;
      broadcastSSE({ type: 'block', block_number: tip.height, block_timestamp: tip.timestamp });
    }
  } catch (err) {
    console.error('Block poll failed (non-fatal):', (err as Error).message);
  }
}

// Called by the web server process at startup.
export async function startBlockPoller(): Promise<void> {
  // Seed first, so the tip that already exists isn't announced as new. Failure
  // is fine — height stays 0 and the first poll announces whatever it finds, to
  // an empty client set.
  try {
    lastSeenHeight = (await refreshTip()).height;
  } catch (err) {
    console.error('Initial tip read failed:', (err as Error).message);
  }
  const timer = setInterval(pollForNewBlock, POLL_MS);
  timer.unref();
}
