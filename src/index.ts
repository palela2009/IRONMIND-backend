import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import statsRoutes from './routes/statsRoutes';
import userRoutes from './routes/userRoutes';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
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


app.use('/api/stats', statsRoutes);
app.use('/api/user', userRoutes);

app.get('/', (req: Request, res: Response) => {
  res.send('IRONMIND TypeScript API with MongoDB is running...');
});

app.listen(PORT, () => {
  console.log(`⚡️ [server]: Server is sprinting on port ${PORT}`);
});