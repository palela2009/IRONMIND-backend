import { Router, Request, Response } from 'express';
import { UserOnboarding } from '../models/UserOnboarding';
import { ALLOWED_PHOTO_TYPES, detectImageMime } from '../middleware/security';

const router = Router();

router.get('/photo/:uid', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = String(req.params.uid ?? '');
    if (!uid || uid.length > 128) return res.status(400).end();

    const doc = await UserOnboarding.findOne({ uid, deletionRequestedAt: null })
      .select('+photoData photoContentType')
      .lean();
    if (!doc?.photoData) {
      return res.status(404).end();
    }

    const buf = Buffer.isBuffer(doc.photoData) ? doc.photoData : Buffer.from((doc.photoData as any).buffer ?? doc.photoData);
    const detected = detectImageMime(buf);
    const contentType = detected && ALLOWED_PHOTO_TYPES.has(detected) ? detected : null;
    if (!contentType) {
      return res.status(404).end();
    }

    res.set('Content-Type', contentType);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('Content-Disposition', 'inline');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.status(200).send(buf);
  } catch (error) {
    console.error('Error serving photo:', error);
    return res.status(500).end();
  }
});

export default router;
