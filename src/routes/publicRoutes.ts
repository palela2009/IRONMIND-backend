import { Router, Request, Response } from 'express';
import { UserOnboarding } from '../models/UserOnboarding';

const router = Router();

// GET /api/public/photo/:uid — intentionally has no auth check. A profile photo needs to
// be viewable by anyone who can see the account elsewhere in the app (e.g. a friend on the
// leaderboard), and React Native's <Image> can't easily attach a custom Authorization
// header to every place an avatar is rendered — so this is public by design, the same way
// a Google account's own photoURL is already a public CDN link requiring no auth.
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
