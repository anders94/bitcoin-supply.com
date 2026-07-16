import 'dotenv/config';
import express from 'express';
import path from 'path';
import { connectRedis } from './services/redis.js';
import { initSSESubscriber } from './services/sse.js';
import apiRoutes from './routes/api.js';
import pageRoutes from './routes/pages.js';
import { config } from './config.js';

const app = express();

app.set('view engine', 'pug');
app.set('views', path.join(process.cwd(), 'views'));

// We sit behind nginx, so req.ip should come from X-Forwarded-For — but only
// when the hop is trusted, or any client could forge its own address.
app.set('trust proxy', config.server.trustProxy);

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

// Client address for the log: req.ip resolves X-Forwarded-For per the trust
// proxy setting above, falling back to the socket peer. Node reports IPv4 peers
// on a dual-stack socket as ::ffff:1.2.3.4 — log the plain IPv4 form.
function clientIp(req: express.Request): string {
  const ip = req.ip || req.socket.remoteAddress || '-';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

// One line per request. svlogd (-tt) prefixes the timestamp, so don't add one.
app.use((req, res, next) => {
  const start = performance.now();
  const ip = clientIp(req); // capture now; the socket is gone by 'close'
  let logged = false;
  const log = () => {
    if (logged) return; // 'finish' and 'close' can both fire
    logged = true;
    const ms = (performance.now() - start).toFixed(1);
    console.log(`${ip} ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
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
  await connectRedis();
  await initSSESubscriber();
  app.listen(config.server.port, config.server.host, () => {
    console.log(`Server listening on ${config.server.host}:${config.server.port}`);
  });
}

start().catch(console.error);
