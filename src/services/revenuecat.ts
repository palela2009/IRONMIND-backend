import { UserOnboarding } from '../models/UserOnboarding';

const API = 'https://api.revenuecat.com/v1/subscribers';
const ENTITLEMENT = 'pro';
const PRO_MONTHLY_FREEZES = 20;

type Plan = 'monthly' | 'annual' | 'lifetime';

interface RcEntitlement {
  expires_date: string | null;
  product_identifier: string;
}

export const revenueCatConfigured = (): boolean => !!process.env.REVENUECAT_SECRET_KEY;

const planFor = (productId: string): Plan => {
  if (productId.includes('lifetime')) return 'lifetime';
  if (productId.includes('annual')) return 'annual';
  return 'monthly';
};

async function fetchEntitlement(uid: string): Promise<RcEntitlement | null> {
  const res = await fetch(`${API}/${encodeURIComponent(uid)}`, {
    headers: { Authorization: `Bearer ${process.env.REVENUECAT_SECRET_KEY}` },
  });
  if (!res.ok) throw new Error(`RevenueCat responded ${res.status}`);
  const body = (await res.json()) as { subscriber?: { entitlements?: Record<string, RcEntitlement> } };
  return body.subscriber?.entitlements?.[ENTITLEMENT] ?? null;
}

export async function syncStorePurchase(uid: string) {
  if (!revenueCatConfigured()) return UserOnboarding.findOne({ uid });

  const ent = await fetchEntitlement(uid);
  const expiresAt = ent?.expires_date ? new Date(ent.expires_date) : null;
  const active = !!ent && (expiresAt === null || expiresAt.getTime() > Date.now());

  if (active && ent) {
    const plan = planFor(ent.product_identifier);
    const current = await UserOnboarding.findOne({ uid });
    if (current?.proSource === 'owner') return current;

    const newlyPro = current?.proSource !== 'store';
    return UserOnboarding.findOneAndUpdate(
      { uid },
      {
        $set: {
          proPlan: plan,
          proExpiresAt: plan === 'lifetime' ? null : expiresAt,
          proSource: 'store',
          ...(newlyPro ? { freezesRefilledAt: new Date() } : {}),
        },
        ...(newlyPro ? { $max: { streakFreezes: PRO_MONTHLY_FREEZES } } : {}),
      },
      { new: true }
    );
  }

  return UserOnboarding.findOneAndUpdate(
    { uid, proSource: 'store' },
    { $set: { proPlan: null, proExpiresAt: null, proSource: null } },
    { new: true }
  ).then((doc) => doc ?? UserOnboarding.findOne({ uid }));
}
