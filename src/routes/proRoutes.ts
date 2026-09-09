import { Router, Request, Response } from 'express';
import { UserOnboarding, IUserOnboarding } from '../models/UserOnboarding';

const router = Router();

export type ProPlan = 'monthly' | 'annual' | 'lifetime';

const PRO_MONTHLY_FREEZES = 20;
const PRO_MONTHLY_COINS = 500;

// Seven rather than three: Advanced Analytics is empty on day one and needs several days of
// history before it shows anything, so a shorter trial has people judging the headline Pro
// feature while it is still a blank chart.
const TRIAL_DAYS = 7;

// Enough to fund a duel ante on day one, so the feature is reachable immediately, but short
// of the 200 a streak freeze costs — the shop should still be earned rather than handed over.
const STARTER_COINS = 150;

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

export function isTrialActive(doc: Pick<IUserOnboarding, 'trialEndsAt'> | null): boolean {
  return !!doc?.trialEndsAt && doc.trialEndsAt.getTime() > Date.now();
}

export function isProActive(
  doc: Pick<IUserOnboarding, 'proPlan' | 'proExpiresAt' | 'email' | 'trialEndsAt'> | null
): boolean {
  if (!doc) return false;
  if (isOwner(doc.email)) return true;
  // A live trial grants the full entitlement. Everything gated on Pro therefore works during
  // the trial without any feature needing to know a trial exists.
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
    ownedFrames: doc?.ownedFrames ?? [],
    ownedNameEffects: doc?.ownedNameEffects ?? [],
    equippedFrame: doc?.equippedFrame ?? null,
    equippedNameEffect: doc?.equippedNameEffect ?? null,
    themeId: doc?.themeId ?? 'default',
    // Eligible until the account explicitly closes it. A missing document counts as eligible
    // rather than ineligible: the document is only created during onboarding, so requiring one
    // meant the newest users - the entire audience for a welcome offer - never saw it.
    welcomeOffer: !doc?.welcomeOfferClosedAt && !isProActive(doc),
    onTrial: isTrialActive(doc),
    trialEndsAt: doc?.trialEndsAt ?? null,
    // Offered only to an account that has never started one, so a lapsed trial cannot restart.
    trialAvailable: !doc?.trialStartedAt && !doc?.proPlan,
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

    if (doc && !doc.starterCoinsGrantedAt) {
      doc = await UserOnboarding.findOneAndUpdate(
        { uid: req.uid, starterCoinsGrantedAt: null },
        { $inc: { coins: STARTER_COINS }, $set: { starterCoinsGrantedAt: new Date() } },
        { new: true }
      ) ?? doc;
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

// POST /api/pro/trial/start — begins the one-time free trial.
//
// Guarded on trialStartedAt being unset, atomically, so repeated taps or a retry cannot
// extend an existing trial.
router.post('/trial/start', async (req: Request, res: Response): Promise<any> => {
  try {
    const now = new Date();
    const doc = await UserOnboarding.findOneAndUpdate(
      { uid: req.uid, trialStartedAt: null, proPlan: null },
      {
        $set: {
          trialStartedAt: now,
          trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000),
          welcomeOfferClosedAt: now,
        },
      },
      { new: true }
    );

    if (!doc) {
      return res.status(409).json({ message: 'Trial already used' });
    }

    console.log(`🎁 [API]: Trial started for ${req.uid}`);
    return res.status(200).json(entitlementPayload(doc));
  } catch (error) {
    console.error('Error starting trial:', error);
    return res.status(500).json({ message: 'Server error while starting trial' });
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
