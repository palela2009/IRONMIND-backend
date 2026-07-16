import { Router, Request, Response } from 'express';
import { UserStats } from '../models/UserStats';

const router = Router();

router.get('/:userId', async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId } = req.params;

    if (userId !== req.uid) {
      return res.status(403).json({ message: 'Forbidden' });
    }

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
    const userId = req.uid;
    const { currentStreak, longestStreak, bestReactionTime, totalChallenges, successCount, currentXP, level } = req.body;

    const updatedStats = await UserStats.findOneAndUpdate(
      { userId },
      { currentStreak, longestStreak, bestReactionTime, totalChallenges, successCount, currentXP, level, updatedAt: new Date() },
      { new: true, upsert: true }
    );

    console.log(`🎯 [API]: Stats updated for user: ${userId} | streak: ${currentStreak} | longest: ${longestStreak}`);

    return res.status(200).json(updatedStats);
  } catch (error) {
    console.error('Error saving stats:', error);
    return res.status(500).json({ message: 'Server error while saving stats' });
  }
});

export default router;