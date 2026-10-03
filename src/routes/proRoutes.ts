import { Router, Request, Response } from 'express';
import { UserOnboarding, IUserOnboarding } from '../models/UserOnboarding';
import { syncStorePurchase, revenueCatConfigured } from '../services/revenuecat';

const router = Router();

const PRO_MONTHLY_FREEZES = 20;
const PRO_MONTHLY_COINS = 500;


const STARTER_COINS = 150;

const OWNER_COINS = 10000;

const ownerEmails = (): string[] =>
  (process.env.OWNER_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

export function isOwner(email?: string | null): boolean {
  if (!email) return false;
  return ownerEmails().includes(email.toLowerCase());
}

export function isTrialActive(doc: Pick<IUserOnboarding, 'trialEndsAt'> | null): boolean {
  return !!doc?.trialEndsAt && doc.trialEndsAt.getTime() > Date.now();
}

export function isProActive(
  doc: Pick<IUserOnboarding, 'proPlan' | 'proExpiresAt' | 'email' | 'trialEndsAt'> | null
): boolean {
  if (!doc) return false;
  if (isOwner(doc.email)) return true;
  if (isTrialActive(doc)) return true;
  if (!doc.proPlan) return false;
  if (doc.proPlan === 'lifetime') return true;
  return !!doc.proExpiresAt && doc.proExpiresAt.getTime() > Date.now();
}

function needsRefill(last: Date | null | undefined): boolean {
  if (!last) return true;
  const now = new Date();
  return last.getUTCFullYear() !== now.getUTCFullYear() || last.getUTCMonth() !== now.getUTCMonth();
}

async function refillFreezes(uid: string) {
  return UserOnboarding.findOneAndUpdate(
    { uid },
    {
      $max: { streakFreezes: PRO_MONTHLY_FREEZES },
      $inc: { coins: PRO_MONTHLY_COINS },
      $set: { freezesRefilledAt: new Date() },
    },
    { new: true }
  );
}

function entitlementPayload(doc: IUserOnboarding | null) {
  return {
    isPro: isProActive(doc),
    isOwner: isOwner(doc?.email),
    plan: doc?.proPlan ?? null,
    source: doc?.proSource ?? null,
    expiresAt: doc?.proExpiresAt ?? null,
    streakFreezes: doc?.streakFreezes ?? 0,
    coins: doc?.coins ?? 0,
    unlockedThemes: doc?.unlockedThemes ?? [],
    ownedFrames: doc?.ownedFrames ?? [],
    ownedNameEffects: doc?.ownedNameEffects ?? [],
    equippedFrame: doc?.equippedFrame ?? null,
    equippedNameEffect: doc?.equippedNameEffect ?? null,
    themeId: doc?.themeId ?? 'default',
    welcomeOffer: !doc?.welcomeOfferClosedAt && !isProActive(doc),
    onTrial: isTrialActive(doc),
    trialEndsAt: doc?.trialEndsAt ?? null,
  };
}

router.get('/', async (req: Request, res: Response): Promise<any> => {
  try {
    let doc = await UserOnboarding.findOne({ uid: req.uid });

    if (doc && isOwner(doc.email) && (doc.proPlan !== 'lifetime' || doc.proSource !== 'owner')) {
      doc = await UserOnboarding.findOneAndUpdate(
        { uid: req.uid },
        { $set: { proPlan: 'lifetime', proExpiresAt: null, proSource: 'owner' } },
        { new: true }
      );
      console.log(`👑 [API]: Owner Pro granted to ${req.uid}`);
    }

    if (doc && !doc.starterCoinsGrantedAt) {
      doc = await UserOnboarding.findOneAndUpdate(
        { uid: req.uid, starterCoinsGrantedAt: null },
        { $inc: { coins: STARTER_COINS }, $set: { starterCoinsGrantedAt: new Date() } },
        { new: true }
      ) ?? doc;
    }

    if (doc && isOwner(doc.email) && !doc.ownerCoinsGrantedAt) {
      doc = await UserOnboarding.findOneAndUpdate(
        { uid: req.uid, ownerCoinsGrantedAt: null },
        { $inc: { coins: OWNER_COINS }, $set: { ownerCoinsGrantedAt: new Date() } },
        { new: true }
      ) ?? doc;
      console.log(`👑 [API]: Owner coin float granted to ${req.uid}`);
    }

    if (doc?.proSource === 'store' && !isProActive(doc) && revenueCatConfigured()) {
      doc = await syncStorePurchase(req.uid as string).catch(() => doc);
    }

    if (doc && isProActive(doc) && needsRefill(doc.freezesRefilledAt)) {
      doc = await refillFreezes(req.uid as string);
      console.log(`❄ [API]: Monthly freezes refilled for ${req.uid}`);
    }

    return res.status(200).json(entitlementPayload(doc));
  } catch (error) {
    console.error('Error fetching entitlement:', error);
    return res.status(500).json({ message: 'Server error while fetching entitlement' });
  }
});

router.post('/sync', async (req: Request, res: Response): Promise<any> => {
  try {
    const doc = await syncStorePurchase(req.uid as string);
    if (doc?.proSource === 'store') console.log(`⭐ [API]: Store Pro synced (${doc.proPlan}) for ${req.uid}`);
    return res.status(200).json(entitlementPayload(doc));
  } catch (error) {
    console.error('Error syncing purchase:', error);
    return res.status(502).json({ message: 'Could not confirm the purchase yet, try again in a moment' });
  }
});

router.post('/freeze/use', async (req: Request, res: Response): Promise<any> => {
  try {
    const doc = await UserOnboarding.findOneAndUpdate(
      { uid: req.uid, streakFreezes: { $gt: 0 } },
      { $inc: { streakFreezes: -1 } },
      { new: true }
    );

    if (!doc) {
      return res.status(409).json({ message: 'No streak freezes available', streakFreezes: 0 });
    }

    return res.status(200).json({ message: 'Freeze used', streakFreezes: doc.streakFreezes });
  } catch (error) {
    console.error('Error using freeze:', error);
    return res.status(500).json({ message: 'Server error while using freeze' });
  }
});

router.post('/freeze/grant', async (req: Request, res: Response): Promise<any> => {
  try {
    const doc = await UserOnboarding.findOneAndUpdate(
      { uid: req.uid },
      { $inc: { streakFreezes: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return res.status(200).json({ streakFreezes: doc.streakFreezes });
  } catch (error) {
    console.error('Error granting freeze:', error);
    return res.status(500).json({ message: 'Server error while granting freeze' });
  }
});

router.post('/offer/close', async (req: Request, res: Response): Promise<any> => {
  try {
    const doc = await UserOnboarding.findOneAndUpdate(
      { uid: req.uid },
      { $set: { welcomeOfferClosedAt: new Date() } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return res.status(200).json(entitlementPayload(doc));
  } catch (error) {
    console.error('Error closing welcome offer:', error);
    return res.status(500).json({ message: 'Server error while closing offer' });
  }
});

router.post('/theme', async (req: Request, res: Response): Promise<any> => {
  try {
    const { themeId } = req.body;
    if (!themeId || typeof themeId !== 'string') {
      return res.status(400).json({ message: 'themeId is required' });
    }

    const doc = await UserOnboarding.findOneAndUpdate(
      { uid: req.uid },
      { $set: { themeId } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json(entitlementPayload(doc));
  } catch (error) {
    console.error('Error saving theme:', error);
    return res.status(500).json({ message: 'Server error while saving theme' });
  }
});

export default router;
