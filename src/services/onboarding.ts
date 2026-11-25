import mongoose from 'mongoose';
import { UserOnboarding } from '../models/UserOnboarding';
import { validTimeZone } from './challengeTime';

const SETTINGS_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export async function saveOnboarding(uid: string, fields: Record<string, unknown>, requestedZone: unknown) {
  return mongoose.connection.transaction(async (session) => {
    let doc = await UserOnboarding.findOneAndUpdate({ uid, deletionRequestedAt: null }, { $inc: { progressRevision: 1 } }, { returnDocument: 'after', session });
    const wasUninitialized = !doc || (doc.targetApps.length === 0 && doc.challengeSettings.length === 0);
    if (!doc) doc = new UserOnboarding({ uid, welcomeGiftEligible: true });
    const snapshot = (effectiveAt = new Date()) => ({
      effectiveAt,
      difficultyLevel: doc!.difficultyLevel,
      dailyChallengeLimit: doc!.dailyChallengeLimit,
      targetApps: [...doc!.targetApps],
    });
    if (!wasUninitialized && !doc.challengeSettings.length) doc.challengeSettings.push(snapshot(doc.createdAt));
    const before = JSON.stringify([doc.difficultyLevel, doc.dailyChallengeLimit, doc.targetApps]);
    doc.set(fields);
    if (!doc.challengeTimeZone && validTimeZone(requestedZone)) doc.challengeTimeZone = requestedZone;
    const after = JSON.stringify([doc.difficultyLevel, doc.dailyChallengeLimit, doc.targetApps]);
    if (wasUninitialized) {
      doc.challengeSettings.push(snapshot(doc.createdAt));
    } else if (after !== before) {
      doc.challengeSettings.push(snapshot());
    }
    const cutoff = Date.now() - SETTINGS_RETENTION_MS;
    if (doc.challengeSettings.length > 25) {
      const recent = doc.challengeSettings.filter((s) => s.effectiveAt.getTime() >= cutoff);
      const older = doc.challengeSettings.filter((s) => s.effectiveAt.getTime() < cutoff);
      doc.challengeSettings = older.length ? [older[older.length - 1], ...recent] : recent;
    }
    await doc.save({ session });
    return doc;
  });
}
