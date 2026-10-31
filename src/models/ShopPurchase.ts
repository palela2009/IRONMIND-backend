import { Schema, model } from 'mongoose';

const schema = new Schema({
  _id: { type: String, required: true },
  userId: { type: String, required: true, index: true },
  fingerprint: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

export const ShopPurchase = model('ShopPurchase', schema);
