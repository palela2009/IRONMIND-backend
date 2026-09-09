import { Router, Request, Response } from 'express';
import { UserStats } from '../models/UserStats';
import { UserOnboarding } from '../models/UserOnboarding';
import { FriendRequest } from '../models/FriendRequest';
import { sendPush } from '../services/notifications';

const router = Router();

// Tells friends who have just been overtaken on the leaderboard.
//
// Only fires on the exact crossing - the previous streak was at or below theirs and the new
// one is above - so a user who stays ahead does not re-notify the same friend on every
// challenge they win. Friends still on zero are skipped: being passed at nothing is not news.
async function notifyOvertakenFriends(uid: string, before: number, after: number): Promise<void> {
  if (after <= before) return;

  const links = await FriendRequest.find({
    status: 'accepted',
    $or: [{ fromUid: uid }, { toUid: uid }],
  });
  const friendUids = links.map((l) => (l.fromUid === uid ? l.toUid : l.fromUid));
  if (friendUids.length === 0) return;

  const [me, friendStats] = await Promise.all([
    UserOnboarding.findOne({ uid }),
    UserStats.find({ userId: { $in: friendUids } }),
  ]);

  const myName = me?.displayName || me?.email || 'A friend';

  for (const friend of friendStats) {
    const theirs = friend.currentStreak ?? 0;
    if (theirs > 0 && before <= theirs && after > theirs) {
      sendPush(
        friend.userId,
        'You have been passed',
        `${myName} just overtook you with a ${after} streak.`,
        { type: 'leaderboard_passed' }
      );
    }
  }
}


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

    const previous = await UserStats.findOne({ userId });

    const updatedStats = await UserStats.findOneAndUpdate(
      { userId },
      { currentStreak, longestStreak, bestReactionTime, totalChallenges, successCount, currentXP, level, updatedAt: new Date() },
      { new: true, upsert: true }
    );

    console.log(`🎯 [API]: Stats updated for user: ${userId} | streak: ${currentStreak} | longest: ${longestStreak}`);

    notifyOvertakenFriends(userId as string, previous?.currentStreak ?? 0, Number(currentStreak) || 0).catch(() => {});

    return res.status(200).json(updatedStats);
  } catch (error) {
    console.error('Error saving stats:', error);
    return res.status(500).json({ message: 'Server error while saving stats' });
  }
});

export default router;