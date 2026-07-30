import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { connectRedis } from './services/redis.js';
import { startBlockPoller } from './services/sse.js';
import { localCache } from './services/local-cache.js';
import apiRoutes from './routes/api.js';
import pageRoutes from './routes/pages.js';
import { config } from './config.js';

const app = express();

app.set('view engine', 'pug');
app.set('views', path.join(process.cwd(), 'views'));

// Express only enables this itself when NODE_ENV === 'production' (see
// express/lib/application.js: `if (env === 'production') this.enable('view
// cache')`), and it passes the flag straight through to Pug as `cache`. With it
// off, every render re-reads and recompiles the template — for /address that is
// address.pug plus layout.pug (extends) and mixins.pug (include), lexed, parsed,
// codegen'd and handed to new Function() on each request. It measured as ~90% of
// one core in userland at ~32 req/s, and the throwaway functions add GC pressure
// on top.
//
// Set explicitly rather than left to NODE_ENV: an unset variable silently
// multiplying per-request CPU is how this got missed in the first place.
app.set('view cache', true);

// We sit behind nginx, so req.ip should come from X-Forwarded-For — but only
// when the hop is trusted, or any client could forge its own address.
app.set('trust proxy', config.server.trustProxy);

// Cloudflare caches static assets at the edge for hours, so a deploy has to
// change asset URLs or browsers keep applying stale CSS/JS to fresh HTML.
// Newest mtime across the linked assets, base36; views append it as ?v=.
const assetFiles = [
  'public/stylesheets/ledger.css',
  'public/javascripts/dist/header.js',
  'public/javascripts/dist/home.css',
  'public/javascripts/dist/home.js',
  'public/javascripts/dist/utxos.js',
];
app.locals.assetV = Math.max(
  ...assetFiles.map((f) => {
    try {
      return fs.statSync(path.join(process.cwd(), f)).mtimeMs;
    } catch {
      return 0;
    }
  }),
).toString(36);

// Fallback social-preview metadata so layout.pug can always render, even for
// views reached outside the pages router (which sets res.locals.meta per page).
app.locals.meta = {
  type: 'website',
  url: config.server.publicUrl,
  image: config.server.publicUrl + '/images/og-card.png',
  imageAlt: 'bitcoin-supply — the effective Bitcoin supply explorer',
  description:
    'Tracking Bitcoin’s effective supply: how much of the 21M cap is provably lost, ' +
    'probably lost, dormant, or exposed to a quantum attacker — measured UTXO by UTXO ' +
    'from full-chain analysis.',
};

// Client address for the log. Prefer Cloudflare's CF-Connecting-IP, which holds
// the true client: req.ip can't reach it, because `trust proxy` is 'loopback'
// and so resolves only as far as the nginx hop, leaving the Cloudflare edge
// address. That made the log useless for identifying abuse — one scraper walking
// the deep routes showed up as 237 distinct edge IPs, none of them the client.
//
// Trusting a client-settable header is only safe because nginx restricts this
// vhost to Cloudflare's ranges (the `deny all` after the allow-list in
// nginx.conf), so nothing else can reach the origin to forge it. If that
// allow-list is ever loosened, this has to go back to req.ip.
//
// Falls back to req.ip, then the socket peer. Node reports IPv4 peers on a
// dual-stack socket as ::ffff:1.2.3.4 — log the plain IPv4 form.
function clientIp(req: express.Request): string {
  // Cloudflare sends exactly one address, no list. Anything containing
  // whitespace did not come from Cloudflare and would break the field layout of
  // the log line below, so it is ignored rather than logged.
  const cf = req.get('cf-connecting-ip');
  const ip = (cf && !/\s/.test(cf) && cf) || req.ip || req.socket.remoteAddress || '-';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

// User-Agent, last and quoted so the line stays awk-parseable on whitespace.
// Truncated because crawlers send novels, and quotes stripped so the field
// can't be broken from outside.
function userAgent(req: express.Request): string {
  return (req.get('user-agent') || '-').replace(/"/g, "'").slice(0, 120);
}

// One line per request. svlogd (-tt) prefixes the timestamp, so don't add one.
// Format: <ip> <method> <url> <status> <ms> <cache> "<user-agent>"
app.use((req, res, next) => {
  const start = performance.now();
  const ip = clientIp(req); // capture now; the socket is gone by 'close'
  const ua = userAgent(req);
  let logged = false;
  const log = () => {
    if (logged) return; // 'finish' and 'close' can both fire
    logged = true;
    const ms = (performance.now() - start).toFixed(1);
    // Set by the page cache; '-' for routes it doesn't cover.
    const cache = res.locals.cacheStatus || '-';
    console.log(`${ip} ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms ${cache} "${ua}"`);
  };
  res.on('finish', log); // response fully handed off
  res.on('close', log);  // client hung up early
  next();
});

app.use(express.static(path.join(process.cwd(), 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use('/api/v1', apiRoutes);
app.use('/', pageRoutes);

async function start() {
  localCache.init();
  await connectRedis();
  await startBlockPoller();
  const server = app.listen(config.server.port, config.server.host, () => {
    console.log(`Server listening on ${config.server.host}:${config.server.port}`);
  });

  // nginx proxies with an upstream keepalive pool and holds idle connections
  // for 60s. Node's default keepAliveTimeout is 5s, so it would close
  // connections nginx still believes are good and is about to reuse — the
  // request then fails on a dead socket. Outlive nginx's idle window instead.
  // headersTimeout must exceed keepAliveTimeout: it bounds the same wait, so a
  // smaller value would fire first and close the connection anyway.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
}

start().catch(console.error);
