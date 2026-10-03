import { UserOnboarding, IUserOnboarding } from '../models/UserOnboarding';
import { ChallengeResult } from '../models/ChallengeResult';
import { isProActive } from '../routes/proRoutes';
import { sendPush } from './notifications';

export const REFERRAL_MILESTONES = [
  { at: 3, days: 7 },
  { at: 10, days: 30 },
  { at: 25, days: 90 },
];

export const REFERRAL_WINDOW_DAYS = 7;
const REQUIRED_CHALLENGES = 3;
const REQUIRED_DAYS = 2;
const PRO_MONTHLY_FREEZES = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const nameFor = (doc?: { displayName?: string; email?: string } | null) =>
  doc?.displayName || doc?.email?.split('@')[0] || 'A friend';

export async function attributeReferral(newUid: string, inviterUid: string): Promise<void> {
  const since = new Date(Date.now() - REFERRAL_WINDOW_DAYS * DAY_MS);
  await UserOnboarding.updateOne(
    { uid: newUid, referredBy: null, createdAt: { $gte: since } },
    { $set: { referredBy: inviterUid } }
  );
}

export async function referralProgress(uid: string) {
  const [joined, active, me] = await Promise.all([
    UserOnboarding.countDocuments({ referredBy: uid }),
    UserOnboarding.countDocuments({ referredBy: uid, referralActivatedAt: { $ne: null } }),
    UserOnboarding.findOne({ uid }),
  ]);
  const next = REFERRAL_MILESTONES.find((m) => !(me?.referralRewards ?? []).includes(m.at)) ?? null;
  return { joined, active, next, milestones: REFERRAL_MILESTONES, rewarded: me?.referralRewards ?? [] };
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
  const active = await UserOnboarding.countDocuments({ referredBy: inviterUid, referralActivatedAt: { $ne: null } });

  for (const milestone of REFERRAL_MILESTONES) {
    if (active < milestone.at) break;
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
        ? `${active} friends joined IRONMIND through you. Enjoy ${milestone.days} days of Pro.`
        : `${active} friends joined IRONMIND through you. Thanks for spreading the word.`,
      { type: 'referral_reward' }
    );
    return;
  }

  const next = REFERRAL_MILESTONES.find((m) => m.at > active);
  if (next) {
    sendPush(
      inviterUid,
      `${friendName} is in`,
      `${friendName} joined through your invite. ${active}/${next.at} friends toward ${next.days} days of Pro.`,
      { type: 'referral_progress' }
    );
  }
}

export async function checkReferralActivation(uid: string): Promise<void> {
  const doc = await UserOnboarding.findOne({ uid, referredBy: { $ne: null }, referralActivatedAt: null });
  if (!doc?.referredBy) return;

  const results = await ChallengeResult.find({ userId: uid }).select('timestamp').lean();
  const days = new Set(results.map((r) => Math.floor(Number(r.timestamp) / DAY_MS)));
  if (results.length < REQUIRED_CHALLENGES || days.size < REQUIRED_DAYS) return;

  const activated = await UserOnboarding.findOneAndUpdate(
    { uid, referralActivatedAt: null },
    { $set: { referralActivatedAt: new Date() } },
    { new: true }
  );
  if (!activated?.referredBy) return;

  await rewardInviter(activated.referredBy, nameFor(activated));
}
