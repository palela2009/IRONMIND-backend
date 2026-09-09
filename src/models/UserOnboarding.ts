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

  // Per-app daily minute budgets. Kept separate from targetApps rather than replacing it,
  // so an app can be monitored without carrying a budget and existing accounts keep working.
  appLimits: {
    type: [{ app: { type: String, required: true }, minutes: { type: Number, required: true, min: 0 } }],
    default: [],
  },
  inviteCode: { type: String, unique: true, sparse: true },

  proPlan: { type: String, enum: ['monthly', 'annual', 'lifetime', null], default: null },
  proExpiresAt: { type: Date, default: null },

  streakFreezes: { type: Number, default: 0 },
  freezesRefilledAt: { type: Date, default: null },

  // Tracked per account rather than on the device so reinstalling, or signing in on a
  // second phone, cannot resurrect a one-time offer the user already declined.
  welcomeOfferClosedAt: { type: Date, default: null },

  // An app-side trial, granted once per account. This is a stand-in for Google Play's own
  // free trial, which cannot exist until there is a Play Console subscription to attach it
  // to. trialStartedAt is what makes it once-only: it is never cleared, so a lapsed trial
  // cannot be restarted by the same account.
  trialStartedAt: { type: Date, default: null },
  trialEndsAt: { type: Date, default: null },

  // Coins live here rather than on UserStats because UserStats is written wholesale by the
  // client. A currency that can be spent against other players in duels has to be changed
  // only through endpoints that decide the amounts themselves.
  coins: { type: Number, default: 0 },

  // Granted once, on first read. Without a starting balance nobody could afford a duel ante
  // until they had won ten challenges, so the whole duel feature was unreachable on a new
  // account. Recorded as a timestamp rather than a boolean so it cannot be re-granted.
  starterCoinsGrantedAt: { type: Date, default: null },

  // Separate from the starter grant so an owner account still receives it once, even though
  // it was created long before this existed. A timestamp rather than a boolean, so the grant
  // cannot silently repeat on every entitlement read.
  ownerCoinsGrantedAt: { type: Date, default: null },
  coinEarnDate: { type: String, default: null },
  coinEarnedToday: { type: Number, default: 0 },
  unlockedThemes: { type: [String], default: [] },

  ownedFrames: { type: [String], default: [] },
  ownedNameEffects: { type: [String], default: [] },
  equippedFrame: { type: String, default: null },
  equippedNameEffect: { type: String, default: null },

  // When Pro was last bought with coins. Enforces the once-a-month limit, which matters more
  // than the price: without it a determined player farms coins forever and never subscribes.
  proFromCoinsAt: { type: Date, default: null },
  themeId: { type: String, default: 'default' },

  createdAt: { type: Date, default: Date.now }
});

export const UserOnboarding = model<IUserOnboarding>('UserOnboarding', userOnboardingSchema);
