import { Router, Request, Response } from 'express';
import { Duel } from '../models/Duel';
import { UserOnboarding } from '../models/UserOnboarding';
import { FriendRequest } from '../models/FriendRequest';
import { sendPush } from '../services/notifications';
import { DUEL_REACTIONS, REACTION_COOLDOWN_MS } from '../constants/reactions';
import { acceptDuel, cancelDuel, settleDuel, DuelError, DUEL_GRACE_MS } from '../services/duelTransactions';
import { isValidObjectId } from 'mongoose';

const router = Router();
router.param('id', (_req, res, next, id) => {
  if (!isValidObjectId(id)) { res.status(400).json({ message: 'Invalid duel ID' }); return; }
  next();
});

function nameFor(profile?: { displayName?: string } | null): string {
  return profile?.displayName?.trim() || 'IRONMIND User';
}

async function areFriends(a: string, b: string): Promise<boolean> {
  const link = await FriendRequest.findOne({
    status: 'accepted',
    $or: [{ fromUid: a, toUid: b }, { fromUid: b, toUid: a }],
  }).select('_id').lean();
  return !!link;
}

export async function settleAndNotify(id: string) {
  const duel = await settleDuel(id);
  if (!duel) return;
  for (const uid of [duel.fromUid, duel.toUid]) {
    void sendPush(
      uid,
      duel.status === 'void' ? 'Duel refunded' : duel.winnerUid === uid ? 'Duel won!' : 'Duel finished',
      duel.resolutionReason ?? 'View your final result.',
      { type: 'duel_result', duelId: id }
    );
  }
}

async function settleExpiredFor(uid: string): Promise<void> {
  const expired = await Duel.find({
    status: 'active',
    endAt: { $lte: new Date() },
    $or: [{ fromUid: uid }, { toUid: uid }],
  }).select('_id').lean();
  for (const duel of expired) {
    try { await settleAndNotify(String(duel._id)); }
    catch (error) { console.error('Failed settling duel:', duel._id, error); }
  }
}

router.post('/', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = req.uid as string;
    const { toUid, app, apps, stake } = req.body ?? {};
    if (typeof toUid !== 'string' || !toUid.trim() || toUid.length > 128) {
      return res.status(400).json({ message: 'Valid toUid is required' });
    }
    const rawApps = Array.isArray(apps) ? apps : typeof app === 'string' && app.trim() ? [app] : [];
    const appList: string[] = Array.from(
      new Set(
        rawApps
          .filter((a: unknown): a is string => typeof a === 'string')
          .map((a) => a.trim())
          .filter((a) => a.length > 0 && a.length <= 64)
      )
    );

    if (appList.length === 0) {
      return res.status(400).json({ message: 'At least one app is required' });
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
    }).select('_id').lean();
    if (existing) {
      return res.status(400).json({ message: 'You already have a duel running with them' });
    }

    let ante = 50;
    if (stake !== undefined) {
      if (typeof stake !== 'number' || !Number.isFinite(stake) || !Number.isInteger(stake) || stake < 0 || stake > 10000) {
        return res.status(400).json({ message: 'Entry fee must be an integer between 0 and 10000 coins' });
      }
      ante = stake;
    }

    if (ante > 0) {
      const me = await UserOnboarding.findOne({ uid }).select('coins').lean();
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

    const sender = await UserOnboarding.findOne({ uid }).select('displayName').lean();
    void sendPush(
      toUid,
      'New 24h duel challenge',
      `${nameFor(sender)} challenged you on ${appList.join(', ')}${ante > 0 ? ` for ${ante} coins` : ''}.`,
      { type: 'duel_invite', duelId: String(duel._id) }
    );

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
      .limit(50)
      .lean();

    const opponentUids = Array.from(new Set(duels.map((d) => (d.fromUid === uid ? d.toUid : d.fromUid))));
    const profiles = await UserOnboarding.find({ uid: { $in: opponentUids } })
      .select('uid displayName photoURL')
      .lean();
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
    const existing = await Duel.findById(req.params.id).select('fromUid toUid status').lean();
    if (!existing || existing.toUid !== req.uid) {
      res.status(404).json({ message: 'Duel not found' });
      return;
    }
    if (existing.status === 'pending' && !(await areFriends(existing.fromUid, existing.toUid))) {
      res.status(403).json({ message: 'You can only accept duels from friends' });
      return;
    }
    const { duel, changed } = await acceptDuel(String(req.params.id), req.uid);
    if (changed) {
      void sendPush(
        duel.fromUid,
        'Duel accepted!',
        'Your 24-hour duel is live. Usage syncs automatically in the background.',
        { type: 'duel_accepted', duelId: String(duel._id) }
      );
    }
    res.json(duel);
  } catch (error) {
    res.status(error instanceof DuelError ? error.status : 503).json({
      message: error instanceof DuelError ? error.message : 'Could not accept the duel. Try again.',
    });
  }
});

router.post('/:id/decline', async (req: Request, res: Response) => {
  try {
    const duel = await Duel.findOneAndUpdate({ _id: req.params.id, toUid: req.uid, status: 'pending' }, { $set: { status: 'declined' } });
    res.status(duel ? 200 : 409).json({ message: duel ? 'Duel declined' : 'That challenge is no longer pending' });
  } catch { res.status(503).json({ message: 'Could not decline the duel' }); }
});

router.post('/:id/cancel', async (req: Request, res: Response) => {
  try {
    const { duel, forfeited, changed, opponentUid } = await cancelDuel(String(req.params.id), req.uid);
    if (forfeited && changed) {
      const me = await UserOnboarding.findOne({ uid: req.uid }).select('displayName').lean();
      void sendPush(
        opponentUid,
        'You won the duel!',
        `${nameFor(me)} forfeited the ${duel.app} duel.${duel.stake > 0 ? ` +${duel.stake * 2} coins awarded.` : ''}`,
        { type: 'duel_result', duelId: String(duel._id) }
      );
    }
    res.json({
      forfeited,
      message: forfeited
        ? duel.stake > 0
          ? `Duel forfeited. ${duel.stake * 2} coins were awarded to your opponent.`
          : 'Duel forfeited.'
        : 'Challenge withdrawn. No coins were charged.',
    });
  } catch (error) {
    res.status(error instanceof DuelError ? error.status : 503).json({
      message: error instanceof DuelError ? error.message : 'Could not cancel the duel. Try again.',
    });
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

    const existing = await Duel.findById(req.params.id).select('fromUid toUid status endAt app').lean();
    if (!existing || (existing.fromUid !== uid && existing.toUid !== uid)) {
      return res.status(404).json({ message: 'Duel not found' });
    }
    const now = new Date();
    if (existing.status !== 'active' || (existing.endAt && existing.endAt.getTime() <= now.getTime())) {
      return res.status(400).json({ message: 'That duel is not running' });
    }

    const isFrom = existing.fromUid === uid;
    const reactField = isFrom ? 'fromReaction' : 'toReaction';
    const timeField = isFrom ? 'fromReactedAt' : 'toReactedAt';
    const cutoff = new Date(now.getTime() - REACTION_COOLDOWN_MS);

    const updated = await Duel.findOneAndUpdate(
      {
        _id: existing._id,
        status: 'active',
        $or: [{ [timeField]: null }, { [timeField]: { $lte: cutoff } }],
      },
      { $set: { [reactField]: reaction, [timeField]: now } },
      { returnDocument: 'after' }
    );
    if (!updated) {
      return res.status(429).json({ message: 'Give them a minute before the next one' });
    }

    const sender = await UserOnboarding.findOne({ uid }).select('displayName').lean();
    sendPush(isFrom ? existing.toUid : existing.fromUid, nameFor(sender), `${text} · ${existing.app} duel`, {
      type: 'duel_reaction',
      duelId: String(existing._id),
    });

    return res.status(200).json({ message: 'Sent', reactedAt: now });
  } catch (error) {
    console.error('Error sending duel reaction:', error);
    return res.status(500).json({ message: 'Server error while sending reaction' });
  }
});

router.post('/:id/report', async (req: Request, res: Response) => {
  try {
    const { minutes } = req.body ?? {};
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
      res.status(400).json({ message: 'Usage must be between 0 and 1440 minutes' });
      return;
    }
    const duel = await Duel.findById(req.params.id).select('fromUid toUid status endAt').lean();
    if (!duel || (duel.fromUid !== req.uid && duel.toUid !== req.uid)) {
      res.status(404).json({ message: 'Duel not found' });
      return;
    }
    if (duel.status === 'active' && duel.endAt && Date.now() >= duel.endAt.getTime() + DUEL_GRACE_MS) {
      await settleAndNotify(String(duel._id));
      res.status(409).json({ message: 'Duel sync window has closed' });
      return;
    }

    const side = duel.fromUid === req.uid ? 'from' : 'to';
    const updated = await Duel.findOneAndUpdate(
      { _id: duel._id, status: 'active' },
      { $max: { [side + 'Minutes']: minutes }, $set: { [side + 'ReportedAt']: new Date() } },
      { returnDocument: 'after' }
    );
    if (!updated) {
      res.status(409).json({ message: 'Duel is already finished' });
      return;
    }
    await settleAndNotify(String(duel._id));
    res.json({ message: 'Usage synced' });
  } catch {
    res.status(503).json({ message: 'Could not sync usage. Try again.' });
  }
});

export default router;
