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

app.use(express.static(path.join(process.cwd(), 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use('/api/v1', apiRoutes);
app.use('/', pageRoutes);

async function start() {
  await connectRedis();
  await initSSESubscriber();
  app.listen(config.server.port, () => {
    console.log(`Server running on port ${config.server.port}`);
  });
}

start().catch(console.error);
