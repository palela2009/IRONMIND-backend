import { Router, Request, Response } from 'express';
import { Duel } from '../models/Duel';
import { UserOnboarding } from '../models/UserOnboarding';
import { FriendRequest } from '../models/FriendRequest';
import { sendPush } from '../services/notifications';
import { DUEL_REACTIONS, REACTION_COOLDOWN_MS } from '../constants/reactions';
import { acceptDuel, cancelDuel, settleDuel, DuelError } from '../services/duelTransactions';
import { isValidObjectId } from 'mongoose';

const router = Router();
router.param('id', (_req, res, next, id) => {
  if (!isValidObjectId(id)) { res.status(400).json({ message: 'Invalid duel ID' }); return; }
  next();
});


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

async function settleExpiredFor(uid: string): Promise<void> {
  const expired = await Duel.find({ status: 'active', endAt: { $lte: new Date() }, $or: [{ fromUid: uid }, { toUid: uid }] });
  for (const duel of expired) await settleAndNotify(String(duel._id));
}

async function settleAndNotify(id: string) {
  const duel = await settleDuel(id);
  if (!duel) return;
  for (const uid of [duel.fromUid, duel.toUid]) {
    void sendPush(uid, duel.status === 'void' ? 'Duel refunded' : duel.winnerUid === uid ? 'Duel won' : 'Duel finished', duel.resolutionReason ?? 'View your final result.', { type: 'duel_result', duelId: id });
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

    if (!Number.isSafeInteger(ante) || ante > 10000) return res.status(400).json({ message: 'Entry fee must be between 0 and 10000 coins' });

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
        resolutionReason: d.resolutionReason ?? null,
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

router.post('/:id/accept', async (req: Request, res: Response) => {
  try {
    const { duel, changed } = await acceptDuel(String(req.params.id), req.uid);
    if (changed) void sendPush(duel.fromUid, 'Duel accepted', 'Your 24-hour duel has started. Open IRONMIND after it ends to sync final usage.', { type: 'duel_accepted', duelId: String(duel._id) });
    res.json(duel);
  } catch (error) { res.status(error instanceof DuelError ? error.status : 503).json({ message: error instanceof DuelError ? error.message : 'Could not accept the duel. Try again.' }); }
});

router.post('/:id/decline', async (req: Request, res: Response) => {
  try {
    const duel = await Duel.findOneAndUpdate({ _id: req.params.id, toUid: req.uid, status: 'pending' }, { $set: { status: 'declined' } });
    res.status(duel ? 200 : 409).json({ message: duel ? 'Duel declined' : 'That challenge is no longer pending' });
  } catch { res.status(503).json({ message: 'Could not decline the duel' }); }
});

router.post('/:id/cancel', async (req: Request, res: Response) => {
  try {
    await cancelDuel(String(req.params.id), req.uid);
    res.json({ message: 'Duel cancelled. Any entry fees were refunded.' });
  } catch (error) { res.status(error instanceof DuelError ? error.status : 503).json({ message: error instanceof DuelError ? error.message : 'Could not cancel the duel. Try again.' }); }
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

router.post('/:id/report', async (req: Request, res: Response) => {
  try {
    const { minutes } = req.body;
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
      res.status(400).json({ message: 'Usage must be between 0 and 1440 minutes' }); return;
    }
    const duel = await Duel.findById(req.params.id);
    if (!duel || (duel.fromUid !== req.uid && duel.toUid !== req.uid)) { res.status(404).json({ message: 'Duel not found' }); return; }
    const side = duel.fromUid === req.uid ? 'from' : 'to';
    const updated = await Duel.findOneAndUpdate({ _id: duel._id, status: 'active' }, {
      $max: { [side + 'Minutes']: minutes }, $set: { [side + 'ReportedAt']: new Date() }
    }, { new: true });
    if (!updated) { res.status(409).json({ message: 'Duel is already finished' }); return; }
    await settleAndNotify(String(duel._id));
    res.json({ message: 'Usage synced' });
  } catch { res.status(503).json({ message: 'Could not sync usage. Try again.' }); }
});

export default router;
