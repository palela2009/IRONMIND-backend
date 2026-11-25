import mongoose, { ClientSession } from 'mongoose';
import { Duel, IDuel } from '../models/Duel';
import { UserOnboarding } from '../models/UserOnboarding';

export const DUEL_GRACE_MS = 4 * 60 * 60 * 1000;

export class DuelError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function refund(duel: IDuel, session: ClientSession) {
  if (duel.stake > 0) await UserOnboarding.updateMany(
    { uid: { $in: [duel.fromUid, duel.toUid] } }, { $inc: { coins: duel.stake } }, { session }
  );
}

export async function acceptDuel(id: string, uid: string) {
  return mongoose.connection.transaction(async (session) => {
    const duel = await Duel.findById(id).session(session);
    if (!duel || duel.toUid !== uid) throw new DuelError(404, 'Duel not found');
    if (duel.status === 'active') return { duel, changed: false };
    if (duel.status !== 'pending') throw new DuelError(409, `That duel is already ${duel.status}`);
    const participants = [duel.fromUid, duel.toUid].sort();
    for (const participant of participants) {
      const filter: Record<string, unknown> = { uid: participant, deletionRequestedAt: null };
      const update: Record<string, unknown> = { $inc: { progressRevision: 1, ...(duel.stake > 0 ? { coins: -duel.stake } : {}) } };
      if (duel.stake > 0) filter.coins = { $gte: duel.stake };
      const ok = await UserOnboarding.findOneAndUpdate(filter, update, { session });
      if (!ok) {
        const exists = await UserOnboarding.findOne({ uid: participant, deletionRequestedAt: null }).select('_id').session(session);
        if (!exists) throw new DuelError(409, 'A participant account is unavailable');
        throw new DuelError(409, participant === uid ? 'You cannot cover the entry fee' : 'Your friend cannot cover the entry fee');
      }
    }
    duel.status = 'active';
    duel.startAt = new Date();
    duel.endAt = new Date(duel.startAt.getTime() + 86400000);
    await duel.save({ session });
    return { duel, changed: true };
  });
}

export async function cancelDuel(id: string, uid: string) {
  return mongoose.connection.transaction(async (session) => {
    const duel = await Duel.findById(id).session(session);
    if (!duel || (duel.fromUid !== uid && duel.toUid !== uid)) throw new DuelError(404, 'Duel not found');
    const opponentUid = duel.fromUid === uid ? duel.toUid : duel.fromUid;
    if (duel.status === 'cancelled') return { duel, forfeited: false, changed: false, opponentUid };
    if (duel.status === 'completed' && duel.winnerUid === opponentUid && duel.resolutionReason === 'Opponent forfeited. Pot awarded.') {
      return { duel, forfeited: true, changed: false, opponentUid };
    }
    if (!['pending', 'active'].includes(duel.status)) throw new DuelError(409, 'That duel is already finished');
    if (duel.status === 'active' && duel.endAt && duel.endAt.getTime() <= Date.now()) {
      throw new DuelError(409, 'This duel has ended and is awaiting final results');
    }
    if (duel.status === 'pending') {
      duel.status = 'cancelled';
      duel.resolutionReason = 'Challenge withdrawn. No coins were charged.';
      duel.winnerUid = null;
      await duel.save({ session });
      return { duel, forfeited: false, changed: true, opponentUid };
    }
    for (const participant of [duel.fromUid, duel.toUid].sort()) {
      await UserOnboarding.updateOne({ uid: participant }, { $inc: { progressRevision: 1 } }, { session });
    }
    duel.status = 'completed';
    duel.winnerUid = opponentUid;
    duel.resolutionReason = 'Opponent forfeited. Pot awarded.';
    if (duel.stake > 0) {
      await UserOnboarding.updateOne({ uid: opponentUid }, { $inc: { coins: duel.stake * 2 } }, { session });
    }
    await duel.save({ session });
    return { duel, forfeited: true, changed: true, opponentUid };
  });
}

export async function settleDuel(id: string) {
  return mongoose.connection.transaction(async (session) => {
    const duel = await Duel.findById(id).session(session);
    if (!duel || duel.status !== 'active' || !duel.endAt || duel.endAt.getTime() > Date.now()) return null;
    const deadlineMs = duel.endAt.getTime() + DUEL_GRACE_MS;
    const finalFrom = duel.fromMinutes !== null && !!duel.fromReportedAt && duel.fromReportedAt >= duel.endAt && duel.fromReportedAt.getTime() <= deadlineMs;
    const finalTo = duel.toMinutes !== null && !!duel.toReportedAt && duel.toReportedAt >= duel.endAt && duel.toReportedAt.getTime() <= deadlineMs;
    const bothFinal = finalFrom && finalTo;
    if (!bothFinal && Date.now() < deadlineMs) return null;

    if (bothFinal) {
      if (duel.fromMinutes === duel.toMinutes) {
        duel.status = 'void';
        duel.resolutionReason = 'Tie. Both entry fees were refunded.';
        await refund(duel, session);
      } else {
        duel.winnerUid = duel.fromMinutes! < duel.toMinutes! ? duel.fromUid : duel.toUid;
        duel.status = 'completed';
        duel.resolutionReason = 'Both final usage reports received. The lower screen time wins.';
        if (duel.stake > 0) await UserOnboarding.updateOne({ uid: duel.winnerUid }, { $inc: { coins: duel.stake * 2 } }, { session });
      }
    } else if (finalFrom !== finalTo) {
      duel.winnerUid = finalFrom ? duel.fromUid : duel.toUid;
      duel.status = 'completed';
      duel.resolutionReason = 'Opponent did not sync final usage in time. Won by forfeit.';
      if (duel.stake > 0) await UserOnboarding.updateOne({ uid: duel.winnerUid }, { $inc: { coins: duel.stake * 2 } }, { session });
    } else {
      duel.status = 'void';
      duel.resolutionReason = 'Final usage was missing after the 4-hour sync window. Both entry fees were refunded.';
      await refund(duel, session);
    }

    await duel.save({ session });
    return duel;
  });
}
