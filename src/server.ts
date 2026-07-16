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

// One line per request. svlogd (-tt) prefixes the timestamp, so don't add one.
app.use((req, res, next) => {
  const start = performance.now();
  let logged = false;
  const log = () => {
    if (logged) return; // 'finish' and 'close' can both fire
    logged = true;
    const ms = (performance.now() - start).toFixed(1);
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
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
