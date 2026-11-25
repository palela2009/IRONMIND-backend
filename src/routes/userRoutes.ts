import { randomBytes } from 'crypto';
import { Router, Request, Response } from 'express';
import { UserOnboarding } from '../models/UserOnboarding';
import { deleteAccount } from '../services/accountDeletion';
import { validTimeZone } from '../services/challengeTime';
import { saveOnboarding } from '../services/onboarding';
import { ALLOWED_PHOTO_TYPES, MAX_PHOTO_BYTES, detectImageMime, hashSyncToken } from '../middleware/security';

const router = Router();

const ALLOWED_DIFFICULTIES = new Set(['EASY', 'INTERMEDIATE', 'HARD']);

router.get('/onboarding', async (req: Request, res: Response): Promise<any> => {
  try {
    const doc = await UserOnboarding.findOne({ uid: req.uid }).lean();
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

    const existing = await UserOnboarding.findOne({ uid }).select('_id').lean();

    if (!existing && (!targetApps || !goals || !difficultyLevel)) {
      return res.status(400).json({ message: 'targetApps, goals, and difficultyLevel are required' });
    }

    if (req.body.timeZone !== undefined && !validTimeZone(req.body.timeZone)) {
      return res.status(400).json({ message: 'Invalid time zone' });
    }

    const setFields: Record<string, unknown> = { uid, email: req.email, verifiedEmail: req.verifiedEmail };

    if (displayName !== undefined) {
      if (displayName !== null && typeof displayName !== 'string') {
        return res.status(400).json({ message: 'Invalid displayName' });
      }
      setFields.displayName = typeof displayName === 'string' ? displayName.trim().slice(0, 60) : '';
    }
    if (photoURL !== undefined) {
      if (photoURL !== null && (typeof photoURL !== 'string' || photoURL.length > 512)) {
        return res.status(400).json({ message: 'Invalid photoURL' });
      }
      setFields.photoURL = photoURL;
    }
    if (targetApps !== undefined) {
      if (!Array.isArray(targetApps) || targetApps.length > 30 || targetApps.some((a) => typeof a !== 'string' || !a.trim() || a.length > 64)) {
        return res.status(400).json({ message: 'Invalid targetApps' });
      }
      setFields.targetApps = Array.from(new Set(targetApps.map((a: string) => a.trim())));
    }
    if (goals !== undefined) {
      if (!Array.isArray(goals) || goals.length > 10 || goals.some((g) => typeof g !== 'string' || g.length > 64)) {
        return res.status(400).json({ message: 'Invalid goals' });
      }
      setFields.goals = goals.map((g: string) => g.trim()).filter(Boolean);
    }
    if (difficultyLevel !== undefined) {
      if (typeof difficultyLevel !== 'string' || !ALLOWED_DIFFICULTIES.has(difficultyLevel)) {
        return res.status(400).json({ message: 'Invalid difficultyLevel' });
      }
      setFields.difficultyLevel = difficultyLevel;
    }
    if (dailyChallengeLimit !== undefined) {
      if (![3, 5, 10].includes(dailyChallengeLimit)) {
        return res.status(400).json({ message: 'Choose 3, 5, or 10 daily challenges' });
      }
      setFields.dailyChallengeLimit = dailyChallengeLimit;
    }
    if (Array.isArray(appLimits)) {
      setFields.appLimits = appLimits
        .slice(0, 30)
        .filter((l: any) => typeof l?.app === 'string' && l.app.trim().length > 0 && l.app.length <= 64 && Number.isFinite(l?.minutes) && l.minutes >= 0 && l.minutes <= 1440)
        .map((l: any) => ({ app: l.app.trim(), minutes: Math.round(l.minutes) }));
    }

    const onboarding = await saveOnboarding(uid, setFields, req.body.timeZone);
    return res.status(200).json(onboarding);
  } catch (error) {
    console.error('Error saving onboarding:', error);
    return res.status(500).json({ message: 'Server error while saving onboarding' });
  }
});

router.post('/photo', async (req: Request, res: Response): Promise<any> => {
  try {
    const { imageBase64, contentType } = req.body ?? {};
    if (typeof imageBase64 !== 'string' || typeof contentType !== 'string' || !imageBase64.trim()) {
      return res.status(400).json({ message: 'imageBase64 and contentType are required' });
    }
    if (!ALLOWED_PHOTO_TYPES.has(contentType)) {
      return res.status(400).json({ message: 'Only JPEG, PNG, and WebP images are allowed' });
    }

    const buffer = Buffer.from(imageBase64, 'base64');
    if (buffer.length === 0) {
      return res.status(400).json({ message: 'Invalid image data' });
    }
    if (buffer.length > MAX_PHOTO_BYTES) {
      return res.status(413).json({ message: 'Image must be 1 MB or smaller' });
    }
    const detected = detectImageMime(buffer);
    if (!detected || detected !== contentType) {
      return res.status(400).json({ message: 'Image bytes do not match an allowed image format' });
    }

    await UserOnboarding.findOneAndUpdate(
      { uid: req.uid, deletionRequestedAt: null },
      { $set: { photoData: buffer, photoContentType: detected }, $setOnInsert: { welcomeGiftEligible: true } },
      { upsert: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json({ message: 'Photo uploaded' });
  } catch (error) {
    console.error('Error uploading photo:', error);
    return res.status(500).json({ message: 'Server error while uploading photo' });
  }
});

router.post('/sync-token', async (req: Request, res: Response): Promise<any> => {
  try {
    const syncToken = randomBytes(32).toString('hex');
    const hash = hashSyncToken(syncToken);
    const updated = await UserOnboarding.findOneAndUpdate(
      { uid: req.uid, deletionRequestedAt: null },
      { $set: { usageSyncTokenHash: hash }, $setOnInsert: { welcomeGiftEligible: true } },
      { upsert: true, setDefaultsOnInsert: true, returnDocument: 'after' }
    );
    if (!updated) return res.status(409).json({ message: 'Account is unavailable' });
    return res.status(200).json({ syncToken });
  } catch (error) {
    console.error('Error issuing sync token:', error);
    return res.status(500).json({ message: 'Could not issue sync token' });
  }
});

router.delete('/sync-token', async (req: Request, res: Response): Promise<any> => {
  try {
    await UserOnboarding.updateOne({ uid: req.uid }, { $set: { usageSyncTokenHash: null } });
    return res.status(200).json({ success: true });
  } catch {
    return res.status(503).json({ message: 'Could not revoke sync token' });
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
    const profile = await UserOnboarding.findOne({ uid: req.uid }).select('socialNotifications').lean();
    res.json({ socialNotifications: profile?.socialNotifications !== false });
  } catch { res.status(503).json({ message: 'Could not load notification settings' }); }
});

router.patch('/notifications', async (req: Request, res: Response) => {
  if (typeof req.body?.socialNotifications !== 'boolean') {
    res.status(400).json({ message: 'A notification preference is required' });
    return;
  }
  try {
    await UserOnboarding.findOneAndUpdate(
      { uid: req.uid, deletionRequestedAt: null },
      { $set: { socialNotifications: req.body.socialNotifications }, $setOnInsert: { welcomeGiftEligible: true } },
      { upsert: true, setDefaultsOnInsert: true }
    );
    res.json({ socialNotifications: req.body.socialNotifications });
  } catch { res.status(503).json({ message: 'Could not save notification settings' }); }
});

export default router;
