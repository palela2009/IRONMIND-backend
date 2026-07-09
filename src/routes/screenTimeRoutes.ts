import { Router, Request, Response } from 'express';
import { ScreenTime } from '../models/ScreenTime';

const router = Router();

router.post('/', async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId, date, apps } = req.body;

    if (!userId || !date || !Array.isArray(apps)) {
      return res.status(400).json({ message: 'userId, date, and apps[] are required' });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: 'date must be in YYYY-MM-DD format' });
    }

    const record = await ScreenTime.findOneAndUpdate(
      { userId, date },
      { userId, date, apps, updatedAt: new Date() },
      { new: true, upsert: true }
    );

    console.log(`📱 [API]: Screen time saved for user: ${userId} | date: ${date} | apps: ${apps.length}`);

    return res.status(200).json(record);
  } catch (error) {
    console.error('Error saving screen time:', error);
    return res.status(500).json({ message: 'Server error while saving screen time' });
  }
});

router.get('/:userId', async (req: Request, res: Response): Promise<any> => {
  try {
    const { userId } = req.params;
    const { date } = req.query;

    if (!date || typeof date !== 'string') {
      return res.status(400).json({ message: 'date query param is required (YYYY-MM-DD)' });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: 'date must be in YYYY-MM-DD format' });
    }

    const record = await ScreenTime.findOne({ userId, date });

    if (!record) {
      return res.status(200).json({ userId, date, apps: [] });
    }

    console.log(`📊 [API]: Screen time fetched for user: ${userId} | date: ${date}`);

    return res.status(200).json(record);
  } catch (error) {
    console.error('Error fetching screen time:', error);
    return res.status(500).json({ message: 'Server error while fetching screen time' });
  }
});

export default router;
