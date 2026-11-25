import { Schema, model, Document } from 'mongoose';

export const SCROLL_CHALLENGE_APPS = {
  instagram_reels: 'Instagram',
  facebook_reels: 'Facebook',
  tiktok_feed: 'TikTok',
  youtube_shorts: 'YouTube',
} as const;

export type ScrollChallengeKind = keyof typeof SCROLL_CHALLENGE_APPS;

export interface IChallengeResult extends Document {
  userId: string;
  eventId?: string;
  counted: boolean;
  freezeUsed: boolean;
  coinsGranted: number;
  reclaimed: boolean;
  targetApp: string;
  challengeKind?: ScrollChallengeKind;
  elapsedTime: number;
  wasSuccessful: boolean;
  timestamp: number;
}

const challengeResultSchema = new Schema<IChallengeResult>({
  userId: { type: String, required: true, index: true },
  eventId: { type: String },
  counted: { type: Boolean, default: true },
  freezeUsed: { type: Boolean, default: false },
  coinsGranted: { type: Number, default: 0 },
  reclaimed: { type: Boolean, default: false },
  targetApp: { type: String, required: true },
  challengeKind: { type: String, enum: Object.keys(SCROLL_CHALLENGE_APPS) },
  elapsedTime: { type: Number, required: true },
  wasSuccessful: { type: Boolean, required: true },
  timestamp: { type: Number, required: true },
});

challengeResultSchema.index({ userId: 1, eventId: 1 }, { unique: true, partialFilterExpression: { eventId: { $type: 'string' } } });
challengeResultSchema.index({ userId: 1, timestamp: -1, _id: -1 });

export const ChallengeResult = model<IChallengeResult>('ChallengeResult', challengeResultSchema);
