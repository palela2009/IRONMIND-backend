import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import statsRoutes from './routes/statsRoutes';
import userRoutes from './routes/userRoutes';
import challengeRoutes from './routes/challengeRoutes';
import tokenRoutes from './routes/tokenRoutes';
import screenTimeRoutes from './routes/screenTimeRoutes';
import friendRoutes from './routes/friendRoutes';
import duelRoutes from './routes/duelRoutes';
import proRoutes from './routes/proRoutes';
import coinRoutes from './routes/coinRoutes';
import publicRoutes from './routes/publicRoutes';
import revenuecatRoutes from './routes/revenuecatRoutes';
import syncRoutes from './routes/syncRoutes';
import { verifyAuth } from './middleware/verifyAuth';
import { apiLimiter, strictActionLimiter, publicPhotoLimiter, verifySyncToken, jsonErrorHandler } from './middleware/security';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const MONGODB_URI = process.env.MONGODB_URI;

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors());
app.use('/api/user/photo', express.json({ limit: '2mb' }));
app.use(express.json({ limit: '100kb' }));

if (!MONGODB_URI) {
  console.error('MONGODB_URI is missing in environment');
  process.exit(1);
}

app.use('/api/public', publicPhotoLimiter, publicRoutes);
app.use('/api/revenuecat', strictActionLimiter, revenuecatRoutes);
app.use('/api/sync', apiLimiter, verifySyncToken, syncRoutes);

app.use('/api/friends/add', strictActionLimiter);
app.use('/api/stats', apiLimiter, verifyAuth, statsRoutes);
app.use('/api/user', apiLimiter, verifyAuth, userRoutes);
app.use('/api/challenge', apiLimiter, verifyAuth, challengeRoutes);
app.use('/api/save-token', apiLimiter, verifyAuth, tokenRoutes);
app.use('/api/screentime', apiLimiter, verifyAuth, screenTimeRoutes);
app.use('/api/friends', apiLimiter, verifyAuth, friendRoutes);
app.use('/api/duels', apiLimiter, verifyAuth, duelRoutes);
app.use('/api/pro', apiLimiter, verifyAuth, proRoutes);
app.use('/api/coins', apiLimiter, verifyAuth, coinRoutes);

app.get('/', (_req: Request, res: Response) => {
  res.send('IRONMIND TypeScript API with MongoDB is running...');
});

app.get('/health', (_req: Request, res: Response) => {
  const ready = mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'starting', revision: process.env.RENDER_GIT_COMMIT ?? null });
});

app.use(jsonErrorHandler);

let keepAliveTimer: NodeJS.Timeout | null = null;
let server: ReturnType<typeof app.listen> | null = null;

async function start() {
  try {
    await mongoose.connect(MONGODB_URI!, {
      serverSelectionTimeoutMS: 10_000,
      socketTimeoutMS: 45_000,
      maxPoolSize: 20,
    });
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('Initial MongoDB connection failed:', err);
    process.exit(1);
  }

  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
    const selfUrl = process.env.RENDER_EXTERNAL_URL;
    if (!selfUrl) return;

    const ping = async (attempt = 1): Promise<void> => {
      try {
        const res = await fetch(`${selfUrl}/health`, { signal: AbortSignal.timeout(10_000) });
        await res.body?.cancel();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`keep-alive ping failed (attempt ${attempt}):`, message);
        if (attempt < 3) setTimeout(() => ping(attempt + 1), 30_000);
      }
    };

    setTimeout(() => ping(), 20_000);
    keepAliveTimer = setInterval(() => ping(), 4 * 60 * 1000);
  });
}

async function shutdown(signal: string) {
  console.log(`Shutting down on ${signal}`);
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));

void start();
