import { Request, Response, NextFunction } from 'express';
import admin from '../config/firebaseAdmin';
import { UserOnboarding } from '../models/UserOnboarding';
import { normalizedEmail, verifiedEmailFrom } from '../services/identity';

declare global {
  namespace Express {
    interface Request {
      uid: string;
      email: string | null;
      verifiedEmail: string | null;
    }
  }
}

export const verifyAuth = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Missing or malformed Authorization header' });
  }

  const idToken = authHeader.slice('Bearer '.length);
  const pathOnly = req.originalUrl.split('?')[0];
  const deleting = req.method === 'DELETE' && /^\/(?:api\/)?user\/account\/?$/.test(pathOnly);

  try {
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken, true);
    } catch (error) {
      if (!deleting || (error as { code?: string }).code !== 'auth/user-not-found') throw error;
      decoded = await admin.auth().verifyIdToken(idToken);
    }
    req.uid = decoded.uid;
    req.email = normalizedEmail(decoded.email);
    req.verifiedEmail = verifiedEmailFrom(decoded);
  } catch (error) {
    console.error('Auth token verification failed:', error);
    return res.status(401).json({ message: 'Invalid or expired auth token' });
  }

  try {
    const profile = await UserOnboarding.findOne({ uid: req.uid })
      .select('email verifiedEmail deletionRequestedAt')
      .lean();
    if (profile?.deletionRequestedAt && !deleting) {
      return res.status(409).json({ message: 'Finish deleting this account before continuing' });
    }
    if (profile && (profile.email !== req.email || profile.verifiedEmail !== req.verifiedEmail)) {
      await UserOnboarding.updateOne(
        { uid: req.uid },
        { $set: { email: req.email, verifiedEmail: req.verifiedEmail } }
      );
    }
    next();
  } catch {
    return res.status(503).json({ message: 'Account service unavailable. Please retry.' });
  }
};
