import { randomInt } from 'crypto';
import { Router, Request, Response } from 'express';
import { isValidObjectId } from 'mongoose';
import { UserOnboarding } from '../models/UserOnboarding';
import { UserStats } from '../models/UserStats';
import { FriendRequest } from '../models/FriendRequest';
import { ScreenTime } from '../models/ScreenTime';
import { isProActive, isOwner } from './proRoutes';
import { isValidCalendarDate } from './screenTimeRoutes';
import { sendPush } from '../services/notifications';
import { attributeReferral, referralProgress } from '../services/referrals';
import { deviceHashFor, rememberDevice } from '../services/device';

const router = Router();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(length = 6): string {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_CHARS[randomInt(0, CODE_CHARS.length)];
  }
  return code;
}

const shiftDateKey = (key: string, days: number): string => {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
};

const totalMinutes = (apps: { app: string; minutes: number }[]): number =>
  apps.reduce((sum, a) => sum + (Number.isFinite(a.minutes) && a.minutes > 0 ? a.minutes : 0), 0);

function nameFor(profile?: { displayName?: string } | null): string {
  return profile?.displayName?.trim() || 'IRONMIND User';
}

router.get('/code', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = req.uid;
    let user = await UserOnboarding.findOne({ uid, deletionRequestedAt: null }).select('inviteCode').lean();
    if (!user) {
      return res.status(404).json({ message: 'Complete onboarding first' });
    }

    if (!user.inviteCode) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const candidate = generateCode();
        try {
          const updated = await UserOnboarding.findOneAndUpdate(
            { uid, inviteCode: null },
            { $set: { inviteCode: candidate } },
            { returnDocument: 'after' }
          ).select('inviteCode').lean();
          if (updated?.inviteCode) {
            user = updated;
            break;
          }
          user = await UserOnboarding.findOne({ uid }).select('inviteCode').lean();
          if (user?.inviteCode) break;
        } catch (err: any) {
          if (err?.code !== 11000) throw err;
        }
      }
    }

    return res.status(200).json({ code: user?.inviteCode });
  } catch (error) {
    console.error('Error getting invite code:', error);
    return res.status(500).json({ message: 'Server error while getting invite code' });
  }
});

router.get('/invites', async (req: Request, res: Response): Promise<any> => {
  try {
    return res.status(200).json(await referralProgress(req.uid as string));
  } catch (error) {
    console.error('Error getting invite progress:', error);
    return res.status(500).json({ message: 'Server error while getting invite progress' });
  }
});

router.post('/add', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = req.uid;
    const rawCode = req.body?.code;
    if (typeof rawCode !== 'string' || !rawCode.trim()) return res.status(400).json({ message: 'code is required' });

    const code = rawCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12);
    if (!code) return res.status(400).json({ message: 'code is required' });

    const target = await UserOnboarding.findOne({ inviteCode: code, deletionRequestedAt: null }).select('uid').lean();
    if (!target?.uid) {
      return res.status(404).json({ message: 'No user found with that code' });
    }
    if (target.uid === uid) {
      return res.status(400).json({ message: "That's your own code" });
    }

    const device = deviceHashFor(req);
    await rememberDevice(uid as string, device);
    await attributeReferral(uid as string, target.uid, device);

    const existingAccepted = await FriendRequest.findOne({
      status: 'accepted',
      $or: [{ fromUid: uid, toUid: target.uid }, { fromUid: target.uid, toUid: uid }],
    }).lean();
    if (existingAccepted) {
      return res.status(400).json({ message: 'Already friends' });
    }

    const reverseRequest = await FriendRequest.findOneAndUpdate(
      { fromUid: target.uid, toUid: uid, status: 'pending' },
      { $set: { status: 'accepted' } },
      { returnDocument: 'after' }
    );
    if (reverseRequest) {
      const me = await UserOnboarding.findOne({ uid }).select('displayName').lean();
      sendPush(
        target.uid,
        'Friend request accepted',
        `${nameFor(me)} accepted your request. You are on each other's leaderboard now.`,
        { type: 'friend_accepted' }
      );
      return res.status(200).json({ message: 'Friend added', status: 'accepted' });
    }

    try {
      await FriendRequest.create({ fromUid: uid, toUid: target.uid, status: 'pending' });
    } catch (err: any) {
      if (err?.code === 11000) {
        return res.status(400).json({ message: 'Request already sent' });
      }
      throw err;
    }
    return res.status(201).json({ message: 'Request sent', status: 'pending' });
  } catch (error) {
    console.error('Error adding friend:', error);
    return res.status(500).json({ message: 'Server error while adding friend' });
  }
});

router.get('/requests', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = req.uid;
    const requests = await FriendRequest.find({ toUid: uid, status: 'pending' }).sort({ createdAt: -1 }).lean();
    const fromUids = requests.map((r) => r.fromUid);
    const senders = await UserOnboarding.find({ uid: { $in: fromUids } }).select('uid displayName photoURL').lean();
    const senderMap = new Map(senders.map((s) => [s.uid, s]));

    const result = requests.map((r) => ({
      id: r._id,
      fromUid: r.fromUid,
      displayName: nameFor(senderMap.get(r.fromUid)),
      photoURL: senderMap.get(r.fromUid)?.photoURL ?? null,
      createdAt: r.createdAt,
    }));

    return res.status(200).json(result);
  } catch (error) {
    console.error('Error fetching requests:', error);
    return res.status(500).json({ message: 'Server error while fetching requests' });
  }
});

router.post('/requests/:id/accept', async (req: Request, res: Response): Promise<any> => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid request ID' });
    const request = await FriendRequest.findOneAndUpdate(
      { _id: req.params.id, toUid: req.uid, status: 'pending' },
      { $set: { status: 'accepted' } },
      { returnDocument: 'after' }
    );
    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }

    await FriendRequest.deleteMany({ fromUid: req.uid, toUid: request.fromUid });

    const me = await UserOnboarding.findOne({ uid: req.uid }).select('displayName').lean();
    sendPush(
      request.fromUid,
      'Friend request accepted',
      `${nameFor(me)} accepted your request. You are on each other's leaderboard now.`,
      { type: 'friend_accepted' }
    );

    return res.status(200).json({ message: 'Friend request accepted' });
  } catch (error) {
    console.error('Error accepting request:', error);
    return res.status(500).json({ message: 'Server error while accepting request' });
  }
});

router.post('/requests/:id/reject', async (req: Request, res: Response): Promise<any> => {
  try {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid request ID' });
    const deleted = await FriendRequest.findOneAndDelete({ _id: req.params.id, toUid: req.uid, status: 'pending' });
    if (!deleted) {
      return res.status(404).json({ message: 'Request not found' });
    }
    return res.status(200).json({ message: 'Friend request rejected' });
  } catch (error) {
    console.error('Error rejecting request:', error);
    return res.status(500).json({ message: 'Server error while rejecting request' });
  }
});

router.get('/', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = req.uid;
    if (req.query.date !== undefined && !isValidCalendarDate(req.query.date)) {
      return res.status(400).json({ message: 'Invalid date query param' });
    }

    const accepted = await FriendRequest.find({
      status: 'accepted',
      $or: [{ fromUid: uid }, { toUid: uid }],
    }).select('fromUid toUid').lean();

    const friendUids = Array.from(new Set(accepted.map((r) => (r.fromUid === uid ? r.toUid : r.fromUid))));
    if (friendUids.length === 0) return res.status(200).json([]);

    const today = isValidCalendarDate(req.query.date) ? req.query.date : new Date().toISOString().slice(0, 10);
    const weekStart = shiftDateKey(today, -6);

    const [profiles, stats, screen] = await Promise.all([
      UserOnboarding.find({ uid: { $in: friendUids }, deletionRequestedAt: null })
        .select('uid displayName photoURL targetApps proPlan proExpiresAt verifiedEmail trialEndsAt proSource equippedFrame equippedNameEffect pinnedBadge')
        .lean(),
      UserStats.find({ userId: { $in: friendUids } }).lean(),
      ScreenTime.find({ userId: { $in: friendUids }, date: { $gte: weekStart, $lte: today } }).lean(),
    ]);
    const profileMap = new Map(profiles.map((p) => [p.uid, p]));
    const statsMap = new Map(stats.map((s) => [s.userId, s]));

    const usageFor = (fuid: string) => {
      const tracked = profileMap.get(fuid)?.targetApps ?? [];
      const days = screen.filter((r) => r.userId === fuid);
      const todayRec = days.find((r) => r.date === today);
      const hasTodayData = Boolean(todayRec);
      const todayMinutes = hasTodayData ? totalMinutes(todayRec!.apps) : null;
      const withData = days.map((r) => totalMinutes(r.apps));
      return {
        trackedApps: tracked,
        hasTodayData,
        todayMinutes: todayMinutes ?? 0,
        todayMinutesExact: todayMinutes,
        weekAvgMinutes: withData.length ? withData.reduce((a, b) => a + b, 0) / withData.length : 0,
      };
    };

    const result = friendUids
      .filter((fuid) => profileMap.has(fuid))
      .map((fuid) => {
        const profile = profileMap.get(fuid)!;
        const st = statsMap.get(fuid);
        return {
          ...usageFor(fuid),
          uid: fuid,
          displayName: nameFor(profile),
          photoURL: profile.photoURL ?? null,
          currentStreak: st?.currentStreak ?? 0,
          longestStreak: st?.longestStreak ?? 0,
          totalChallenges: st?.totalChallenges ?? 0,
          level: st?.level ?? 1,
          successCount: st?.successCount ?? 0,
          bestReactionTime: st?.bestReactionTime ?? 0,
          currentXP: st?.currentXP ?? 0,
          isPro: isProActive(profile),
          isOwner: isOwner(profile.verifiedEmail),
          frame: profile.equippedFrame ?? null,
          nameEffect: profile.equippedNameEffect ?? null,
          pinnedBadge: profile.pinnedBadge ?? null,
        };
      })
      .sort((a, b) => {
        if (a.hasTodayData !== b.hasTodayData) return a.hasTodayData ? -1 : 1;
        return a.todayMinutes - b.todayMinutes || b.currentStreak - a.currentStreak;
      });

    return res.status(200).json(result);
  } catch (error) {
    console.error('Error fetching friends:', error);
    return res.status(500).json({ message: 'Server error while fetching friends' });
  }
});

router.delete('/:uid', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = req.uid;
    const otherUid = req.params.uid;
    await FriendRequest.deleteMany({
      status: 'accepted',
      $or: [{ fromUid: uid, toUid: otherUid }, { fromUid: otherUid, toUid: uid }],
    });
    return res.status(200).json({ message: 'Friend removed' });
  } catch (error) {
    console.error('Error removing friend:', error);
    return res.status(500).json({ message: 'Server error while removing friend' });
  }
});

export default router;
