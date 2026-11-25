import { Schema, model, Document } from 'mongoose';

export interface IFriendRequest extends Document {
  fromUid: string;
  toUid: string;
  status: 'pending' | 'accepted';
  createdAt: Date;
}

const friendRequestSchema = new Schema<IFriendRequest>({
  fromUid: { type: String, required: true },
  toUid: { type: String, required: true },
  status: { type: String, enum: ['pending', 'accepted'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
});

friendRequestSchema.index({ fromUid: 1, toUid: 1 }, { unique: true });
friendRequestSchema.index({ toUid: 1, status: 1, createdAt: -1 });
friendRequestSchema.index({ fromUid: 1, status: 1 });

export const FriendRequest = model<IFriendRequest>('FriendRequest', friendRequestSchema);