import { Schema, model, Document } from 'mongoose';

export interface IUserStats extends Document {
  userId: string;
  level: number;
  currentXP: number;
  currentStreak: number;
  totalReps: number;
  bestReactionTime: number;
  updatedAt: Date;
}

const userStatsSchema = new Schema<IUserStats>({
  userId: { type: String, required: true, unique: true },
  level: { type: Number, default: 1 },
  currentXP: { type: Number, default: 0 },
  currentStreak: { type: Number, default: 0 },
  totalReps: { type: Number, default: 0 },
  bestReactionTime: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now }
});

export const UserStats = model<IUserStats>('UserStats', userStatsSchema);