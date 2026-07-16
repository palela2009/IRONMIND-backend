import { Router, Request, Response } from 'express';
import { UserOnboarding } from '../models/UserOnboarding';
import { UserStats } from '../models/UserStats';
import { FriendRequest } from '../models/FriendRequest';

const router = Router();

// Excludes 0/O/1/I so codes read back unambiguously when shared as plain text.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(length = 6): string {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

// GET /api/friends/code — get or create my invite code
router.get('/code', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = req.uid;
    const user = await UserOnboarding.findOne({ uid });
    if (!user) {
      return res.status(404).json({ message: 'Complete onboarding first' });
    }

    if (!user.inviteCode) {
      let code = generateCode();
      for (let attempt = 0; attempt < 5; attempt++) {
        const clash = await UserOnboarding.findOne({ inviteCode: code });
        if (!clash) break;
        code = generateCode();
      }
      user.inviteCode = code;
      await user.save();
    }

    return res.status(200).json({ code: user.inviteCode });
  } catch (error) {
    console.error('Error getting invite code:', error);
    return res.status(500).json({ message: 'Server error while getting invite code' });
  }
});

// POST /api/friends/add — { code } → send a request, or auto-accept if they already sent one to me
router.post('/add', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = req.uid;
    const { code } = req.body;
    if (!code) return res.status(400).json({ message: 'code is required' });

    const target = await UserOnboarding.findOne({ inviteCode: String(code).toUpperCase().trim() });
    if (!target?.uid) {
      return res.status(404).json({ message: 'No user found with that code' });
    }
    if (target.uid === uid) {
      return res.status(400).json({ message: "That's your own code" });
    }

    const existingAccepted = await FriendRequest.findOne({
      status: 'accepted',
      $or: [{ fromUid: uid, toUid: target.uid }, { fromUid: target.uid, toUid: uid }],
    });
    if (existingAccepted) {
      return res.status(400).json({ message: 'Already friends' });
    }

    const reverseRequest = await FriendRequest.findOne({ fromUid: target.uid, toUid: uid, status: 'pending' });
    if (reverseRequest) {
      reverseRequest.status = 'accepted';
      await reverseRequest.save();
      return res.status(200).json({ message: 'Friend added', status: 'accepted' });
    }

    const existingPending = await FriendRequest.findOne({ fromUid: uid, toUid: target.uid, status: 'pending' });
    if (existingPending) {
      return res.status(400).json({ message: 'Request already sent' });
    }

    await FriendRequest.create({ fromUid: uid, toUid: target.uid, status: 'pending' });
    return res.status(201).json({ message: 'Request sent', status: 'pending' });
  } catch (error) {
    console.error('Error adding friend:', error);
    return res.status(500).json({ message: 'Server error while adding friend' });
  }
});

// GET /api/friends/requests — incoming pending requests
router.get('/requests', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = req.uid;
    const requests = await FriendRequest.find({ toUid: uid, status: 'pending' }).sort({ createdAt: -1 });
    const fromUids = requests.map((r) => r.fromUid);
    const senders = await UserOnboarding.find({ uid: { $in: fromUids } });
    const senderMap = new Map(senders.map((s) => [s.uid, s]));

    const result = requests.map((r) => ({
      id: r._id,
      fromUid: r.fromUid,
      displayName: senderMap.get(r.fromUid)?.displayName ?? 'Unknown',
      photoURL: senderMap.get(r.fromUid)?.photoURL ?? null,
      createdAt: r.createdAt,
    }));

    return res.status(200).json(result);
  } catch (error) {
    console.error('Error fetching requests:', error);
    return res.status(500).json({ message: 'Server error while fetching requests' });
  }
});

// POST /api/friends/requests/:id/accept
router.post('/requests/:id/accept', async (req: Request, res: Response): Promise<any> => {
  try {
    const request = await FriendRequest.findById(req.params.id);
    if (!request || request.toUid !== req.uid) {
      return res.status(404).json({ message: 'Request not found' });
    }
    request.status = 'accepted';
    await request.save();
    return res.status(200).json({ message: 'Friend request accepted' });
  } catch (error) {
    console.error('Error accepting request:', error);
    return res.status(500).json({ message: 'Server error while accepting request' });
  }
});

// POST /api/friends/requests/:id/reject
router.post('/requests/:id/reject', async (req: Request, res: Response): Promise<any> => {
  try {
    const request = await FriendRequest.findById(req.params.id);
    if (!request || request.toUid !== req.uid) {
      return res.status(404).json({ message: 'Request not found' });
    }
    await request.deleteOne();
    return res.status(200).json({ message: 'Friend request rejected' });
  } catch (error) {
    console.error('Error rejecting request:', error);
    return res.status(500).json({ message: 'Server error while rejecting request' });
  }
});

// GET /api/friends — accepted friends with stats, sorted by current streak
router.get('/', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = req.uid;
    const accepted = await FriendRequest.find({
      status: 'accepted',
      $or: [{ fromUid: uid }, { toUid: uid }],
    });

    const friendUids = accepted.map((r) => (r.fromUid === uid ? r.toUid : r.fromUid));
    if (friendUids.length === 0) return res.status(200).json([]);

    const [profiles, stats] = await Promise.all([
      UserOnboarding.find({ uid: { $in: friendUids } }),
      UserStats.find({ userId: { $in: friendUids } }),
    ]);
    const profileMap = new Map(profiles.map((p) => [p.uid, p]));
    const statsMap = new Map(stats.map((s) => [s.userId, s]));

    const result = friendUids
      .map((fuid) => ({
        uid: fuid,
        displayName: profileMap.get(fuid)?.displayName ?? 'Unknown',
        photoURL: profileMap.get(fuid)?.photoURL ?? null,
        currentStreak: statsMap.get(fuid)?.currentStreak ?? 0,
        longestStreak: statsMap.get(fuid)?.longestStreak ?? 0,
        totalChallenges: statsMap.get(fuid)?.totalChallenges ?? 0,
      }))
      .sort((a, b) => b.currentStreak - a.currentStreak);

    return res.status(200).json(result);
  } catch (error) {
    console.error('Error fetching friends:', error);
    return res.status(500).json({ message: 'Server error while fetching friends' });
  }
});

// DELETE /api/friends/:uid — remove a friend (either direction)
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