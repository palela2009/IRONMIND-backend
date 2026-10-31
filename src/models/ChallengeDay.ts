import { Schema, model } from 'mongoose';

const schema = new Schema({
  _id: { type: String, required: true },
  userId: { type: String, required: true, index: true },
  count: { type: Number, default: 0 },
  wins: { type: Number, default: 0 },
  limit: { type: Number, required: true },
  coins: { type: Number, default: 0 },
  perfectAwarded: { type: Boolean, default: false },
});

export const ChallengeDay = model('ChallengeDay', schema);
