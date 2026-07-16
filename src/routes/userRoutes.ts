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

    if (!targetApps || !goals || !difficultyLevel) {
      return res.status(400).json({ message: 'targetApps, goals, and difficultyLevel are required' });
    }

    const onboarding = await UserOnboarding.findOneAndUpdate(
      { uid },
      { $set: { uid, email, displayName, photoURL, targetApps, goals, difficultyLevel, dailyChallengeLimit } },
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
