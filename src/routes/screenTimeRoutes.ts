import { Router, Request, Response } from 'express';
import { ScreenTime } from '../models/ScreenTime';
import { UserOnboarding } from '../models/UserOnboarding';
import { challengeDay } from '../services/challengeTime';

const router = Router();

export function isValidCalendarDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isDateWithinWindow(dateKey: string, pastDays = 95, futureDays = 2): boolean {
  const [y, m, d] = dateKey.split('-').map(Number);
  const ts = Date.UTC(y, m - 1, d);
  const now = Date.now();
  return ts >= now - pastDays * 86400000 && ts <= now + futureDays * 86400000;
}

export function sanitizeScreenTimeApps(raw: unknown): { app: string; minutes: number }[] | null {
  if (!Array.isArray(raw) || raw.length > 100) return null;
  const map = new Map<string, number>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const app = typeof (item as any).app === 'string' ? (item as any).app.trim() : '';
    const minutes = (item as any).minutes;
    if (!app || app.length > 80 || typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
      return null;
    }
    map.set(app, Math.min(1440, (map.get(app) ?? 0) + minutes));
  }
  return Array.from(map.entries()).map(([app, minutes]) => ({ app, minutes }));
}

router.post('/', async (req: Request, res: Response): Promise<any> => {
  try {
    const userId = req.uid;
    const { date, apps } = req.body ?? {};

    if (!isValidCalendarDate(date) || !isDateWithinWindow(date)) {
      return res.status(400).json({ message: 'A valid recent date (YYYY-MM-DD) is required' });
    }
    const cleanApps = sanitizeScreenTimeApps(apps);
    if (!cleanApps) {
      return res.status(400).json({ message: 'apps[] must contain valid app names and minutes between 0 and 1440' });
    }

    const record = await ScreenTime.findOneAndUpdate(
      { userId, date },
      { $set: { userId, date, apps: cleanApps, updatedAt: new Date() } },
      { returnDocument: 'after', upsert: true, runValidators: true }
    );

    return res.status(200).json(record);
  } catch (error) {
    console.error('Error saving screen time:', error);
    return res.status(500).json({ message: 'Server error while saving screen time' });
  }
});

router.get('/history', async (req: Request, res: Response): Promise<any> => {
  try {
    const parsedDays = Number(req.query.days);
    const days = Number.isFinite(parsedDays) && parsedDays > 0 ? Math.min(Math.max(Math.trunc(parsedDays), 1), 90) : 30;
    const profile = await UserOnboarding.findOne({ uid: req.uid }).select('challengeTimeZone').lean();
    const tz = profile?.challengeTimeZone ?? 'UTC';
    const todayKey = challengeDay(Date.now(), tz);
    const [y, m, d] = todayKey.split('-').map(Number);
    const sinceDt = new Date(Date.UTC(y, m - 1, d - (days - 1)));
    const sinceKey = sinceDt.toISOString().slice(0, 10);

    const records = await ScreenTime.find({
      userId: req.uid,
      date: { $gte: sinceKey, $lte: todayKey },
    }).sort({ date: 1 }).lean();

    const result = records.map((r) => ({
      date: r.date,
      total: r.apps.reduce((sum, a) => sum + a.minutes, 0),
      apps: r.apps,
    }));

    return res.status(200).json(result);
  } catch (error) {
    console.error('Error fetching screen time history:', error);
    return res.status(500).json({ message: 'Server error while fetching history' });
  }
});

router.get('/:userId', async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId } = req.params;
    const { date } = req.query;

    if (userId !== req.uid) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (!isValidCalendarDate(date)) {
      return res.status(400).json({ message: 'Valid date query param is required (YYYY-MM-DD)' });
    }

    const record = await ScreenTime.findOne({ userId, date }).lean();

    if (!record) {
      return res.status(200).json({ userId, date, apps: [] });
    }

    return res.status(200).json(record);
  } catch (error) {
    console.error('Error fetching screen time:', error);
    return res.status(500).json({ message: 'Server error while fetching screen time' });
  }
});

export default router;
