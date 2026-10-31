import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { Expo } from 'expo-server-sdk';
import { UserOnboarding } from '../models/UserOnboarding';

const router = Router();

router.post('/save-token', async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = req.uid;
    const { pushToken } = req.body;

    if (typeof pushToken !== 'string' || !Expo.isExpoPushToken(pushToken)) {
      return res.status(400).json({ message: 'pushToken is required' });
    }

    await mongoose.connection.transaction(async (session) => {
      await UserOnboarding.updateMany({ uid: { $ne: userId }, pushToken }, { $set: { pushToken: null } }, { session });
      await UserOnboarding.findOneAndUpdate(
        { uid: userId },
        { $set: { pushToken } },
        { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true, session }
      );
    });

    console.log(`🔑 [API]: Push token saved for user: ${userId}`);

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error saving push token:', error);
    const err = error as any;
    return res.status(500).json({ message: 'Server error while saving push token', detail: err?.message, code: err?.code });
  }
});

router.delete('/save-token', async (req: Request, res: Response) => {
  try {
    await UserOnboarding.updateOne({ uid: req.uid, pushToken: req.body?.pushToken }, { $set: { pushToken: null } });
    res.json({ success: true });
  } catch { res.status(503).json({ message: 'Could not unregister notifications' }); }
});

export default router;
