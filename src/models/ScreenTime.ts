import { Schema, model, Document } from 'mongoose';

export interface IScreenTimeEntry {
  app: string;
  minutes: number;
}

export interface IScreenTime extends Document {
  userId: string;
  date: string; // YYYY-MM-DD
  apps: IScreenTimeEntry[];
  updatedAt: Date;
}

const screenTimeSchema = new Schema<IScreenTime>({
  userId: { type: String, required: true },
  date: { type: String, required: true }, // e.g. "2026-07-07"
  apps: [
    {
      app: { type: String, required: true },
      minutes: { type: Number, required: true, min: 0 },
    },
  ],
  updatedAt: { type: Date, default: Date.now },
});

// Compound unique key: one record per user per day
screenTimeSchema.index({ userId: 1, date: 1 }, { unique: true });

export const ScreenTime = model<IScreenTime>('ScreenTime', screenTimeSchema);
