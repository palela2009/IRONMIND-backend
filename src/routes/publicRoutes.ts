import { Router, Request, Response } from 'express';
import { UserOnboarding } from '../models/UserOnboarding';

const router = Router();

router.get('/photo/:uid', async (req: Request, res: Response): Promise<any> => {
  try {
    const doc = await UserOnboarding.findOne({ uid: req.params.uid }).select('+photoData photoContentType');
    if (!doc?.photoData) {
      return res.status(404).end();
    }

    res.set('Content-Type', doc.photoContentType || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.status(200).send(doc.photoData);
  } catch (error) {
    console.error('Error serving photo:', error);
    return res.status(500).end();
  }
});

export default router;
