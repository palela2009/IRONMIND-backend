import { Router, Request, Response } from 'express';
import { UserOnboarding, IUserOnboarding } from '../models/UserOnboarding';

const router = Router();

export type ProPlan = 'monthly' | 'annual' | 'lifetime';

const FREEZES_PER_GRANT = 3;

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

function entitlementPayload(doc: IUserOnboarding | null) {
  return {
    isPro: isProActive(doc),
    plan: doc?.proPlan ?? null,
    expiresAt: doc?.proExpiresAt ?? null,
    streakFreezes: doc?.streakFreezes ?? 0,
    themeId: doc?.themeId ?? 'default',
  };
}

router.get('/', async (req: Request, res: Response): Promise<any> => {
  try {
    let doc = await UserOnboarding.findOne({ uid: req.uid });

    if (doc && isOwner(doc.email) && doc.proPlan !== 'lifetime') {
      doc = await UserOnboarding.findOneAndUpdate(
        { uid: req.uid },
        {
          $set: { proPlan: 'lifetime', proExpiresAt: null },
          $inc: { streakFreezes: FREEZES_PER_GRANT },
        },
        { new: true }
      );
      console.log(`👑 [API]: Owner Pro granted to ${req.uid}`);
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

    const doc = await UserOnboarding.findOneAndUpdate(
      { uid: req.uid },
      {
        $set: { proPlan: plan, proExpiresAt: expiresAt },
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
