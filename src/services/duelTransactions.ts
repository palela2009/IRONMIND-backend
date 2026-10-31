import mongoose, { ClientSession } from 'mongoose';
import { Duel, IDuel } from '../models/Duel';
import { UserOnboarding } from '../models/UserOnboarding';

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
    if (duel.stake > 0) {
      for (const payer of [duel.fromUid, duel.toUid]) {
        const paid = await UserOnboarding.findOneAndUpdate(
          { uid: payer, coins: { $gte: duel.stake } }, { $inc: { coins: -duel.stake } }, { session }
        );
        if (!paid) throw new DuelError(409, payer === uid ? 'You cannot cover the entry fee' : 'Your friend cannot cover the entry fee');
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
    if (duel.status === 'cancelled') return;
    if (!['pending', 'active'].includes(duel.status)) throw new DuelError(409, 'That duel is already finished');
    if (duel.status === 'active' && duel.endAt && duel.endAt.getTime() <= Date.now()) throw new DuelError(409, 'This duel has ended and is awaiting final results');
    if (duel.status === 'active') await refund(duel, session);
    duel.status = 'cancelled';
    duel.resolutionReason = duel.startAt ? 'Cancelled. Both entry fees were refunded.' : 'Challenge withdrawn. No coins were charged.';
    duel.winnerUid = null;
    await duel.save({ session });
  });
}

export async function settleDuel(id: string) {
  return mongoose.connection.transaction(async (session) => {
    const duel = await Duel.findById(id).session(session);
    if (!duel || duel.status !== 'active' || !duel.endAt || duel.endAt.getTime() > Date.now()) return null;
    const finalFrom = duel.fromMinutes !== null && !!duel.fromReportedAt && duel.fromReportedAt >= duel.endAt;
    const finalTo = duel.toMinutes !== null && !!duel.toReportedAt && duel.toReportedAt >= duel.endAt;
    const final = finalFrom && finalTo;
    if (!final && Date.now() < duel.endAt.getTime() + 600000) return null;
    if (!final || duel.fromMinutes === duel.toMinutes) {
      duel.status = 'void';
      duel.resolutionReason = final ? 'Tie. Both entry fees were refunded.' : 'Final usage was missing after the 10-minute sync window. Both entry fees were refunded.';
      await refund(duel, session);
    } else {
      duel.winnerUid = duel.fromMinutes! < duel.toMinutes! ? duel.fromUid : duel.toUid;
      duel.status = 'completed';
      duel.resolutionReason = 'Both final usage reports received. The lower screen time wins.';
      if (duel.stake > 0) await UserOnboarding.updateOne({ uid: duel.winnerUid }, { $inc: { coins: duel.stake * 2 } }, { session });
    }
    await duel.save({ session });
    return duel;
  });
}
