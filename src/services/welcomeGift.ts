import mongoose from 'mongoose';
import { UserOnboarding } from '../models/UserOnboarding';

const THEMES = ['cyberpunk', 'ice', 'blood', 'ember', 'matrix'];

export class WelcomeGiftError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function claimWelcomeGift(uid: string, themeId: unknown) {
  if (typeof themeId !== 'string' || !THEMES.includes(themeId)) throw new WelcomeGiftError(400, 'Choose one of the welcome themes');
  return mongoose.connection.transaction(async (session) => {
    const doc = await UserOnboarding.findOneAndUpdate(
      { uid, deletionRequestedAt: null }, { $inc: { progressRevision: 1 } }, { returnDocument: 'after', session }
    );
    if (!doc) throw new WelcomeGiftError(409, 'Complete account setup first');
    if (doc.welcomeGiftClaimedAt) return doc;
    if (!doc.welcomeGiftEligible) throw new WelcomeGiftError(409, 'This account has no unclaimed welcome gift');
    if (!doc.unlockedThemes.includes(themeId)) doc.unlockedThemes.push(themeId);
    doc.themeId = themeId;
    doc.welcomeGiftTheme = themeId;
    doc.welcomeGiftClaimedAt = new Date();
    doc.welcomeGiftEligible = false;
    doc.streakFreezes += 1;
    await doc.save({ session });
    return doc;
  });
}
