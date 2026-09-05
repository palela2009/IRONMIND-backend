import { Router, Request, Response } from 'express';
import { Duel, IDuel } from '../models/Duel';
import { UserOnboarding } from '../models/UserOnboarding';
import { UserStats } from '../models/UserStats';
import { FriendRequest } from '../models/FriendRequest';

const router = Router();

// Mirrors the client's leveling constant. A loser's XP is floored at the start of their
// current level so a duel can never demote them — losing a rank to one bad day reads as a
// bug and punishes exactly the new users the feature is meant to hook.
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

// Settles one finished duel. Lower minutes on the target app wins.
//
// A missing report voids the duel instead of awarding a walkover, and that is deliberate:
// with "fewest minutes wins", the strongest possible play would otherwise be to disable
// tracking — force-stop the app, revoke Usage Access — and report nothing at all. Voiding
// makes that worth zero. It also protects honest users whose OEM killed the foreground
// service, who would otherwise silently "win" duels they actually lost.
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

// Render's free tier has no scheduler, so duels settle lazily: any expired duel involving
// this user is resolved the moment they ask for their list. That makes settlement depend on
// someone opening the app rather than on a cron that doesn't exist.
async function settleExpiredFor(uid: string): Promise<void> {
  // The grace period matters: a client fetches its duels and only then reports its final
  // usage, so settling the instant endAt passes would resolve the duel against stale
  // numbers a moment before the real ones arrive. Within the grace window the duel stays
  // active and the incoming report settles it directly; past it, the last live report
  // from each side is used.
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

// POST /api/duels — challenge a friend. { toUid, app, stake? }
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

    // One live duel per pair keeps the stakes legible — a stack of concurrent duels against
    // the same person on the same app would all resolve off the same screen-time number.
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

// GET /api/duels — every duel involving me, newest first, with expired ones settled first.
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

    // Flattened to "my side / their side" so the client never has to work out which end of
    // the duel it is on before rendering a row.
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
        // Only meaningful once completed; null on a void duel, which has no winner by design.
        iWon: d.status === 'completed' ? d.winnerUid === uid : null,
        // Drives whether the client shows accept/decline buttons for this row.
        incoming: !isFrom,
      };
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error('Error fetching duels:', error);
    return res.status(500).json({ message: 'Server error while fetching duels' });
  }
});

// POST /api/duels/:id/accept — starts the rolling 24h window now.
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

// POST /api/duels/:id/decline
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

// POST /api/duels/:id/report — { minutes } measured by my own device over the duel window.
// Called repeatedly while a duel is live so both sides can see a running score, and once
// more after it closes to supply the final figure.
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
    // A completed duel is final — accepting late reports would let a player rewrite a result
    // after seeing it.
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

    // Reporting right after the window closes is the normal path to settlement — the client
    // sends its final number and the duel resolves in the same request.
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
