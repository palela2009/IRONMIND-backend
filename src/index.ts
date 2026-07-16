import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import statsRoutes from './routes/statsRoutes';
import userRoutes from './routes/userRoutes';
import challengeRoutes from './routes/challengeRoutes';
import tokenRoutes from './routes/tokenRoutes';
import screenTimeRoutes from './routes/screenTimeRoutes';
import { verifyAuth } from './middleware/verifyAuth';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const MONGODB_URI = process.env.MONGODB_URI;

app.use(cors());
app.use(express.json());


if (!MONGODB_URI) {
  console.error('❌ Error: MONGODB_URI is missing in .env file!');
  process.exit(1);
}

mongoose
  .connect(MONGODB_URI)
  .then(() => console.log('🍃 [database]: Connected to MongoDB Atlas (Google Cloud)'))
  .catch((err) => console.error('❌ [database] Connection error:', err));


app.use('/api/stats', verifyAuth, statsRoutes);
app.use('/api/user', verifyAuth, userRoutes);
app.use('/api/challenge', verifyAuth, challengeRoutes);
app.use('/api', verifyAuth, tokenRoutes);
app.use('/api/screentime', verifyAuth, screenTimeRoutes);

app.get('/', (req: Request, res: Response) => {
  res.send('IRONMIND TypeScript API with MongoDB is running...');
});

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

app.listen(PORT,'0.0.0.0', () => {
  console.log(`⚡️ [server]: Server is sprinting on port ${PORT}`);

  // Render's free tier spins the service down after ~15 min of no inbound traffic.
  // Self-pinging well under that threshold keeps it warm so requests never hit a cold start.
  const selfUrl = process.env.RENDER_EXTERNAL_URL || 'https://ironmind-backend-l3o8.onrender.com';
  setInterval(() => {
    fetch(`${selfUrl}/health`)
      .then((res) => console.log(`💓 [keep-alive]: ping ${res.status}`))
      .catch((err) => console.error('💓 [keep-alive]: ping failed:', err.message));
  }, 5 * 60 * 1000);
});