import { Router, Request, Response } from 'express';
import { UserOnboarding, IUserOnboarding } from '../models/UserOnboarding';

const router = Router();

export type ProPlan = 'monthly' | 'annual' | 'lifetime';

// Freezes granted when a subscription starts or renews. Deliberately finite: unlimited
// streak protection would make the streak — the number the whole app is built around —
// meaningless for paying users.
const FREEZES_PER_GRANT = 3;

const PLAN_DURATION_DAYS: Record<ProPlan, number | null> = {
  monthly: 30,
  annual: 365,
  lifetime: null, // no expiry
};

// Single source of truth for "is this account Pro right now", derived rather than stored so
// a lapsed subscription can never leave a stale flag granting free access.
export function isProActive(doc: Pick<IUserOnboarding, 'proPlan' | 'proExpiresAt'> | null): boolean {
  if (!doc?.proPlan) return false;
  if (doc.proPlan === 'lifetime') return true;
  return !!doc.proExpiresAt && doc.proExpiresAt.getTime() > Date.now();
}

function entitlementPayload(doc: IUserOnboarding | null) {
  return {
    isPro: isProActive(doc),
    plan: doc?.proPlan ?? null,
    expiresAt: doc?.proExpiresAt ?? null,
    streakFreezes: doc?.streakFreezes ?? 0,
    themeId: doc?.themeId ?? 'default',
  };
}

// GET /api/pro — current entitlement for the signed-in user.
router.get('/', async (req: Request, res: Response): Promise<any> => {
  try {
    const doc = await UserOnboarding.findOne({ uid: req.uid });
    return res.status(200).json(entitlementPayload(doc));
  } catch (error) {
    console.error('Error fetching entitlement:', error);
    return res.status(500).json({ message: 'Server error while fetching entitlement' });
  }
});

// POST /api/pro/activate — { plan }
//
// This is the seam that real Google Play billing will plug into. Today it trusts the client,
// which is only acceptable because it is locked behind ALLOW_DEV_PRO and exists so the Pro
// experience can be built and tested before a Play Console account is available. When
// billing lands, this handler verifies a purchase token against the Play Developer API and
// the env flag goes away — the client contract stays identical.
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

    const doc = await UserOnboarding.findOneAndUpdate(
      { uid: req.uid },
      {
        $set: { proPlan: plan, proExpiresAt: expiresAt },
        // Incremented rather than assigned so activating doesn't wipe freezes the user
        // already earned from rewarded ads.
        $inc: { streakFreezes: FREEZES_PER_GRANT },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    console.log(`⭐ [API]: Pro activated (${plan}) for user: ${req.uid}`);
    return res.status(200).json(entitlementPayload(doc));
  } catch (error) {
    console.error('Error activating Pro:', error);
    return res.status(500).json({ message: 'Server error while activating Pro' });
  }
});

// POST /api/pro/cancel — drops back to free. Dev/testing counterpart to activate.
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

// POST /api/pro/freeze/use — spend one freeze to absorb a failed challenge.
//
// The check and the decrement are one atomic update: a plain read-then-write would let two
// challenges resolving at once both see the last freeze and each keep their streak.
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

// POST /api/pro/freeze/grant — award a freeze, e.g. after a rewarded ad.
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

// POST /api/pro/theme — { themeId }
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
