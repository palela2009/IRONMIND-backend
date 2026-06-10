import { Router, Request, Response } from 'express';
import { UserStats } from '../models/UserStats';

const router = Router();

router.get('/:userId', async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId } = req.params;
    let stats = await UserStats.findOne({ userId });

    if (!stats) {
      stats = new UserStats({ userId });
      await stats.save();
    }

    return res.status(200).json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    
    return res.status(500).json({ message: 'Server error while fetching stats' });
  }
});

router.post('/', async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId, level, currentXP, currentStreak, totalReps, bestReactionTime } = req.body;

    if (!userId) {
      return res.status(400).json({ message: 'userId is required' });
    }

    const updatedStats = await UserStats.findOneAndUpdate(
      { userId },
      {
        level,
        currentXP,
        currentStreak,
        totalReps,
        bestReactionTime,
        updatedAt: new Date()
      },
      { new: true, upsert: true }
    );

    console.log(`🎯 [API]: Stats successfully updated in Cloud for user: ${userId}`);

    return res.status(200).json(updatedStats);
  } catch (error) {
    console.error('Error saving stats:', error);
    return res.status(500).json({ message: 'Server error while saving stats' });
  }
});

export default router;