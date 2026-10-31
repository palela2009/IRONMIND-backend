import { Router, Request, Response } from 'express';
import { ChallengeResult } from '../models/ChallengeResult';
import { sendChallengeNotification } from '../services/notifications';
import { recordResult, reclaimResult, progressFor, ChallengeError } from '../services/challenges';
import { notifyOvertakenFriends } from './statsRoutes';
const router = Router();

router.post('/notify', async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = req.uid;
    const { targetApp, test } = req.body;

    await sendChallengeNotification(userId, targetApp, !!test);

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error sending challenge notification:', error);
    return res.status(500).json({ message: 'Server error while sending challenge notification' });
  }
});

router.get('/results', async (req: Request, res: Response): Promise<any> => {
  try {
    const results = await ChallengeResult.find({ userId: req.uid })
      .sort({ timestamp: -1 })
      .limit(200);

    return res.status(200).json(
      results.map((r) => ({
        id: r.eventId ?? String(r._id),
        targetApp: r.targetApp,
        elapsedTime: r.elapsedTime,
        timestamp: r.timestamp,
        wasSuccessful: r.wasSuccessful,
      }))
    );
  } catch (error) {
    console.error('Error fetching challenge results:', error);
    return res.status(500).json({ message: 'Server error while fetching challenge results' });
  }
});

router.get('/progress', async (req: Request, res: Response) => {
  try { res.json(await progressFor(req.uid)); }
  catch { res.status(503).json({ message: 'Progress is temporarily unavailable' }); }
});

router.post('/result', async (req: Request, res: Response) => {
  try {
    const result = await recordResult(req.uid, req.body);
    if (!result.duplicate && result.beforeStreak !== undefined && result.afterStreak !== undefined) void notifyOvertakenFriends(req.uid, result.beforeStreak, result.afterStreak).catch(() => {});
    res.json({ ...result, ...(await progressFor(req.uid)) });
  } catch (error) {
    const status = error instanceof ChallengeError ? error.status : 503;
    res.status(status).json({ message: error instanceof ChallengeError ? error.message : 'Progress could not sync. Please retry.' });
  }
});

router.post('/reclaim', async (req: Request, res: Response) => {
  try {
    await reclaimResult(req.uid, req.body?.eventId);
    res.json(await progressFor(req.uid));
  } catch (error) {
    res.status(error instanceof ChallengeError ? error.status : 503).json({ message: error instanceof ChallengeError ? error.message : 'Reclaim could not sync. Please retry.' });
  }
});

export default router;
