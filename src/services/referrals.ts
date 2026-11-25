import mongoose from 'mongoose';
import { UserOnboarding } from '../models/UserOnboarding';
import { isProActive, isOwner } from '../routes/proRoutes';
import { sendPush } from './notifications';

export const REFERRAL_MILESTONES = [
  { at: 3, days: 7 },
  { at: 10, days: 30 },
  { at: 25, days: 90 },
];

export const REFERRAL_WINDOW_DAYS = 7;
const SAME_DEVICE_CHECK = true;
const PRO_MONTHLY_FREEZES = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

const nameFor = (doc?: { displayName?: string } | null) => doc?.displayName?.trim() || 'A friend';

const sameCalendarMonth = (d: Date | null | undefined): boolean => {
  if (!d) return false;
  const now = new Date();
  return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
};

export async function attributeReferral(newUid: string, inviterUid: string, deviceHash: string | null): Promise<boolean> {
  const inviter = await UserOnboarding.findOne({ uid: inviterUid, deletionRequestedAt: null });
  if (!inviter) return false;

  if (SAME_DEVICE_CHECK && !isOwner(inviter.verifiedEmail)) {
    if (!deviceHash || inviter.deviceIds?.includes(deviceHash)) return false;
    const deviceAlreadyUsed = await UserOnboarding.exists({
      uid: { $ne: newUid },
      referredBy: { $ne: null },
      deviceIds: deviceHash,
    });
    if (deviceAlreadyUsed) return false;
  }

  const since = new Date(Date.now() - REFERRAL_WINDOW_DAYS * DAY_MS);
  const joined = await UserOnboarding.findOneAndUpdate(
    { uid: newUid, referredBy: null, deletionRequestedAt: null, createdAt: { $gte: since } },
    {
      $set: { referredBy: inviterUid, referralActivatedAt: new Date() },
      ...(deviceHash ? { $addToSet: { deviceIds: deviceHash } } : {}),
    },
    { returnDocument: 'after' }
  );
  if (!joined) return false;

  await rewardInviter(inviterUid, nameFor(joined));
  return true;
}

export async function referralProgress(uid: string) {
  const [joined, me] = await Promise.all([
    UserOnboarding.countDocuments({ referredBy: uid }),
    UserOnboarding.findOne({ uid }).select('referralRewards').lean(),
  ]);
  const next = REFERRAL_MILESTONES.find((m) => !(me?.referralRewards ?? []).includes(m.at)) ?? null;
  return { joined, active: joined, next, milestones: REFERRAL_MILESTONES, rewarded: me?.referralRewards ?? [] };
}

async function rewardInviter(inviterUid: string, friendName: string): Promise<void> {
  const joined = await UserOnboarding.countDocuments({ referredBy: inviterUid });

  for (const milestone of REFERRAL_MILESTONES) {
    if (joined < milestone.at) break;
    const outcome = await mongoose.connection.transaction(async (session) => {
      const inviter = await UserOnboarding.findOneAndUpdate(
        { uid: inviterUid, deletionRequestedAt: null, referralRewards: { $ne: milestone.at } },
        { $addToSet: { referralRewards: milestone.at }, $inc: { progressRevision: 1 } },
        { returnDocument: 'after', session }
      );
      if (!inviter) return null;

      const active = isProActive(inviter);
      let granted = false;
      if (!(active && (inviter.proSource === 'owner' || inviter.proSource === 'store' || inviter.proPlan === 'lifetime'))) {
        const base = Math.max(
          Date.now(),
          inviter.proExpiresAt?.getTime() ?? 0,
          inviter.trialEndsAt?.getTime() ?? 0
        );
        inviter.proPlan = 'monthly';
        inviter.proExpiresAt = new Date(base + milestone.days * DAY_MS);
        inviter.proSource = 'invites';
        if (!sameCalendarMonth(inviter.freezesRefilledAt)) {
          inviter.freezesRefilledAt = new Date();
          inviter.streakFreezes = Math.max(inviter.streakFreezes, PRO_MONTHLY_FREEZES);
        }
        await inviter.save({ session });
        granted = true;
      }
      return { granted };
    });

    if (!outcome) continue;

    sendPush(
      inviterUid,
      outcome.granted ? `${milestone.days} days of Pro unlocked` : 'Invite milestone reached',
      outcome.granted
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
