import { Response } from 'express';

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
