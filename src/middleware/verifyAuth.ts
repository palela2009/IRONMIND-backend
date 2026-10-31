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

  try {
    const decoded = await admin.auth().verifyIdToken(idToken, true);
    req.uid = decoded.uid;
    req.email = normalizedEmail(decoded.email);
    req.verifiedEmail = verifiedEmailFrom(decoded);

  } catch (error) {
    console.error('Auth token verification failed:', error);
    return res.status(401).json({ message: 'Invalid or expired auth token' });
  }
  try {
    await UserOnboarding.updateOne({ uid: req.uid }, { $set: { email: req.email, verifiedEmail: req.verifiedEmail } });
    next();
  } catch {
    return res.status(503).json({ message: 'Account service unavailable. Please retry.' });
  }
};