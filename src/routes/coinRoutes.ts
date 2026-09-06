import { Router, Request, Response } from 'express';
import { UserOnboarding } from '../models/UserOnboarding';
import { isProActive } from './proRoutes';

const router = Router();

export type EarnReason = 'challenge_win' | 'perfect_day' | 'rewarded_ad';

// The server owns these amounts. The client sends a reason, never a number, so a tampered
// build cannot decide how much it is paid.
const EARN_AMOUNTS: Record<EarnReason, number> = {
  challenge_win: 10,
  perfect_day: 50,
  rewarded_ad: 25,
};

// Pro earns at double rate. That, plus the monthly stipend, is what makes Pro a shortcut
// rather than the only route to anything coins can buy.
const PRO_MULTIPLIER = 2;

// A daily ceiling on earnings. Challenge results are reported by the client and cannot be
// verified server-side yet, so this caps what a replayed or forged report is worth rather
// than pretending the reports are trustworthy.
const DAILY_EARN_CAP = 500;

export const SHOP_PRICES = {
  freeze: 200,
  theme: 750,
};

const todayKey = (): string => new Date().toISOString().slice(0, 10);

router.get('/', async (req: Request, res: Response): Promise<any> => {
  try {
    const doc = await UserOnboarding.findOne({ uid: req.uid });
    return res.status(200).json({
      coins: doc?.coins ?? 0,
      unlockedThemes: doc?.unlockedThemes ?? [],
      prices: SHOP_PRICES,
    });
  } catch (error) {
    console.error('Error fetching coins:', error);
    return res.status(500).json({ message: 'Server error while fetching coins' });
  }
});

router.post('/award', async (req: Request, res: Response): Promise<any> => {
  try {
    const reason = req.body?.reason as EarnReason;
    if (!reason || !(reason in EARN_AMOUNTS)) {
      return res.status(400).json({ message: 'Unknown reason' });
    }

    const doc = await UserOnboarding.findOne({ uid: req.uid });
    if (!doc) return res.status(404).json({ message: 'Account not found' });

    const today = todayKey();
    const earnedToday = doc.coinEarnDate === today ? doc.coinEarnedToday : 0;

    const base = EARN_AMOUNTS[reason];
    const multiplier = isProActive(doc) ? PRO_MULTIPLIER : 1;
    const wanted = base * multiplier;
    const granted = Math.max(0, Math.min(wanted, DAILY_EARN_CAP - earnedToday));

    if (granted === 0) {
      return res.status(200).json({ coins: doc.coins, granted: 0, capped: true });
    }

    const updated = await UserOnboarding.findOneAndUpdate(
      { uid: req.uid },
      {
        $inc: { coins: granted },
        $set: { coinEarnDate: today, coinEarnedToday: earnedToday + granted },
      },
      { new: true }
    );

    return res.status(200).json({ coins: updated?.coins ?? 0, granted, capped: false });
  } catch (error) {
    console.error('Error awarding coins:', error);
    return res.status(500).json({ message: 'Server error while awarding coins' });
  }
});

router.post('/buy', async (req: Request, res: Response): Promise<any> => {
  try {
    const { item, themeId } = req.body as { item?: 'freeze' | 'theme'; themeId?: string };

    if (item !== 'freeze' && item !== 'theme') {
      return res.status(400).json({ message: 'Unknown item' });
    }
    if (item === 'theme' && !themeId) {
      return res.status(400).json({ message: 'themeId is required' });
    }

    const price = SHOP_PRICES[item];

    if (item === 'theme') {
      const owned = await UserOnboarding.findOne({ uid: req.uid, unlockedThemes: themeId });
      if (owned) return res.status(400).json({ message: 'You already own that theme' });
    }

    // The balance check and the debit are one atomic update, so two purchases racing each
    // other cannot both spend the same coins.
    const update =
      item === 'freeze'
        ? { $inc: { coins: -price, streakFreezes: 1 } }
        : { $inc: { coins: -price }, $addToSet: { unlockedThemes: themeId as string } };

    const doc = await UserOnboarding.findOneAndUpdate(
      { uid: req.uid, coins: { $gte: price } },
      update,
      { new: true }
    );

    if (!doc) {
      return res.status(409).json({ message: 'Not enough coins' });
    }

    return res.status(200).json({
      coins: doc.coins,
      streakFreezes: doc.streakFreezes,
      unlockedThemes: doc.unlockedThemes,
    });
  } catch (error) {
    console.error('Error buying item:', error);
    return res.status(500).json({ message: 'Server error while buying' });
  }
});

export default router;
