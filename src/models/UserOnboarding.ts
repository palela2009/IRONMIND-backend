import { Schema, model, Document } from 'mongoose';

export interface IUserOnboarding extends Document {
  uid?: string;
  email?: string;
  displayName?: string;
  photoURL?: string;
  pushToken?: string | null;
  targetApps: string[];
  goals: string[];
  difficultyLevel: string;
  dailyChallengeLimit: number;
  createdAt: Date;
}

const userOnboardingSchema = new Schema<IUserOnboarding>({
  uid: { type: String, unique: true, sparse: true },
  email: { type: String },
  displayName: { type: String },
  photoURL: { type: String },
  pushToken: { type: String, default: null },
  targetApps: { type: [String], default: [] },
  goals: { type: [String], default: [] },
  difficultyLevel: { type: String, enum: ['EASY', 'INTERMEDIATE', 'HARD'], default: 'EASY' },
  dailyChallengeLimit: { type: Number, default: 5 },
  createdAt: { type: Date, default: Date.now }
});

export const UserOnboarding = model<IUserOnboarding>('UserOnboarding', userOnboardingSchema);
