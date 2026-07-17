import { Request, Response, NextFunction } from 'express';
import { cacheGet, cacheSet } from '../services/redis.js';

// Redis-backed HTML cache for the canonical pages.
//
// THE WHITELIST IS THE SAFETY PROPERTY — do not replace it with a pattern that
// admits /block/:n, /transaction/:hash or /address/:addr. Redis runs with
// maxmemory=0 and maxmemory-policy=noeviction, so a cache keyed by an unbounded
// URL space would grow until writes *fail* rather than evict, taking the API
// cache in routes/api.ts down with it. These ~25 keys cannot do that. Caching
// the deep routes needs maxmemory + allkeys-lru set first (and buys little
// against a scraper walking distinct URLs — the hit rate is ~0).
//
// Registered ahead of the meta/tip middlewares in routes/pages.ts, so a hit
// serves without touching Postgres at all.

const TTL: Record<string, number> = {
  '/': 60,              // recent losses and the tip move every block
  '/losses': 60,        // per block
  '/quantum': 300,      // hourly snapshot data
  '/utxos': 300,        // hourly snapshot data
  '/about': 3600,       // changes only on deploy
  '/proposals': 3600,   // changes only on deploy
  '/sitemap.xml': 3600,
};

const PROPOSAL_RE = /^\/proposals\/\d{3}$/;
const PROPOSAL_TTL = 3600;

// Cached HTML embeds the header tip, so it can lag by up to the TTL. JS clients
// correct it from SSE within seconds (public/javascripts/header.ts); for no-JS
// clients the lag is bounded by the values above.
function ttlFor(originalUrl: string): number | null {
  const [path, query] = originalUrl.split('?');
  // A query string means a filtered/paginated variant (/losses?page=N&rule=X is
  // ~30k URLs) — bounded in principle, unbounded enough in practice. Skip.
  if (query) return null;
  if (TTL[path] !== undefined) return TTL[path];
  if (PROPOSAL_RE.test(path)) return PROPOSAL_TTL;
  return null;
}

interface Envelope {
  ct: string;
  body: string;
}

export function pageCache() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET') return next();

    const ttl = ttlFor(req.originalUrl);
    if (ttl === null) {
      res.locals.cacheStatus = '-';
      return next();
    }

    const key = `page:${req.originalUrl}`;
    const cacheControl = `public, max-age=${ttl}, stale-while-revalidate=${ttl * 3}`;

    // Redis being down must degrade to serving live, never to erroring.
    try {
      const hit = await cacheGet(key);
      if (hit) {
        const { ct, body }: Envelope = JSON.parse(hit);
        res.locals.cacheStatus = 'HIT';
        res.set('Content-Type', ct);
        res.set('Cache-Control', cacheControl);
        return res.send(body);
      }
    } catch { /* fall through and render live */ }

    res.locals.cacheStatus = 'MISS';
    res.set('Cache-Control', cacheControl);

    // res.render() ends up in res.send(), so wrapping send catches both.
    const originalSend = res.send.bind(res);
    res.send = ((body: unknown) => {
      // Only 200s: bot 404 scanning would otherwise fill Redis with junk keys.
      if (res.statusCode === 200 && typeof body === 'string') {
        const envelope: Envelope = {
          ct: res.get('Content-Type') || 'text/html; charset=utf-8',
          body,
        };
        cacheSet(key, JSON.stringify(envelope), ttl).catch(() => { /* non-fatal */ });
      }
      return originalSend(body);
    }) as typeof res.send;

    next();
  };
}
