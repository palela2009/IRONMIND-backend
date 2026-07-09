import { Schema, model, Document } from 'mongoose';

export interface IChallengeResult extends Document {
  userId: string;
  targetApp: string;
  elapsedTime: number;
  wasSuccessful: boolean;
  timestamp: number;
}

const challengeResultSchema = new Schema<IChallengeResult>({
  userId: { type: String, required: true, index: true },
  targetApp: { type: String, required: true },
  elapsedTime: { type: Number, required: true },
  wasSuccessful: { type: Boolean, required: true },
  timestamp: { type: Number, required: true },
});

export const ChallengeResult = model<IChallengeResult>('ChallengeResult', challengeResultSchema);
