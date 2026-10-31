import { Router, Request, Response } from 'express';
import { UserOnboarding } from '../models/UserOnboarding';
import { buyShopItem, ShopError, SHOP_PRICES } from '../services/shop';
import { FRAME_PRICES, NAME_EFFECT_PRICES, PRO_WEEK_PRICE, PRO_WEEK_DAYS } from '../constants/cosmetics';

const router = Router();

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

router.post('/award', (_req: Request, res: Response) => {
  res.status(403).json({ message: 'Challenge rewards are granted automatically when results sync. Ad rewards are not enabled.' });
});

router.post('/buy', async (req: Request, res: Response) => {
  try {
    const doc = await buyShopItem(req.uid, req.body);
    res.json({ coins: doc.coins, streakFreezes: doc.streakFreezes, unlockedThemes: doc.unlockedThemes, ownedFrames: doc.ownedFrames, ownedNameEffects: doc.ownedNameEffects, equippedFrame: doc.equippedFrame, equippedNameEffect: doc.equippedNameEffect });
  } catch (error) {
    res.status(error instanceof ShopError ? error.status : 503).json({ message: error instanceof ShopError ? error.message : 'Purchase could not be confirmed. Retry the same purchase.' });
  }
});

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
