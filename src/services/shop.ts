import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { UserOnboarding } from '../models/UserOnboarding';
import { ShopPurchase } from '../models/ShopPurchase';
import { isProActive } from '../routes/proRoutes';
import { FRAME_PRICES, NAME_EFFECT_PRICES, PRO_WEEK_PRICE, PRO_WEEK_DAYS } from '../constants/cosmetics';

export const SHOP_PRICES = { freeze: 100, reclaim: 200, theme: 200 };

export class ShopError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function buyShopItem(uid: string, body: any) {
  const { requestId, item, themeId, cosmeticId } = body ?? {};
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new ShopError(400, 'A purchase request ID is required. Update IRONMIND to purchase.');
  const fingerprint = createHash('sha256').update(JSON.stringify([item, themeId ?? null, cosmeticId ?? null])).digest('hex');
  return mongoose.connection.transaction(async (session) => {
    const doc = await UserOnboarding.findOneAndUpdate({ uid, deletionRequestedAt: null }, { $inc: { progressRevision: 1 } }, { returnDocument: 'after', session });
    if (!doc) throw new ShopError(409, 'Account unavailable');
    const receipt = await ShopPurchase.findById(`${uid}:${requestId}`).session(session);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new ShopError(409, 'This request ID belongs to a different purchase');
      return doc;
    }
    let price: number;
    if (item === 'freeze') {
      price = SHOP_PRICES.freeze;
      doc.streakFreezes += 1;
    } else if (item === 'theme') {
      if (typeof themeId !== 'string' || !['cyberpunk', 'ice', 'blood', 'ember', 'matrix'].includes(themeId)) throw new ShopError(400, 'Invalid theme');
      price = doc.unlockedThemes.includes(themeId) ? 0 : SHOP_PRICES.theme;
      if (price) doc.unlockedThemes.push(themeId);
    } else if (item === 'frame' || item === 'nameEffect') {
      const prices = item === 'frame' ? FRAME_PRICES : NAME_EFFECT_PRICES;
      if (typeof cosmeticId !== 'string' || !Object.hasOwn(prices, cosmeticId)) throw new ShopError(400, 'Unknown cosmetic');
      const owned = item === 'frame' ? doc.ownedFrames : doc.ownedNameEffects;
      price = owned.includes(cosmeticId) ? 0 : prices[cosmeticId];
      if (price) {
        owned.push(cosmeticId);
        if (item === 'frame') doc.equippedFrame = cosmeticId;
        else doc.equippedNameEffect = cosmeticId;
      }
    } else if (item === 'proWeek') {
      if (isProActive(doc)) throw new ShopError(409, 'You already have Pro');
      const month = new Date().toISOString().slice(0, 7);
      if (doc.proFromCoinsAt?.toISOString().slice(0, 7) === month) throw new ShopError(409, 'Pro can be bought with coins once a month');
      price = PRO_WEEK_PRICE;
      doc.proPlan = 'monthly';
      doc.proExpiresAt = new Date(Date.now() + PRO_WEEK_DAYS * 86400000);
      doc.proFromCoinsAt = new Date();
      doc.proSource = 'coins';
    } else throw new ShopError(400, 'Unknown item');
    if (doc.coins < price) throw new ShopError(409, 'Not enough coins');
    doc.coins -= price;
    await doc.save({ session });
    await ShopPurchase.create([{ _id: `${uid}:${requestId}`, userId: uid, fingerprint }], { session });
    return doc;
  });
}
