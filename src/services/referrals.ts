import { UserOnboarding, IUserOnboarding } from '../models/UserOnboarding';
import { isProActive } from '../routes/proRoutes';
import { sendPush } from './notifications';

export const REFERRAL_MILESTONES = [
  { at: 3, days: 7 },
  { at: 10, days: 30 },
  { at: 25, days: 90 },
];

export const REFERRAL_WINDOW_DAYS = 7;
const PRO_MONTHLY_FREEZES = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const nameFor = (doc?: { displayName?: string; email?: string } | null) =>
  doc?.displayName || doc?.email?.split('@')[0] || 'A friend';

export async function attributeReferral(newUid: string, inviterUid: string, deviceHash: string | null): Promise<boolean> {
  if (!deviceHash) return false;

  const inviter = await UserOnboarding.findOne({ uid: inviterUid });
  if (!inviter || inviter.deviceIds?.includes(deviceHash)) return false;

  const deviceAlreadyUsed = await UserOnboarding.exists({
    uid: { $ne: newUid },
    referredBy: { $ne: null },
    deviceIds: deviceHash,
  });
  if (deviceAlreadyUsed) return false;

  const since = new Date(Date.now() - REFERRAL_WINDOW_DAYS * DAY_MS);
  const joined = await UserOnboarding.findOneAndUpdate(
    { uid: newUid, referredBy: null, createdAt: { $gte: since } },
    {
      $set: { referredBy: inviterUid, referralActivatedAt: new Date() },
      $addToSet: { deviceIds: deviceHash },
    },
    { new: true }
  );
  if (!joined) return false;

  await rewardInviter(inviterUid, nameFor(joined));
  return true;
}

export async function referralProgress(uid: string) {
  const [joined, me] = await Promise.all([
    UserOnboarding.countDocuments({ referredBy: uid }),
    UserOnboarding.findOne({ uid }),
  ]);
  const next = REFERRAL_MILESTONES.find((m) => !(me?.referralRewards ?? []).includes(m.at)) ?? null;
  return { joined, active: joined, next, milestones: REFERRAL_MILESTONES, rewarded: me?.referralRewards ?? [] };
}

async function grantProDays(inviter: IUserOnboarding, days: number): Promise<boolean> {
  const active = isProActive(inviter);
  if (active && (inviter.proSource === 'owner' || inviter.proSource === 'store' || inviter.proPlan === 'lifetime')) {
    return false;
  }
  const base = active && inviter.proExpiresAt ? inviter.proExpiresAt.getTime() : Date.now();
  await UserOnboarding.updateOne(
    { uid: inviter.uid },
    {
      $set: {
        proPlan: 'monthly',
        proExpiresAt: new Date(base + days * DAY_MS),
        proSource: 'invites',
        ...(active ? {} : { freezesRefilledAt: new Date() }),
      },
      ...(active ? {} : { $max: { streakFreezes: PRO_MONTHLY_FREEZES } }),
    }
  );
  return true;
}

async function rewardInviter(inviterUid: string, friendName: string): Promise<void> {
  const joined = await UserOnboarding.countDocuments({ referredBy: inviterUid });

  for (const milestone of REFERRAL_MILESTONES) {
    if (joined < milestone.at) break;
    const claimed = await UserOnboarding.findOneAndUpdate(
      { uid: inviterUid, referralRewards: { $ne: milestone.at } },
      { $addToSet: { referralRewards: milestone.at } },
      { new: true }
    );
    if (!claimed) continue;

    const granted = await grantProDays(claimed, milestone.days);
    sendPush(
      inviterUid,
      granted ? `${milestone.days} days of Pro unlocked` : 'Invite milestone reached',
      granted
        ? `${joined} friends joined IRONMIND with your code. Enjoy ${milestone.days} days of Pro.`
        : `${joined} friends joined IRONMIND with your code. Thanks for spreading the word.`,
      { type: 'referral_reward' }
    );
    return;
  }

  const next = REFERRAL_MILESTONES.find((m) => m.at > joined);
  if (next) {
    sendPush(
      inviterUid,
      `${friendName} joined with your code`,
      `${joined}/${next.at} friends toward ${next.days} days of Pro.`,
      { type: 'referral_progress' }
    );
  }
}
