import { Schema, model, Document } from 'mongoose';

export interface IChallengeResult extends Document {
  userId: string;
  eventId?: string;
  counted: boolean;
  freezeUsed: boolean;
  coinsGranted: number;
  reclaimed: boolean;
  targetApp: string;
  challengeKind?: 'instagram_reels';
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
  challengeKind: { type: String, enum: ['instagram_reels'] },
  elapsedTime: { type: Number, required: true },
  wasSuccessful: { type: Boolean, required: true },
  timestamp: { type: Number, required: true },
});

challengeResultSchema.index({ userId: 1, eventId: 1 }, { unique: true, partialFilterExpression: { eventId: { $type: 'string' } } });

export const ChallengeResult = model<IChallengeResult>('ChallengeResult', challengeResultSchema);
