import { createHash } from 'crypto';
import { Request } from 'express';
import { UserOnboarding } from '../models/UserOnboarding';

export const deviceHashFor = (req: Request): string | null => {
  const raw = req.headers['x-device-id'];
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!id || typeof id !== 'string' || id.length > 128) return null;
  return createHash('sha256').update(`ironmind:${id}`).digest('hex');
};

export async function rememberDevice(uid: string, hash: string | null): Promise<void> {
  if (!hash) return;
  await UserOnboarding.updateOne({ uid }, { $addToSet: { deviceIds: hash } });
}
