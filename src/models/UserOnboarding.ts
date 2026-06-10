import { Schema, model, Document } from 'mongoose';

export interface IUserOnboarding extends Document {
  userId: string;
  targetApps: string[];
  goals: string[];
  difficultyLevel: string;
  createdAt: Date;
}

const userOnboardingSchema = new Schema<IUserOnboarding>({
  userId: { type: String, required: true, unique: true },
  targetApps: { type: [String], default: [] },
  goals: { type: [String], default: [] },
  difficultyLevel: { type: String, default: 'EASY' },
  createdAt: { type: Date, default: Date.now }
});

export const UserOnboarding = model<IUserOnboarding>('UserOnboarding', userOnboardingSchema);
