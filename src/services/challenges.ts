import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { ChallengeResult } from '../models/ChallengeResult';
import { ChallengeDay } from '../models/ChallengeDay';
import { UserStats } from '../models/UserStats';
import { UserOnboarding } from '../models/UserOnboarding';
import { isProActive } from '../routes/proRoutes';
import { challengeDay } from './challengeTime';

const APPS = ['Instagram', 'YouTube', 'TikTok', 'Facebook', 'X (Twitter)', 'Reddit', 'Snapchat'];

export class ChallengeError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function parseChallenge(body: any) {
  const { targetApp, elapsedTime, wasSuccessful, timestamp } = body ?? {};
  if (!APPS.includes(targetApp) || typeof wasSuccessful !== 'boolean' ||
      !Number.isFinite(elapsedTime) || elapsedTime < 0 || elapsedTime > 86400 ||
      !Number.isSafeInteger(timestamp) || timestamp < 1577836800000 || timestamp > Date.now() + 300000) {
    throw new ChallengeError(400, 'Invalid challenge result');
  }
  if (wasSuccessful && elapsedTime >= 10) throw new ChallengeError(400, 'Successful challenges must finish within the challenge window');
  const eventId = body.eventId ?? createHash('sha256').update(`${targetApp}:${timestamp}`).digest('hex');
  if (typeof eventId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(eventId)) throw new ChallengeError(400, 'Invalid event ID');
  return { eventId, targetApp, elapsedTime, wasSuccessful, timestamp };
}

export async function recordResult(uid: string, body: unknown) {
  const input = parseChallenge(body);
  return mongoose.connection.transaction(async (session) => {
    const profile = await UserOnboarding.findOneAndUpdate({ uid, deletionRequestedAt: null }, { $inc: { progressRevision: 1 } }, { returnDocument: 'after', session });
    if (!profile) throw new ChallengeError(409, 'Complete account setup before syncing');
    const duplicate = await ChallengeResult.findOne({ userId: uid, eventId: input.eventId }).session(session);
    if (duplicate) return { duplicate: true, result: duplicate };

    if (input.timestamp < profile.createdAt.getTime() - 300000) throw new ChallengeError(400, 'Challenge predates this account');
    const sameEvent = await ChallengeResult.findOne({ userId: uid, targetApp: input.targetApp, timestamp: input.timestamp }).session(session);
    if (sameEvent) return { duplicate: true, result: sameEvent };

    const timeZone = profile.challengeTimeZone ?? 'UTC';
    const dayId = `${uid}:${challengeDay(input.timestamp, timeZone)}`;
    const settings = [...profile.challengeSettings].reverse().find((entry) => entry.effectiveAt.getTime() <= input.timestamp) ?? profile;
    const windowSeconds = ({ EASY: 10, INTERMEDIATE: 5, HARD: 3 } as Record<string, number>)[settings.difficultyLevel] ?? 10;
    if (input.wasSuccessful && input.elapsedTime >= windowSeconds) throw new ChallengeError(422, 'Result exceeds your configured challenge window');
    if (settings.targetApps.length && !settings.targetApps.includes(input.targetApp)) throw new ChallengeError(422, 'This app is not selected for challenges');
    const limit = [3, 5, 10].includes(settings.dailyChallengeLimit) ? settings.dailyChallengeLimit : 5;
    let day = await ChallengeDay.findById(dayId).session(session);
    if (!day) {
      const nearby = await ChallengeResult.find({ userId: uid, counted: { $ne: false }, timestamp: { $gte: input.timestamp - 172800000, $lte: input.timestamp + 172800000 } }).session(session);
      const existing = nearby.filter((entry) => challengeDay(entry.timestamp, timeZone) === challengeDay(input.timestamp, timeZone));
      day = new ChallengeDay({ _id: dayId, userId: uid, limit, count: existing.length, wins: existing.filter((entry) => entry.wasSuccessful).length, coins: existing.reduce((total, entry) => total + (entry.coinsGranted ?? 0), 0), perfectAwarded: existing.length >= limit });
    }
    let stats = await UserStats.findOne({ userId: uid }).session(session);
    if (!stats) stats = new UserStats({ userId: uid });

    const beforeStreak = stats.currentStreak;
    const counted = day.count < day.limit;
    let freezeUsed = false;
    let granted = 0;
    if (counted) {
      day.count += 1;
      if (input.wasSuccessful) day.wins += 1;
      freezeUsed = !input.wasSuccessful && stats.currentStreak > 0 && profile.streakFreezes > 0;
      if (freezeUsed) profile.streakFreezes -= 1;
      stats.lostStreak = !input.wasSuccessful && !freezeUsed ? stats.currentStreak : 0;
      stats.reclaimableEventId = stats.lostStreak > 0 ? input.eventId : null;
      const xp = input.wasSuccessful ? 50 + (stats.currentStreak >= 5 ? 10 : 0) : 0;
      stats.currentStreak = input.wasSuccessful ? stats.currentStreak + 1 : freezeUsed ? stats.currentStreak : 0;
      stats.longestStreak = Math.max(stats.longestStreak, stats.currentStreak);
      if (input.wasSuccessful && input.elapsedTime > 0) stats.bestReactionTime = stats.bestReactionTime > 0 ? Math.min(stats.bestReactionTime, input.elapsedTime) : input.elapsedTime;
      stats.totalChallenges += 1;
      stats.successCount += input.wasSuccessful ? 1 : 0;
      stats.currentXP += xp;
      stats.level = Math.floor(stats.currentXP / 200) + 1;
      stats.updatedAt = new Date();
      const perfect = day.count === day.limit && day.wins === day.limit && !day.perfectAwarded;
      if (perfect) day.perfectAwarded = true;
      const wanted = ((input.wasSuccessful ? 10 : 0) + (perfect ? 50 : 0)) * (isProActive(profile) ? 2 : 1);
      const receivedDay = challengeDay(Date.now(), timeZone);
      const earnedToday = profile.coinEarnDate === receivedDay ? profile.coinEarnedToday : 0;
      granted = Math.max(0, Math.min(wanted, 500 - day.coins, 500 - earnedToday));
      day.coins += granted;
      profile.coins += granted;
      profile.coinEarnDate = receivedDay;
      profile.coinEarnedToday = earnedToday + granted;
    }
    const [result] = await ChallengeResult.create([{ userId: uid, ...input, counted, freezeUsed, coinsGranted: granted }], { session });
    await day.save({ session });
    await stats.save({ session });
    await profile.save({ session });
    return { duplicate: false, result, beforeStreak, afterStreak: stats.currentStreak };
  });
}

export async function reclaimResult(uid: string, eventId: unknown) {
  if (typeof eventId !== 'string') throw new ChallengeError(400, 'Challenge ID is required');
  return mongoose.connection.transaction(async (session) => {
    const result = await ChallengeResult.findOne({ userId: uid, eventId }).session(session);
    if (!result) throw new ChallengeError(404, 'Sync this challenge before reclaiming');
    if (result.reclaimed) return;
    const stats = await UserStats.findOne({ userId: uid }).session(session);
    if (!stats || stats.reclaimableEventId !== eventId || stats.lostStreak <= 0) throw new ChallengeError(409, 'This streak can no longer be reclaimed');
    const paid = await UserOnboarding.findOneAndUpdate({ uid, coins: { $gte: 200 } }, { $inc: { coins: -200 } }, { session });
    if (!paid) throw new ChallengeError(409, 'Not enough coins');
    stats.currentStreak = stats.lostStreak;
    stats.longestStreak = Math.max(stats.longestStreak, stats.currentStreak);
    stats.lostStreak = 0;
    stats.reclaimableEventId = null;
    stats.updatedAt = new Date();
    result.reclaimed = true;
    await stats.save({ session });
    await result.save({ session });
  });
}

export async function progressFor(uid: string) {
  const [stats, history, profile] = await Promise.all([
    UserStats.findOne({ userId: uid }).lean(),
    ChallengeResult.find({ userId: uid }).sort({ timestamp: -1, _id: -1 }).limit(200).lean(),
    UserOnboarding.findOne({ uid }).select('streakFreezes coins challengeTimeZone').lean(),
  ]);
  return {
    stats: stats ?? { currentStreak: 0, longestStreak: 0, bestReactionTime: 0, totalChallenges: 0, successCount: 0, currentXP: 0, level: 1 },
    history: history.map((r) => ({ id: r.eventId ?? String(r._id), targetApp: r.targetApp, elapsedTime: r.elapsedTime, wasSuccessful: r.wasSuccessful, timestamp: r.timestamp, counted: r.counted, freezeUsed: r.freezeUsed })),
    streakFreezes: profile?.streakFreezes ?? 0,
    coins: profile?.coins ?? 0,
    timeZone: profile?.challengeTimeZone ?? 'UTC',
  };
}
