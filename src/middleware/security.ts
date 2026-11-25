import { createHash, timingSafeEqual } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { UserOnboarding } from '../models/UserOnboarding';

export const ALLOWED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const MAX_PHOTO_BYTES = 1024 * 1024;

export function detectImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return 'image/png';
  }
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

export function hashSyncToken(token: string): string {
  return createHash('sha256').update(`ironmind-sync:${token}`).digest('hex');
}

export function safeEqualStrings(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const verifySyncToken = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Sync ')) {
    return res.status(401).json({ message: 'Missing sync credentials' });
  }
  const raw = header.slice('Sync '.length).trim();
  const sep = raw.indexOf(':');
  if (sep <= 0 || sep >= raw.length - 1) {
    return res.status(401).json({ message: 'Malformed sync credentials' });
  }
  const uid = raw.slice(0, sep);
  const token = raw.slice(sep + 1);
  if (uid.length > 128 || token.length < 32 || token.length > 128) {
    return res.status(401).json({ message: 'Invalid sync credentials' });
  }
  try {
    const profile = await UserOnboarding.findOne({ uid, deletionRequestedAt: null })
      .select('+usageSyncTokenHash challengeTimeZone targetApps')
      .lean();
    if (!profile?.usageSyncTokenHash || !safeEqualStrings(profile.usageSyncTokenHash, hashSyncToken(token))) {
      return res.status(401).json({ message: 'Invalid or expired sync token' });
    }
    req.uid = uid;
    req.email = null;
    req.verifiedEmail = null;
    return next();
  } catch {
    return res.status(503).json({ message: 'Sync service unavailable' });
  }
};

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many requests, please slow down.' },
});

export const strictActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many attempts, try again in a minute.' },
});

export const publicPhotoLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

export function jsonErrorHandler(err: any, _req: Request, res: Response, next: NextFunction) {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Request payload is too large' });
  }
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ message: 'Invalid JSON payload' });
  }
  console.error('Unhandled request error:', err);
  return res.status(500).json({ message: 'Internal server error' });
}
