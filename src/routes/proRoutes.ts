import { Router, Request, Response } from 'express';
import { UserOnboarding, IUserOnboarding } from '../models/UserOnboarding';

const router = Router();

export type ProPlan = 'monthly' | 'annual' | 'lifetime';

const PRO_MONTHLY_FREEZES = 20;
const PRO_MONTHLY_COINS = 500;

const PLAN_DURATION_DAYS: Record<ProPlan, number | null> = {
  monthly: 30,
  annual: 365,
  lifetime: null, 
};

const ownerEmails = (): string[] =>
  (process.env.OWNER_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

export function isOwner(email?: string | null): boolean {
  if (!email) return false;
  return ownerEmails().includes(email.toLowerCase());
}

export function isProActive(doc: Pick<IUserOnboarding, 'proPlan' | 'proExpiresAt' | 'email'> | null): boolean {
  if (!doc) return false;
  if (isOwner(doc.email)) return true;
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
      // The stipend is added rather than topped up to, so it stacks with coins the user
      // earned themselves instead of quietly replacing them.
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
    expiresAt: doc?.proExpiresAt ?? null,
    streakFreezes: doc?.streakFreezes ?? 0,
    coins: doc?.coins ?? 0,
    unlockedThemes: doc?.unlockedThemes ?? [],
    themeId: doc?.themeId ?? 'default',
    // Eligible until the account explicitly closes it. A missing document counts as eligible
    // rather than ineligible: the document is only created during onboarding, so requiring one
    // meant the newest users - the entire audience for a welcome offer - never saw it.
    welcomeOffer: !doc?.welcomeOfferClosedAt && !isProActive(doc),
  };
}

router.get('/', async (req: Request, res: Response): Promise<any> => {
  try {
    let doc = await UserOnboarding.findOne({ uid: req.uid });

    if (doc && isOwner(doc.email) && doc.proPlan !== 'lifetime') {
      doc = await UserOnboarding.findOneAndUpdate(
        { uid: req.uid },
        { $set: { proPlan: 'lifetime', proExpiresAt: null } },
        { new: true }
      );
      console.log(`👑 [API]: Owner Pro granted to ${req.uid}`);
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

router.post('/activate', async (req: Request, res: Response): Promise<any> => {
  try {
    if (process.env.ALLOW_DEV_PRO !== 'true') {
      return res.status(403).json({ message: 'Purchases are not available yet' });
    }

    const { plan } = req.body as { plan?: ProPlan };
    if (!plan || !(plan in PLAN_DURATION_DAYS)) {
      return res.status(400).json({ message: 'plan must be monthly, annual or lifetime' });
    }

    const days = PLAN_DURATION_DAYS[plan];
    const expiresAt = days === null ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    await UserOnboarding.findOneAndUpdate(
      { uid: req.uid },
      {
        $set: { proPlan: plan, proExpiresAt: expiresAt },
        $max: { streakFreezes: PRO_MONTHLY_FREEZES },
        $currentDate: { freezesRefilledAt: true },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    const doc = await UserOnboarding.findOne({ uid: req.uid });

    console.log(`⭐ [API]: Pro activated (${plan}) for user: ${req.uid}`);
    return res.status(200).json(entitlementPayload(doc));
  } catch (error) {
    console.error('Error activating Pro:', error);
    return res.status(500).json({ message: 'Server error while activating Pro' });
  }
});

router.post('/cancel', async (req: Request, res: Response): Promise<any> => {
  try {
    if (process.env.ALLOW_DEV_PRO !== 'true') {
      return res.status(403).json({ message: 'Not available' });
    }
    const doc = await UserOnboarding.findOneAndUpdate(
      { uid: req.uid },
      { $set: { proPlan: null, proExpiresAt: null } },
      { new: true }
    );
    return res.status(200).json(entitlementPayload(doc));
  } catch (error) {
    console.error('Error cancelling Pro:', error);
    return res.status(500).json({ message: 'Server error while cancelling Pro' });
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
