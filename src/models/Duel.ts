import { Schema, model, Document } from 'mongoose';

export type DuelStatus = 'pending' | 'active' | 'completed' | 'declined' | 'void';

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
  // Friendly app label ("TikTok"), matching what the client reports for screen time, so
  // both players are measured against the same name regardless of package differences.
  app: { type: String, required: true },
  stake: { type: Number, default: 100 },
  status: { type: String, enum: ['pending', 'active', 'completed', 'declined', 'void'], default: 'pending' },

  // Null until accepted — the rolling 24h window starts when the opponent agrees, not when
  // the challenge is sent, so a slow reply can't eat into the duel.
  startAt: { type: Date, default: null },
  endAt: { type: Date, default: null },

  // Each player's own device measures its own usage over the window and reports it. Null
  // means "never reported", which is what voids a duel rather than handing a free win.
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
