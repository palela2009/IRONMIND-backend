import { Schema, model, Document } from 'mongoose';

export interface IUserStats extends Document {
  userId: string;
  currentStreak: number;
  longestStreak: number;
  bestReactionTime: number;
  totalChallenges: number;
  successCount: number;
  currentXP: number;
  level: number;
  updatedAt: Date;
}

const userStatsSchema = new Schema<IUserStats>({
  userId: { type: String, required: true, unique: true, sparse: true },
  currentStreak: { type: Number, default: 0 },
  longestStreak: { type: Number, default: 0 },
  bestReactionTime: { type: Number, default: 0 },
  totalChallenges: { type: Number, default: 0 },
  successCount: { type: Number, default: 0 },
  currentXP: { type: Number, default: 0 },
  level: { type: Number, default: 1 },
  updatedAt: { type: Date, default: Date.now }
});

export const UserStats = model<IUserStats>('UserStats', userStatsSchema);