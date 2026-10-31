import mongoose from 'mongoose';
import admin from '../config/firebaseAdmin';
import { UserOnboarding } from '../models/UserOnboarding';
import { UserStats } from '../models/UserStats';
import { ChallengeResult } from '../models/ChallengeResult';
import { ChallengeDay } from '../models/ChallengeDay';
import { ScreenTime } from '../models/ScreenTime';
import { FriendRequest } from '../models/FriendRequest';
import { Duel } from '../models/Duel';
import { ShopPurchase } from '../models/ShopPurchase';

export async function deleteAccount(uid: string) {
  await mongoose.connection.transaction(async (session) => {
    await UserOnboarding.updateOne({ uid }, { $set: { deletionRequestedAt: new Date(), pushToken: null }, $inc: { progressRevision: 1 } }, { session });
    const duels = await Duel.find({ status: 'active', $or: [{ fromUid: uid }, { toUid: uid }] }).session(session);
    for (const duel of duels) {
      if (duel.stake > 0) {
        const opponent = duel.fromUid === uid ? duel.toUid : duel.fromUid;
        await UserOnboarding.updateOne({ uid: opponent }, { $inc: { coins: duel.stake } }, { session });
      }
    }
    await Duel.deleteMany({ $or: [{ fromUid: uid }, { toUid: uid }] }, { session });
    await UserStats.deleteOne({ userId: uid }, { session });
    await ChallengeResult.deleteMany({ userId: uid }, { session });
    await ChallengeDay.deleteMany({ userId: uid }, { session });
    await ShopPurchase.deleteMany({ userId: uid }, { session });
    await ScreenTime.deleteMany({ userId: uid }, { session });
    await FriendRequest.deleteMany({ $or: [{ fromUid: uid }, { toUid: uid }] }, { session });
    await UserOnboarding.updateMany({ referredBy: uid }, { $set: { referredBy: null, referralActivatedAt: null } }, { session });
  });
  try { await admin.auth().deleteUser(uid); }
  catch (error) { if ((error as { code?: string }).code !== 'auth/user-not-found') throw error; }
  await UserOnboarding.deleteOne({ uid, deletionRequestedAt: { $ne: null } });
}
