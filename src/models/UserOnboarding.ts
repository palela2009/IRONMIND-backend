import { Schema, model, Document } from 'mongoose';

export interface IUserOnboarding extends Document {
  uid?: string;
  email?: string;
  displayName?: string;
  photoURL?: string;
  photoData?: Buffer;
  photoContentType?: string;
  pushToken?: string | null;
  targetApps: string[];
  goals: string[];
  difficultyLevel: string;
  dailyChallengeLimit: number;
  inviteCode?: string;
  proPlan: 'monthly' | 'annual' | 'lifetime' | null;
  proExpiresAt: Date | null;
  streakFreezes: number;
  themeId: string;
  createdAt: Date;
}

const userOnboardingSchema = new Schema<IUserOnboarding>({
  uid: { type: String, unique: true, sparse: true },
  email: { type: String },
  displayName: { type: String },
  photoURL: { type: String },
  photoData: { type: Buffer, select: false },
  photoContentType: { type: String },
  pushToken: { type: String, default: null },
  targetApps: { type: [String], default: [] },
  goals: { type: [String], default: [] },
  difficultyLevel: { type: String, enum: ['EASY', 'INTERMEDIATE', 'HARD'], default: 'EASY' },
  dailyChallengeLimit: { type: Number, default: 5 },
  inviteCode: { type: String, unique: true, sparse: true },

  // Deliberately no `isPro` boolean. Entitlement is derived from plan + expiry every time
  // it's read, so it can't drift: a stored flag left true after a subscription lapsed would
  // be an unnoticed free subscription, and the two would have to be kept in sync forever.
  // Lifetime is represented as a plan with no expiry rather than a separate flag.
  proPlan: { type: String, enum: ['monthly', 'annual', 'lifetime', null], default: null },
  proExpiresAt: { type: Date, default: null },

  // Consumable, not a boolean — a freeze is spent to absorb one failed challenge, and both
  // Pro grants and rewarded ads top the same counter up.
  streakFreezes: { type: Number, default: 0 },
  themeId: { type: String, default: 'default' },

  createdAt: { type: Date, default: Date.now }
});

export const UserOnboarding = model<IUserOnboarding>('UserOnboarding', userOnboardingSchema);
