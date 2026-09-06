import { Router, Request, Response } from 'express';
import { Duel, IDuel } from '../models/Duel';
import { UserOnboarding } from '../models/UserOnboarding';
import { UserStats } from '../models/UserStats';
import { FriendRequest } from '../models/FriendRequest';

const router = Router();

const XP_PER_LEVEL = 200;
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

async function settleDuel(duel: IDuel): Promise<void> {
  const { fromMinutes, toMinutes } = duel;

  if (fromMinutes === null || toMinutes === null || fromMinutes === toMinutes) {
    duel.status = 'void';
    await duel.save();
    return;
  }

  const winnerUid = fromMinutes < toMinutes ? duel.fromUid : duel.toUid;
  const loserUid = winnerUid === duel.fromUid ? duel.toUid : duel.fromUid;

  duel.winnerUid = winnerUid;
  duel.status = 'completed';
  await duel.save();

  const loserStats = await UserStats.findOne({ userId: loserUid });
  if (loserStats) {
    const levelFloor = Math.max(0, (loserStats.level - 1) * XP_PER_LEVEL);
    loserStats.currentXP = Math.max(levelFloor, loserStats.currentXP - duel.stake);
    loserStats.updatedAt = new Date();
    await loserStats.save();
  }
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
    const { toUid, app, stake } = req.body;

    if (!toUid || !app) {
      return res.status(400).json({ message: 'toUid and app are required' });
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

    const duel = await Duel.create({
      fromUid: uid,
      toUid,
      app: String(app),
      stake: Number(stake) > 0 ? Number(stake) : 100,
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
    if (!duel || duel.toUid !== req.uid || duel.status !== 'pending') {
      return res.status(404).json({ message: 'Duel not found' });
    }

    const now = new Date();
    duel.status = 'active';
    duel.startAt = now;
    duel.endAt = new Date(now.getTime() + DUEL_DURATION_MS);
    await duel.save();

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

    duel.status = 'cancelled';
    duel.winnerUid = null;
    await duel.save();

    return res.status(200).json({ message: 'Duel cancelled' });
  } catch (error) {
    console.error('Error cancelling duel:', error);
    return res.status(500).json({ message: 'Server error while cancelling duel' });
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
