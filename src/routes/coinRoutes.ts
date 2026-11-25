import { Router, Request, Response } from 'express';
import { UserOnboarding } from '../models/UserOnboarding';
import { buyShopItem, ShopError, SHOP_PRICES } from '../services/shop';
import { FRAME_PRICES, NAME_EFFECT_PRICES, PRO_WEEK_PRICE, PRO_EXCLUSIVE_FRAMES, ELITE_BADGE_IDS } from '../constants/cosmetics';
import { isProActive } from './proRoutes';

const router = Router();

router.get('/', async (req: Request, res: Response): Promise<any> => {
  try {
    const doc = await UserOnboarding.findOne({ uid: req.uid }).lean();
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

router.post('/award', (_req: Request, res: Response) => {
  res.status(403).json({ message: 'Challenge rewards are granted automatically when results sync. Ad rewards are not enabled.' });
});

router.post('/buy', async (req: Request, res: Response) => {
  try {
    const doc = await buyShopItem(req.uid, req.body);
    res.json({
      coins: doc.coins,
      streakFreezes: doc.streakFreezes,
      unlockedThemes: doc.unlockedThemes,
      ownedFrames: doc.ownedFrames,
      ownedNameEffects: doc.ownedNameEffects,
      equippedFrame: doc.equippedFrame,
      equippedNameEffect: doc.equippedNameEffect,
      isPro: isProActive(doc),
      proPlan: doc.proPlan,
      proExpiresAt: doc.proExpiresAt,
      proSource: doc.proSource,
    });
  } catch (error) {
    res.status(error instanceof ShopError ? error.status : 503).json({ message: error instanceof ShopError ? error.message : 'Purchase could not be confirmed. Retry the same purchase.' });
  }
});

router.post('/equip', async (req: Request, res: Response): Promise<any> => {
  try {
    const { slot, cosmeticId } = req.body ?? {};
    if (slot !== 'frame' && slot !== 'nameEffect' && slot !== 'badge') {
      return res.status(400).json({ message: 'Unknown slot' });
    }
    if (cosmeticId !== null && cosmeticId !== undefined && typeof cosmeticId !== 'string') {
      return res.status(400).json({ message: 'Invalid cosmeticId' });
    }
    const normalized = typeof cosmeticId === 'string' && cosmeticId.trim().length > 0 ? cosmeticId.trim() : null;

    const doc = await UserOnboarding.findOne({ uid: req.uid })
      .select('ownedFrames ownedNameEffects proPlan proExpiresAt verifiedEmail trialEndsAt proSource')
      .lean();
    if (!doc) return res.status(404).json({ message: 'Account not found' });

    const pro = isProActive(doc);
    if (slot === 'badge') {
      if (normalized && (!pro || !ELITE_BADGE_IDS.has(normalized))) {
        return res.status(403).json({ message: 'Elite badges require IronMind Pro' });
      }
    } else if (slot === 'frame') {
      const owned = doc.ownedFrames ?? [];
      if (normalized) {
        if (PRO_EXCLUSIVE_FRAMES.has(normalized)) {
          if (!pro) return res.status(403).json({ message: 'This exclusive frame requires IronMind Pro' });
        } else if (!owned.includes(normalized)) {
          return res.status(403).json({ message: 'You do not own that' });
        }
      }
    } else {
      const owned = doc.ownedNameEffects ?? [];
      if (normalized && !owned.includes(normalized)) {
        return res.status(403).json({ message: 'You do not own that' });
      }
    }

    const field = slot === 'frame' ? 'equippedFrame' : slot === 'nameEffect' ? 'equippedNameEffect' : 'pinnedBadge';
    const updated = await UserOnboarding.findOneAndUpdate(
      { uid: req.uid },
      { $set: { [field]: normalized } },
      { returnDocument: 'after' }
    );

    return res.status(200).json({
      equippedFrame: updated?.equippedFrame ?? null,
      equippedNameEffect: updated?.equippedNameEffect ?? null,
      pinnedBadge: updated?.pinnedBadge ?? null,
    });
  } catch (error) {
    console.error('Error equipping cosmetic:', error);
    return res.status(500).json({ message: 'Server error while equipping' });
  }
});

export default router;
