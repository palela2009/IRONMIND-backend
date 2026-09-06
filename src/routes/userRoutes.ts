import { Router, Request, Response } from 'express';
import { UserOnboarding } from '../models/UserOnboarding';
import { UserStats } from '../models/UserStats';
import { ChallengeResult } from '../models/ChallengeResult';
import { ScreenTime } from '../models/ScreenTime';
import { FriendRequest } from '../models/FriendRequest';
import { Duel } from '../models/Duel';
import admin from '../config/firebaseAdmin';

const router = Router();

router.get('/onboarding', async (req: Request, res: Response): Promise<any> => {
  try {
    const doc = await UserOnboarding.findOne({ uid: req.uid });
    if (!doc || doc.targetApps.length === 0) {
      return res.status(200).json({ onboarded: false });
    }
    return res.status(200).json({
      onboarded: true,
      targetApps: doc.targetApps,
      goals: doc.goals,
      difficultyLevel: doc.difficultyLevel,
      dailyChallengeLimit: doc.dailyChallengeLimit,
      appLimits: doc.appLimits ?? [],
    });
  } catch (error) {
    console.error('Error fetching onboarding:', error);
    return res.status(500).json({ message: 'Server error while fetching onboarding' });
  }
});

router.post('/onboarding', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = req.uid;
    const { email, displayName, photoURL, targetApps, goals, difficultyLevel, dailyChallengeLimit, appLimits } = req.body;

    const existing = await UserOnboarding.findOne({ uid });

    if (!existing && (!targetApps || !goals || !difficultyLevel)) {
      return res.status(400).json({ message: 'targetApps, goals, and difficultyLevel are required' });
    }

    const setFields: Record<string, unknown> = { uid };
    if (email !== undefined) setFields.email = email;
    if (displayName !== undefined) setFields.displayName = displayName;
    if (photoURL !== undefined) setFields.photoURL = photoURL;
    if (targetApps !== undefined) setFields.targetApps = targetApps;
    if (goals !== undefined) setFields.goals = goals;
    if (difficultyLevel !== undefined) setFields.difficultyLevel = difficultyLevel;
    if (dailyChallengeLimit !== undefined) setFields.dailyChallengeLimit = dailyChallengeLimit;
    if (Array.isArray(appLimits)) {
      setFields.appLimits = appLimits
        .filter((l: any) => typeof l?.app === 'string' && Number.isFinite(l?.minutes) && l.minutes >= 0)
        .map((l: any) => ({ app: l.app, minutes: Math.round(l.minutes) }));
    }

    const onboarding = await UserOnboarding.findOneAndUpdate(
      { uid },
      { $set: setFields },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    console.log(`🧠 [API]: Onboarding saved for user: ${uid}`);

    return res.status(200).json(onboarding);
  } catch (error) {
    console.error('Error saving onboarding:', error);
    return res.status(500).json({ message: 'Server error while saving onboarding' });
  }
});

router.post('/photo', async (req: Request, res: Response): Promise<any> => {
  try {
    const { imageBase64, contentType } = req.body;
    if (!imageBase64 || !contentType) {
      return res.status(400).json({ message: 'imageBase64 and contentType are required' });
    }

    const buffer = Buffer.from(imageBase64, 'base64');
    if (buffer.length > 4 * 1024 * 1024) {
      return res.status(413).json({ message: 'Image too large' });
    }

    await UserOnboarding.findOneAndUpdate(
      { uid: req.uid },
      { $set: { photoData: buffer, photoContentType: contentType } },
      { upsert: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json({ message: 'Photo uploaded' });
  } catch (error) {
    console.error('Error uploading photo:', error);
    return res.status(500).json({ message: 'Server error while uploading photo' });
  }
});

router.delete('/account', async (req: Request, res: Response): Promise<any> => {
  const uid = req.uid;
  try {
    await Promise.all([
      UserOnboarding.deleteOne({ uid }),
      UserStats.deleteOne({ userId: uid }),
      ChallengeResult.deleteMany({ userId: uid }),
      ScreenTime.deleteMany({ userId: uid }),
      FriendRequest.deleteMany({ $or: [{ fromUid: uid }, { toUid: uid }] }),
      Duel.deleteMany({ $or: [{ fromUid: uid }, { toUid: uid }] }),
    ]);

    try {
      await admin.auth().deleteUser(uid);
    } catch (authError) {
      console.error(`Error deleting Firebase Auth user ${uid}:`, authError);
    }

    console.log(`🗑️ [API]: Account deleted for user: ${uid}`);
    return res.status(200).json({ message: 'Account deleted' });
  } catch (error) {
    console.error('Error deleting account:', error);
    return res.status(500).json({ message: 'Server error while deleting account' });
  }
});

export default router;
