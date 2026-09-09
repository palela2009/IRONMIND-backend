import { Router, Request, Response } from 'express';
import { UserOnboarding } from '../models/UserOnboarding';
import { isProActive } from './proRoutes';
import { FRAME_PRICES, NAME_EFFECT_PRICES, PRO_WEEK_PRICE, PRO_WEEK_DAYS } from '../constants/cosmetics';

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
      ownedFrames: doc?.ownedFrames ?? [],
      ownedNameEffects: doc?.ownedNameEffects ?? [],
      equippedFrame: doc?.equippedFrame ?? null,
      equippedNameEffect: doc?.equippedNameEffect ?? null,
      prices: { ...SHOP_PRICES, frames: FRAME_PRICES, nameEffects: NAME_EFFECT_PRICES, proWeek: PRO_WEEK_PRICE },
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
    const { item, themeId, cosmeticId } = req.body as {
      item?: 'freeze' | 'theme' | 'frame' | 'nameEffect' | 'proWeek';
      themeId?: string;
      cosmeticId?: string;
    };

    const doc = await UserOnboarding.findOne({ uid: req.uid });
    if (!doc) return res.status(404).json({ message: 'Account not found' });

    let price = 0;
    let update: Record<string, unknown> = {};

    if (item === 'freeze') {
      price = SHOP_PRICES.freeze;
      update = { $inc: { coins: -price, streakFreezes: 1 } };
    } else if (item === 'theme') {
      if (!themeId) return res.status(400).json({ message: 'themeId is required' });
      if (doc.unlockedThemes?.includes(themeId)) {
        return res.status(400).json({ message: 'You already own that theme' });
      }
      price = SHOP_PRICES.theme;
      update = { $inc: { coins: -price }, $addToSet: { unlockedThemes: themeId } };
    } else if (item === 'frame' || item === 'nameEffect') {
      const table = item === 'frame' ? FRAME_PRICES : NAME_EFFECT_PRICES;
      if (!cosmeticId || !(cosmeticId in table)) {
        return res.status(400).json({ message: 'Unknown item' });
      }
      const ownedField = item === 'frame' ? 'ownedFrames' : 'ownedNameEffects';
      const equippedField = item === 'frame' ? 'equippedFrame' : 'equippedNameEffect';
      const owned = (item === 'frame' ? doc.ownedFrames : doc.ownedNameEffects) ?? [];
      if (owned.includes(cosmeticId)) {
        return res.status(400).json({ message: 'You already own that' });
      }
      price = table[cosmeticId];
      // Equipped on purchase. Buying something cosmetic and then having to find a second
      // control to actually wear it is friction for no reason.
      update = {
        $inc: { coins: -price },
        $addToSet: { [ownedField]: cosmeticId },
        $set: { [equippedField]: cosmeticId },
      };
    } else if (item === 'proWeek') {
      if (isProActive(doc)) {
        return res.status(400).json({ message: 'You already have Pro' });
      }
      // Once a calendar month. The cap is what stops coins replacing the subscription
      // outright, and it matters more than the price does.
      const last = doc.proFromCoinsAt;
      if (last) {
        const now = new Date();
        const sameMonth =
          last.getUTCFullYear() === now.getUTCFullYear() && last.getUTCMonth() === now.getUTCMonth();
        if (sameMonth) {
          return res.status(409).json({ message: 'You can only buy Pro with coins once a month' });
        }
      }
      price = PRO_WEEK_PRICE;
      update = {
        $inc: { coins: -price },
        $set: {
          proPlan: 'monthly',
          proExpiresAt: new Date(Date.now() + PRO_WEEK_DAYS * 24 * 60 * 60 * 1000),
          proFromCoinsAt: new Date(),
        },
      };
    } else {
      return res.status(400).json({ message: 'Unknown item' });
    }

    // Balance check and debit in one atomic update, so two purchases racing each other
    // cannot both spend the same coins.
    const updated = await UserOnboarding.findOneAndUpdate(
      { uid: req.uid, coins: { $gte: price } },
      update,
      { new: true }
    );

    if (!updated) return res.status(409).json({ message: 'Not enough coins' });

    return res.status(200).json({
      coins: updated.coins,
      streakFreezes: updated.streakFreezes,
      unlockedThemes: updated.unlockedThemes,
      ownedFrames: updated.ownedFrames,
      ownedNameEffects: updated.ownedNameEffects,
      equippedFrame: updated.equippedFrame,
      equippedNameEffect: updated.equippedNameEffect,
    });
  } catch (error) {
    console.error('Error buying item:', error);
    return res.status(500).json({ message: 'Server error while buying' });
  }
});

// Equipping something already owned. Validated against ownership so a tampered client cannot
// wear a frame it never bought.
router.post('/equip', async (req: Request, res: Response): Promise<any> => {
  try {
    const { slot, cosmeticId } = req.body as { slot?: 'frame' | 'nameEffect'; cosmeticId?: string | null };
    if (slot !== 'frame' && slot !== 'nameEffect') {
      return res.status(400).json({ message: 'Unknown slot' });
    }

    const doc = await UserOnboarding.findOne({ uid: req.uid });
    if (!doc) return res.status(404).json({ message: 'Account not found' });

    const owned = (slot === 'frame' ? doc.ownedFrames : doc.ownedNameEffects) ?? [];
    if (cosmeticId && !owned.includes(cosmeticId)) {
      return res.status(403).json({ message: 'You do not own that' });
    }

    const field = slot === 'frame' ? 'equippedFrame' : 'equippedNameEffect';
    const updated = await UserOnboarding.findOneAndUpdate(
      { uid: req.uid },
      { $set: { [field]: cosmeticId ?? null } },
      { new: true }
    );

    return res.status(200).json({
      equippedFrame: updated?.equippedFrame ?? null,
      equippedNameEffect: updated?.equippedNameEffect ?? null,
    });
  } catch (error) {
    console.error('Error equipping cosmetic:', error);
    return res.status(500).json({ message: 'Server error while equipping' });
  }
});

export default router;
