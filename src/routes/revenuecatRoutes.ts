import { Router, Request, Response } from 'express';
import { syncStorePurchase } from '../services/revenuecat';
import { safeEqualStrings } from '../middleware/security';

const router = Router();

router.post('/webhook', async (req: Request, res: Response): Promise<any> => {
  const secret = process.env.REVENUECAT_WEBHOOK_AUTH;
  const auth = req.headers.authorization;
  if (!secret || typeof auth !== 'string' || !safeEqualStrings(auth, `Bearer ${secret}`)) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  try {
    const event = req.body?.event;
    if (event?.type === 'TRANSFER') {
      const fromIds: unknown[] = Array.isArray(event.transferred_from) ? event.transferred_from : [];
      const toIds: unknown[] = Array.isArray(event.transferred_to) ? event.transferred_to : [];
      const allIds = Array.from(new Set([...fromIds, ...toIds]))
        .filter((id): id is string => typeof id === 'string' && id.length > 0 && !id.startsWith('$RCAnonymousID'));
      for (const id of allIds) {
        await syncStorePurchase(id);
      }
      return res.status(200).json({ ok: true, transferred: allIds.length });
    }

    const uid = event?.app_user_id;
    if (typeof uid !== 'string' || !uid || uid.startsWith('$RCAnonymousID')) {
      return res.status(200).json({ ignored: true });
    }

    await syncStorePurchase(uid);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Error handling RevenueCat webhook:', error);
    return res.status(500).json({ message: 'Retry later' });
  }
});

export default router;
