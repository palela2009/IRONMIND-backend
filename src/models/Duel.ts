import { Schema, model, Document } from 'mongoose';

export type DuelStatus = 'pending' | 'active' | 'completed' | 'declined' | 'void' | 'cancelled';

export interface IDuel extends Document {
  fromUid: string;
  toUid: string;
  app: string;
  stake: number;
  status: DuelStatus;
  startAt: Date | null;
  endAt: Date | null;
  fromMinutes: number | null;
  toMinutes: number | null;
  fromReportedAt: Date | null;
  toReportedAt: Date | null;
  winnerUid: string | null;
  createdAt: Date;
}

const duelSchema = new Schema<IDuel>({
  fromUid: { type: String, required: true },
  toUid: { type: String, required: true },
  app: { type: String, required: true },
  stake: { type: Number, default: 100 },
  status: { type: String, enum: ['pending', 'active', 'completed', 'declined', 'void', 'cancelled'], default: 'pending' },

  startAt: { type: Date, default: null },
  endAt: { type: Date, default: null },

  fromMinutes: { type: Number, default: null },
  toMinutes: { type: Number, default: null },
  fromReportedAt: { type: Date, default: null },
  toReportedAt: { type: Date, default: null },

  winnerUid: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});

duelSchema.index({ fromUid: 1, status: 1 });
duelSchema.index({ toUid: 1, status: 1 });

export const Duel = model<IDuel>('Duel', duelSchema);
