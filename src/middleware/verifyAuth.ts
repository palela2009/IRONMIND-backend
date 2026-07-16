import { Request, Response, NextFunction } from 'express';
import admin from '../config/firebaseAdmin';

declare global {
  namespace Express {
    interface Request {
      uid: string;
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
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.uid = decoded.uid;
    next();
  } catch (error) {
    console.error('Auth token verification failed:', error);
    return res.status(401).json({ message: 'Invalid or expired auth token' });
  }
};