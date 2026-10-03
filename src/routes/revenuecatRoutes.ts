import { Router, Request, Response } from 'express';
import { syncStorePurchase } from '../services/revenuecat';

const router = Router();

router.post('/webhook', async (req: Request, res: Response): Promise<any> => {
  const secret = process.env.REVENUECAT_WEBHOOK_AUTH;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const event = req.body?.event;
  const uid: string | undefined = event?.app_user_id;
  if (!uid || uid.startsWith('$RCAnonymousID')) {
    return res.status(200).json({ ignored: true });
  }

  try {
    const doc = await syncStorePurchase(uid);
    console.log(`🧾 [revenuecat]: ${event.type} for ${uid} → ${doc?.proPlan ?? 'free'}`);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error handling RevenueCat webhook:', error);
    return res.status(500).json({ message: 'Retry later' });
  }
});

export default router;
