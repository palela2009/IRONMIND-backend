import mongoose from 'mongoose';
import { UserOnboarding } from '../models/UserOnboarding';
import { validTimeZone } from './challengeTime';

export async function saveOnboarding(uid: string, fields: Record<string, unknown>, requestedZone: unknown) {
  return mongoose.connection.transaction(async (session) => {
    let doc = await UserOnboarding.findOneAndUpdate({ uid, deletionRequestedAt: null }, { $inc: { progressRevision: 1 } }, { returnDocument: 'after', session });
    if (!doc) doc = new UserOnboarding({ uid });
    const snapshot = () => ({ effectiveAt: new Date(), difficultyLevel: doc!.difficultyLevel, dailyChallengeLimit: doc!.dailyChallengeLimit, targetApps: [...doc!.targetApps] });
    if (!doc.challengeSettings.length) doc.challengeSettings.push({ ...snapshot(), effectiveAt: doc.createdAt });
    const before = JSON.stringify([doc.difficultyLevel, doc.dailyChallengeLimit, doc.targetApps]);
    doc.set(fields);
    if (!doc.challengeTimeZone && validTimeZone(requestedZone)) doc.challengeTimeZone = requestedZone;
    const after = JSON.stringify([doc.difficultyLevel, doc.dailyChallengeLimit, doc.targetApps]);
    if (after !== before) doc.challengeSettings.push(snapshot());
    await doc.save({ session });
    return doc;
  });
}
