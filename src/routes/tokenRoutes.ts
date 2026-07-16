import { Router, Request, Response } from 'express';
import { UserOnboarding } from '../models/UserOnboarding';

const router = Router();

router.post('/save-token', async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = req.uid;
    const { pushToken } = req.body;

    if (!pushToken) {
      return res.status(400).json({ message: 'pushToken is required' });
    }

    await UserOnboarding.findOneAndUpdate(
      { uid: userId },
      { $set: { pushToken } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    console.log(`🔑 [API]: Push token saved for user: ${userId}`);

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error saving push token:', error);
    const err = error as any;
    return res.status(500).json({ message: 'Server error while saving push token', detail: err?.message, code: err?.code });
  }
});

export default router;
