import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import statsRoutes from './routes/statsRoutes';
import userRoutes from './routes/userRoutes';
import challengeRoutes from './routes/challengeRoutes';
import tokenRoutes from './routes/tokenRoutes';
import screenTimeRoutes from './routes/screenTimeRoutes';
import friendRoutes from './routes/friendRoutes';
import publicRoutes from './routes/publicRoutes';
import { verifyAuth } from './middleware/verifyAuth';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const MONGODB_URI = process.env.MONGODB_URI;

app.use(cors());
// Default 100kb is fine for everything except the profile-photo upload, which needs more
// room for a base64-encoded compressed JPEG.
app.use(express.json({ limit: '5mb' }));


if (!MONGODB_URI) {
  console.error('❌ Error: MONGODB_URI is missing in .env file!');
  process.exit(1);
}

mongoose
  .connect(MONGODB_URI)
  .then(() => console.log('🍃 [database]: Connected to MongoDB Atlas (Google Cloud)'))
  .catch((err) => console.error('❌ [database] Connection error:', err));


// Must come before the '/api' mount below — Express matches app.use() path prefixes in
// registration order, so '/api/public/...' would otherwise hit '/api' (tokenRoutes) first
// and get rejected by its verifyAuth before ever reaching this deliberately public route.
app.use('/api/public', publicRoutes);

app.use('/api/stats', verifyAuth, statsRoutes);
app.use('/api/user', verifyAuth, userRoutes);
app.use('/api/challenge', verifyAuth, challengeRoutes);
app.use('/api', verifyAuth, tokenRoutes);
app.use('/api/screentime', verifyAuth, screenTimeRoutes);
app.use('/api/friends', verifyAuth, friendRoutes);

app.get('/', (req: Request, res: Response) => {
  res.send('IRONMIND TypeScript API with MongoDB is running...');
});

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

app.listen(PORT,'0.0.0.0', () => {
  console.log(`⚡️ [server]: Server is sprinting on port ${PORT}`);

  // Render's free tier spins the service down after ~15 min of no inbound traffic.
  // Self-pinging well under that threshold keeps it warm so requests never hit a cold
  // start. Note this can only keep an already-running service awake — it cannot wake one
  // that has already spun down (nothing is running to fire the timer), so an external
  // uptime pinger is still the only way to guarantee it never sleeps.
  const selfUrl = process.env.RENDER_EXTERNAL_URL || 'https://ironmind-backend-l3o8.onrender.com';

  const ping = async (attempt = 1): Promise<void> => {
    try {
      const res = await fetch(`${selfUrl}/health`);
      console.log(`💓 [keep-alive]: ping ${res.status}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`💓 [keep-alive]: ping failed (attempt ${attempt}):`, message);
      // Retry once shortly after rather than leaving a full interval of silence, which
      // could otherwise let the idle timer run out after a single transient failure.
      if (attempt < 3) setTimeout(() => ping(attempt + 1), 30_000);
    }
  };

  setTimeout(() => ping(), 20_000);
  setInterval(() => ping(), 4 * 60 * 1000);
});