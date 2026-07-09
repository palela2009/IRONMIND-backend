import { Router, Request, Response } from 'express';
import { UserOnboarding } from '../models/UserOnboarding';

const router = Router();

router.post('/onboarding', async (req: Request, res: Response): Promise<any> => {
  try {
    const { uid, email, displayName, photoURL, targetApps, goals, difficultyLevel } = req.body;

    if (!targetApps || !goals || !difficultyLevel) {
      return res.status(400).json({ message: 'targetApps, goals, and difficultyLevel are required' });
    }

    let onboarding;
    if (uid) {
      onboarding = await UserOnboarding.findOneAndUpdate(
        { uid },
        { $set: { uid, email, displayName, photoURL, targetApps, goals, difficultyLevel } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
    } else {
      onboarding = await UserOnboarding.create({ targetApps, goals, difficultyLevel });
    }

    console.log(`🧠 [API]: Onboarding saved for user: ${uid ?? 'anonymous'}`);

    return res.status(200).json(onboarding);
  } catch (error) {
    console.error('Error saving onboarding:', error);
    return res.status(500).json({ message: 'Server error while saving onboarding' });
  }
});

export default router;
