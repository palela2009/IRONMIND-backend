import { Router, Request, Response } from 'express';
import { UserOnboarding } from '../models/UserOnboarding';
import { deleteAccount } from '../services/accountDeletion';
import { validTimeZone } from '../services/challengeTime';
import { saveOnboarding } from '../services/onboarding';

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
      timeZone: doc.challengeTimeZone ?? 'UTC',
    });
  } catch (error) {
    console.error('Error fetching onboarding:', error);
    return res.status(500).json({ message: 'Server error while fetching onboarding' });
  }
});

router.post('/onboarding', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = req.uid;
    const { displayName, photoURL, targetApps, goals, difficultyLevel, dailyChallengeLimit, appLimits } = req.body;

    const existing = await UserOnboarding.findOne({ uid });

    if (!existing && (!targetApps || !goals || !difficultyLevel)) {
      return res.status(400).json({ message: 'targetApps, goals, and difficultyLevel are required' });
    }

    if (req.body.timeZone !== undefined && !validTimeZone(req.body.timeZone)) return res.status(400).json({ message: 'Invalid time zone' });
    const setFields: Record<string, unknown> = { uid, email: req.email, verifiedEmail: req.verifiedEmail };
    if (displayName !== undefined) setFields.displayName = displayName;
    if (photoURL !== undefined) setFields.photoURL = photoURL;
    if (targetApps !== undefined) setFields.targetApps = targetApps;
    if (goals !== undefined) setFields.goals = goals;
    if (difficultyLevel !== undefined) setFields.difficultyLevel = difficultyLevel;
    if (dailyChallengeLimit !== undefined) {
      if (![3, 5, 10].includes(dailyChallengeLimit)) return res.status(400).json({ message: 'Choose 3, 5, or 10 daily challenges' });
      setFields.dailyChallengeLimit = dailyChallengeLimit;
    }
    if (Array.isArray(appLimits)) {
      setFields.appLimits = appLimits
        .filter((l: any) => typeof l?.app === 'string' && Number.isFinite(l?.minutes) && l.minutes >= 0)
        .map((l: any) => ({ app: l.app, minutes: Math.round(l.minutes) }));
    }

    const onboarding = await saveOnboarding(uid, setFields, req.body.timeZone);

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
      { $set: { photoData: buffer, photoContentType: contentType }, $setOnInsert: { welcomeGiftEligible: true } },
      { upsert: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json({ message: 'Photo uploaded' });
  } catch (error) {
    console.error('Error uploading photo:', error);
    return res.status(500).json({ message: 'Server error while uploading photo' });
  }
});

router.delete('/account', async (req: Request, res: Response) => {
  try { await deleteAccount(req.uid); res.json({ message: 'Account deleted' }); }
  catch (error) {
    console.error('Account deletion requires retry:', error);
    res.status(503).json({ message: 'Account deletion is not finished. Please retry; entry fees have been protected.' });
  }
});

router.get('/notifications', async (req: Request, res: Response) => {
  try {
    const profile = await UserOnboarding.findOne({ uid: req.uid }).select('socialNotifications');
    res.json({ socialNotifications: profile?.socialNotifications !== false });
  } catch { res.status(503).json({ message: 'Could not load notification settings' }); }
});

router.patch('/notifications', async (req: Request, res: Response) => {
  if (typeof req.body?.socialNotifications !== 'boolean') { res.status(400).json({ message: 'A notification preference is required' }); return; }
  try {
    await UserOnboarding.updateOne({ uid: req.uid }, { $set: { socialNotifications: req.body.socialNotifications } });
    res.json({ socialNotifications: req.body.socialNotifications });
  } catch { res.status(503).json({ message: 'Could not save notification settings' }); }
});

export default router;
