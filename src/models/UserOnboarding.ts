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
  appLimits: { app: string; minutes: number }[];
  inviteCode?: string;
  proPlan: 'monthly' | 'annual' | 'lifetime' | null;
  proExpiresAt: Date | null;
  proSource: 'store' | 'coins' | 'owner' | null;
  streakFreezes: number;
  freezesRefilledAt: Date | null;
  welcomeOfferClosedAt: Date | null;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  coins: number;
  starterCoinsGrantedAt: Date | null;
  ownerCoinsGrantedAt: Date | null;
  coinEarnDate: string | null;
  coinEarnedToday: number;
  unlockedThemes: string[];
  ownedFrames: string[];
  ownedNameEffects: string[];
  equippedFrame: string | null;
  equippedNameEffect: string | null;
  proFromCoinsAt: Date | null;
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

  appLimits: {
    type: [{ app: { type: String, required: true }, minutes: { type: Number, required: true, min: 0 } }],
    default: [],
  },
  inviteCode: { type: String, unique: true, sparse: true },

  proPlan: { type: String, enum: ['monthly', 'annual', 'lifetime', null], default: null },
  proExpiresAt: { type: Date, default: null },
  proSource: { type: String, enum: ['store', 'coins', 'owner', null], default: null },

  streakFreezes: { type: Number, default: 0 },
  freezesRefilledAt: { type: Date, default: null },

  welcomeOfferClosedAt: { type: Date, default: null },

  trialStartedAt: { type: Date, default: null },
  trialEndsAt: { type: Date, default: null },

  coins: { type: Number, default: 0 },

  starterCoinsGrantedAt: { type: Date, default: null },

  ownerCoinsGrantedAt: { type: Date, default: null },
  coinEarnDate: { type: String, default: null },
  coinEarnedToday: { type: Number, default: 0 },
  unlockedThemes: { type: [String], default: [] },

  ownedFrames: { type: [String], default: [] },
  ownedNameEffects: { type: [String], default: [] },
  equippedFrame: { type: String, default: null },
  equippedNameEffect: { type: String, default: null },

  proFromCoinsAt: { type: Date, default: null },
  themeId: { type: String, default: 'default' },

  createdAt: { type: Date, default: Date.now }
});

export const UserOnboarding = model<IUserOnboarding>('UserOnboarding', userOnboardingSchema);
