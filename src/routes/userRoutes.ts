import { Router, Request, Response } from 'express';
import { UserOnboarding } from '../models/UserOnboarding';

const router = Router();

router.post('/onboarding', async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId, targetApps, goals, difficultyLevel } = req.body;

    if (!targetApps || !goals || !difficultyLevel) {
      return res.status(400).json({ message: 'targetApps, goals, and difficultyLevel are required' });
    }

    const filter = userId ? { userId } : { userId: 'anonymous' };

    const onboarding = await UserOnboarding.findOneAndUpdate(
      filter,
      { targetApps, goals, difficultyLevel },
      { new: true, upsert: true }
    );

    console.log(`🧠 [API]: Onboarding saved for user: ${userId ?? 'anonymous'}`);

    return res.status(200).json(onboarding);
  } catch (error) {
    console.error('Error saving onboarding:', error);
    return res.status(500).json({ message: 'Server error while saving onboarding' });
  }
});

export default router;
