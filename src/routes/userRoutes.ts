import { Router, Request, Response } from 'express';
import { UserOnboarding } from '../models/UserOnboarding';

const router = Router();

// GET /api/user/onboarding — lets a returning account restore its own real settings
// from the cloud instead of being forced through onboarding again after a local reset
// (e.g. switching to this account on a device that last had a different one signed in).
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
    });
  } catch (error) {
    console.error('Error fetching onboarding:', error);
    return res.status(500).json({ message: 'Server error while fetching onboarding' });
  }
});

router.post('/onboarding', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = req.uid;
    const { email, displayName, photoURL, targetApps, goals, difficultyLevel, dailyChallengeLimit } = req.body;

    const existing = await UserOnboarding.findOne({ uid });

    // A brand new account must go through real onboarding — but an existing account can
    // send just identity fields (e.g. an automatic post-login resync) without resending
    // its full settings, so that never overwrites targetApps/goals with nothing.
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

export default router;
