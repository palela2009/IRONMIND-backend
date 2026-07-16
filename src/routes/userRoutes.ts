import { Router, Request, Response } from 'express';
import { UserOnboarding } from '../models/UserOnboarding';

const router = Router();

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
