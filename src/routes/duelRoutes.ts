import { Router, Request, Response } from 'express';
import { Duel, IDuel } from '../models/Duel';
import { UserOnboarding } from '../models/UserOnboarding';
import { FriendRequest } from '../models/FriendRequest';
import { sendPush } from '../services/notifications';
import { DUEL_REACTIONS, REACTION_COOLDOWN_MS } from '../constants/reactions';

const router = Router();

const DUEL_DURATION_MS = 24 * 60 * 60 * 1000;
const SETTLE_GRACE_MS = 10 * 60 * 1000;

function nameFor(profile?: { displayName?: string; email?: string } | null): string {
  return profile?.displayName || profile?.email || 'Unknown';
}

async function areFriends(a: string, b: string): Promise<boolean> {
  const link = await FriendRequest.findOne({
    status: 'accepted',
    $or: [{ fromUid: a, toUid: b }, { fromUid: b, toUid: a }],
  });
  return !!link;
}

async function refundAntes(duel: IDuel): Promise<void> {
  if (duel.stake <= 0) return;
  await UserOnboarding.updateMany(
    { uid: { $in: [duel.fromUid, duel.toUid] } },
    { $inc: { coins: duel.stake } }
  );
}

async function settleDuel(duel: IDuel): Promise<void> {
  const { fromMinutes, toMinutes } = duel;

  if (fromMinutes === null || toMinutes === null || fromMinutes === toMinutes) {
    duel.status = 'void';
    await duel.save();
    await refundAntes(duel);
    return;
  }

  const winnerUid = fromMinutes < toMinutes ? duel.fromUid : duel.toUid;

  duel.winnerUid = winnerUid;
  duel.status = 'completed';
  await duel.save();

  if (duel.stake > 0) {
    await UserOnboarding.updateOne({ uid: winnerUid }, { $inc: { coins: duel.stake * 2 } });
  }

  const loserUid = winnerUid === duel.fromUid ? duel.toUid : duel.fromUid;
  const [winner, loser] = await Promise.all([
    UserOnboarding.findOne({ uid: winnerUid }),
    UserOnboarding.findOne({ uid: loserUid }),
  ]);

  sendPush(winnerUid, 'Duel won', duel.stake > 0 ? `You beat ${nameFor(loser)} on ${duel.app}. Pot: ${duel.stake * 2} coins.` : `You beat ${nameFor(loser)} on ${duel.app}.`, {
    type: 'duel_result',
  });
  sendPush(loserUid, 'Duel lost', `${nameFor(winner)} spent less time on ${duel.app}.`, {
    type: 'duel_result',
  });
}

async function settleExpiredFor(uid: string): Promise<void> {
  const cutoff = new Date(Date.now() - SETTLE_GRACE_MS);
  const expired = await Duel.find({
    status: 'active',
    endAt: { $lte: cutoff },
    $or: [{ fromUid: uid }, { toUid: uid }],
  });
  for (const duel of expired) {
    await settleDuel(duel);
  }
}

router.post('/', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = req.uid as string;
    const { toUid, app, apps, stake } = req.body;
    const appList: string[] = Array.from(
      new Set((Array.isArray(apps) ? apps : app ? [app] : []).map((a: unknown) => String(a).trim()).filter(Boolean))
    );

    if (!toUid || appList.length === 0) {
      return res.status(400).json({ message: 'toUid and at least one app are required' });
    }
    if (appList.length > 5) {
      return res.status(400).json({ message: 'A duel can cover at most 5 apps' });
    }
    if (toUid === uid) {
      return res.status(400).json({ message: "You can't duel yourself" });
    }
    if (!(await areFriends(uid, toUid))) {
      return res.status(403).json({ message: 'You can only duel friends' });
    }

    const existing = await Duel.findOne({
      status: { $in: ['pending', 'active'] },
      $or: [{ fromUid: uid, toUid }, { fromUid: toUid, toUid: uid }],
    });
    if (existing) {
      return res.status(400).json({ message: 'You already have a duel running with them' });
    }

    const requested = Number(stake);
    const ante = Number.isFinite(requested) && requested >= 0 ? Math.round(requested) : 50;

    if (ante > 0) {
      const me = await UserOnboarding.findOne({ uid });
      if ((me?.coins ?? 0) < ante) {
        return res.status(409).json({ message: `You need ${ante} coins to start this duel` });
      }
    }

    const duel = await Duel.create({
      fromUid: uid,
      toUid,
      app: appList.join(' + '),
      apps: appList,
      stake: ante,
      status: 'pending',
    });

    return res.status(201).json(duel);
  } catch (error) {
    console.error('Error creating duel:', error);
    return res.status(500).json({ message: 'Server error while creating duel' });
  }
});

router.get('/', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = req.uid as string;
    await settleExpiredFor(uid);

    const duels = await Duel.find({ $or: [{ fromUid: uid }, { toUid: uid }] })
      .sort({ createdAt: -1 })
      .limit(50);

    const opponentUids = duels.map((d) => (d.fromUid === uid ? d.toUid : d.fromUid));
    const profiles = await UserOnboarding.find({ uid: { $in: opponentUids } });
    const profileMap = new Map(profiles.map((p) => [p.uid, p]));

    const result = duels.map((d) => {
      const isFrom = d.fromUid === uid;
      const opponentUid = isFrom ? d.toUid : d.fromUid;
      return {
        id: d._id,
        app: d.app,
        apps: d.apps?.length ? d.apps : [d.app],
        stake: d.stake,
        status: d.status,
        startAt: d.startAt,
        endAt: d.endAt,
        opponentUid,
        opponentName: nameFor(profileMap.get(opponentUid)),
        opponentPhotoURL: profileMap.get(opponentUid)?.photoURL ?? null,
        myMinutes: isFrom ? d.fromMinutes : d.toMinutes,
        theirMinutes: isFrom ? d.toMinutes : d.fromMinutes,
        theirReportedAt: isFrom ? d.toReportedAt : d.fromReportedAt,
        myReactedAt: isFrom ? d.fromReactedAt : d.toReactedAt,
        theirReaction: isFrom ? d.toReaction : d.fromReaction,
        theirReactedAt: isFrom ? d.toReactedAt : d.fromReactedAt,
        iWon: d.status === 'completed' ? d.winnerUid === uid : null,
        incoming: !isFrom,
      };
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error('Error fetching duels:', error);
    return res.status(500).json({ message: 'Server error while fetching duels' });
  }
});

router.post('/:id/accept', async (req: Request, res: Response): Promise<any> => {
  try {
    const duel = await Duel.findById(req.params.id);
    if (!duel || duel.toUid !== req.uid) {
      return res.status(404).json({ message: 'Duel not found' });
    }
    if (duel.status !== 'pending') {
      return res.status(409).json({ message: `That duel is already ${duel.status}` });
    }

    const challenger = duel.stake <= 0 ? true : await UserOnboarding.findOneAndUpdate(
      { uid: duel.fromUid, coins: { $gte: duel.stake } },
      { $inc: { coins: -duel.stake } },
      { new: true }
    );
    if (!challenger) {
      return res.status(409).json({ message: 'They cannot cover the ante right now' });
    }

    const opponent = duel.stake <= 0 ? true : await UserOnboarding.findOneAndUpdate(
      { uid: duel.toUid, coins: { $gte: duel.stake } },
      { $inc: { coins: -duel.stake } },
      { new: true }
    );
    if (!opponent) {
      await UserOnboarding.updateOne({ uid: duel.fromUid }, { $inc: { coins: duel.stake } });
      return res.status(409).json({ message: `You need ${duel.stake} coins to accept` });
    }

    const now = new Date();
    duel.status = 'active';
    duel.startAt = now;
    duel.endAt = new Date(now.getTime() + DUEL_DURATION_MS);
    await duel.save();

    const accepter = await UserOnboarding.findOne({ uid: duel.toUid });
    sendPush(
      duel.fromUid,
      'Duel accepted',
      `${nameFor(accepter)} took your ${duel.app} duel. 24 hours starting now.`,
      { type: 'duel_accepted', duelId: String(duel._id) }
    );

    return res.status(200).json(duel);
  } catch (error) {
    console.error('Error accepting duel:', error);
    return res.status(500).json({ message: 'Server error while accepting duel' });
  }
});

router.post('/:id/decline', async (req: Request, res: Response): Promise<any> => {
  try {
    const duel = await Duel.findById(req.params.id);
    if (!duel || duel.toUid !== req.uid || duel.status !== 'pending') {
      return res.status(404).json({ message: 'Duel not found' });
    }
    duel.status = 'declined';
    await duel.save();
    return res.status(200).json({ message: 'Duel declined' });
  } catch (error) {
    console.error('Error declining duel:', error);
    return res.status(500).json({ message: 'Server error while declining duel' });
  }
});

router.post('/:id/cancel', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = req.uid as string;
    const duel = await Duel.findById(req.params.id);

    if (!duel || (duel.fromUid !== uid && duel.toUid !== uid)) {
      return res.status(404).json({ message: 'Duel not found' });
    }
    if (duel.status !== 'pending' && duel.status !== 'active') {
      return res.status(400).json({ message: 'That duel is already finished' });
    }

    const wasActive = duel.status === 'active';

    duel.status = 'cancelled';
    duel.winnerUid = null;
    await duel.save();

    if (wasActive) await refundAntes(duel);

    return res.status(200).json({ message: 'Duel cancelled' });
  } catch (error) {
    console.error('Error cancelling duel:', error);
    return res.status(500).json({ message: 'Server error while cancelling duel' });
  }
});

router.post('/:id/react', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = req.uid as string;
    const reaction = String(req.body?.reaction ?? '');
    const text = DUEL_REACTIONS[reaction];
    if (!text) {
      return res.status(400).json({ message: 'Unknown reaction' });
    }

    const duel = await Duel.findById(req.params.id);
    if (!duel || (duel.fromUid !== uid && duel.toUid !== uid)) {
      return res.status(404).json({ message: 'Duel not found' });
    }
    if (duel.status !== 'active') {
      return res.status(400).json({ message: 'That duel is not running' });
    }

    const isFrom = duel.fromUid === uid;
    const last = isFrom ? duel.fromReactedAt : duel.toReactedAt;
    const now = new Date();
    if (last && now.getTime() - last.getTime() < REACTION_COOLDOWN_MS) {
      return res.status(429).json({ message: 'Give them a minute before the next one' });
    }

    if (isFrom) {
      duel.fromReaction = reaction;
      duel.fromReactedAt = now;
    } else {
      duel.toReaction = reaction;
      duel.toReactedAt = now;
    }
    await duel.save();

    const sender = await UserOnboarding.findOne({ uid });
    sendPush(isFrom ? duel.toUid : duel.fromUid, nameFor(sender), `${text} · ${duel.app} duel`, {
      type: 'duel_reaction',
      duelId: String(duel._id),
    });

    return res.status(200).json({ message: 'Sent', reactedAt: now });
  } catch (error) {
    console.error('Error sending duel reaction:', error);
    return res.status(500).json({ message: 'Server error while sending reaction' });
  }
});

router.post('/:id/report', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = req.uid as string;
    const { minutes } = req.body;

    if (typeof minutes !== 'number' || !isFinite(minutes) || minutes < 0) {
      return res.status(400).json({ message: 'minutes must be a non-negative number' });
    }

    const duel = await Duel.findById(req.params.id);
    if (!duel || (duel.fromUid !== uid && duel.toUid !== uid)) {
      return res.status(404).json({ message: 'Duel not found' });
    }
    if (duel.status !== 'active') {
      return res.status(400).json({ message: 'Duel is not active' });
    }

    const now = new Date();
    if (duel.fromUid === uid) {
      duel.fromMinutes = minutes;
      duel.fromReportedAt = now;
    } else {
      duel.toMinutes = minutes;
      duel.toReportedAt = now;
    }
    await duel.save();

    if (duel.endAt && now >= duel.endAt) {
      await settleDuel(duel);
    }

    return res.status(200).json({ message: 'Reported', status: duel.status });
  } catch (error) {
    console.error('Error reporting duel usage:', error);
    return res.status(500).json({ message: 'Server error while reporting duel usage' });
  }
});

export default router;
