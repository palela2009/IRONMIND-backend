import { Router, Request, Response } from 'express';
import { ChallengeResult } from '../models/ChallengeResult';
import { sendChallengeNotification } from '../services/notifications';

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

router.post('/result', async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = req.uid;
    const { targetApp, elapsedTime, wasSuccessful, timestamp } = req.body;

    if (!targetApp || elapsedTime == null || wasSuccessful == null || !timestamp) {
      return res.status(400).json({ message: 'targetApp, elapsedTime, wasSuccessful, and timestamp are required' });
    }

    const result = await ChallengeResult.create({ userId, targetApp, elapsedTime, wasSuccessful, timestamp });

    console.log(`📲 [API]: Challenge result saved for user: ${userId} | app: ${targetApp} | success: ${wasSuccessful}`);

    return res.status(201).json(result);
  } catch (error) {
    console.error('Error saving challenge result:', error);
    return res.status(500).json({ message: 'Server error while saving challenge result' });
  }
});

export default router;
