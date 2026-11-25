import { Router, Request, Response } from 'express';
import { isValidObjectId } from 'mongoose';
import { Duel } from '../models/Duel';
import { ScreenTime } from '../models/ScreenTime';
import { isValidCalendarDate, isDateWithinWindow, sanitizeScreenTimeApps } from './screenTimeRoutes';
import { settleAndNotify } from './duelRoutes';
import { DUEL_GRACE_MS } from '../services/duelTransactions';

const router = Router();

router.get('/duels', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = req.uid;
    const cutoff = new Date(Date.now() - DUEL_GRACE_MS);
    const active = await Duel.find({
      status: 'active',
      $or: [{ fromUid: uid }, { toUid: uid }],
    })
      .select('_id app apps startAt endAt fromUid toUid fromReportedAt toReportedAt')
      .lean();

    const duels = [];
    for (const d of active) {
      if (d.endAt && d.endAt.getTime() <= cutoff.getTime()) {
        try { await settleAndNotify(String(d._id)); } catch {}
        continue;
      }
      const isFrom = d.fromUid === uid;
      const reportedAt = isFrom ? d.fromReportedAt : d.toReportedAt;
      if (d.endAt && reportedAt && reportedAt >= d.endAt) continue;
      duels.push({
        id: String(d._id),
        apps: d.apps?.length ? d.apps : [d.app],
        startAt: d.startAt ? d.startAt.getTime() : null,
        endAt: d.endAt ? d.endAt.getTime() : null,
      });
    }

    return res.status(200).json({ duels });
  } catch (error) {
    console.error('Background duel fetch failed:', error);
    return res.status(500).json({ message: 'Sync failed' });
  }
});

router.post('/usage', async (req: Request, res: Response): Promise<any> => {
  try {
    const uid = req.uid;
    const { date, apps, duelReports } = req.body ?? {};
    let screenSaved = false;
    let duelsSynced = 0;

    if (date !== undefined && apps !== undefined) {
      if (!isValidCalendarDate(date) || !isDateWithinWindow(date)) {
        return res.status(400).json({ message: 'Invalid date' });
      }
      const cleanApps = sanitizeScreenTimeApps(apps);
      if (!cleanApps) {
        return res.status(400).json({ message: 'Invalid apps payload' });
      }
      await ScreenTime.findOneAndUpdate(
        { userId: uid, date },
        { $set: { userId: uid, date, apps: cleanApps, updatedAt: new Date() } },
        { returnDocument: 'after', upsert: true, runValidators: true }
      );
      screenSaved = true;
    }

    if (Array.isArray(duelReports)) {
      for (const report of duelReports.slice(0, 10)) {
        const id = typeof report?.id === 'string' ? report.id : '';
        const minutes = report?.minutes;
        if (!isValidObjectId(id) || typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
          continue;
        }
        const duel = await Duel.findById(id).select('fromUid toUid status endAt').lean();
        if (!duel || duel.status !== 'active' || (duel.fromUid !== uid && duel.toUid !== uid)) continue;
        if (duel.endAt && Date.now() >= duel.endAt.getTime() + DUEL_GRACE_MS) {
          try { await settleAndNotify(id); } catch {}
          continue;
        }
        const side = duel.fromUid === uid ? 'from' : 'to';
        const updated = await Duel.findOneAndUpdate(
          { _id: duel._id, status: 'active' },
          { $max: { [side + 'Minutes']: minutes }, $set: { [side + 'ReportedAt']: new Date() } },
          { returnDocument: 'after' }
        );
        if (updated) {
          duelsSynced += 1;
          try { await settleAndNotify(id); } catch {}
        }
      }
    }

    return res.status(200).json({ ok: true, screenSaved, duelsSynced });
  } catch (error) {
    console.error('Background usage sync failed:', error);
    return res.status(500).json({ message: 'Sync failed' });
  }
});

export default router;
