const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server-core');
const { UserOnboarding } = require('../dist/models/UserOnboarding');
const { UserStats } = require('../dist/models/UserStats');
const { ChallengeResult } = require('../dist/models/ChallengeResult');
const { ChallengeDay } = require('../dist/models/ChallengeDay');
const { Duel } = require('../dist/models/Duel');
const { ShopPurchase } = require('../dist/models/ShopPurchase');
const { PRO_WEEK_PRICE } = require('../dist/constants/cosmetics');
const { challengeDay } = require('../dist/services/challengeTime');
const { recordResult, reclaimResult } = require('../dist/services/challenges');
const { acceptDuel, cancelDuel, settleDuel } = require('../dist/services/duelTransactions');
const { verifiedEmailFrom, isOwner } = require('../dist/services/identity');
const { isProActive } = require('../dist/routes/proRoutes');
const express = require('express');
let claims = { uid: 'a', email: 'user@example.com', email_verified: true };
let deleteFailure = false;
let revoked = false;
const deletedUsers = new Set();
const adminPath = require.resolve('../dist/config/firebaseAdmin');
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: { __esModule: true, default: { auth: () => ({ verifyIdToken: async (_token, checkRevoked) => { if (checkRevoked && revoked) throw Object.assign(new Error('Revoked'), { code: 'auth/id-token-revoked' }); if (checkRevoked && deletedUsers.has(claims.uid)) throw Object.assign(new Error('Deleted user'), { code: 'auth/user-not-found' }); return claims; }, deleteUser: async (uid) => { if (deleteFailure) throw new Error('Temporary Firebase failure'); if (deletedUsers.has(uid)) throw Object.assign(new Error('Not found'), { code: 'auth/user-not-found' }); deletedUsers.add(uid); } }) } } };
const { verifyAuth } = require('../dist/middleware/verifyAuth');
const userRoutes = require('../dist/routes/userRoutes').default;
const proRoutes = require('../dist/routes/proRoutes').default;
const coinRoutes = require('../dist/routes/coinRoutes').default;

let db;
let server;
let origin;
before(async () => {
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '7.0.24' } });
  await mongoose.connect(db.getUri());
  await Promise.all([UserOnboarding.init(), UserStats.init(), ChallengeResult.init(), ChallengeDay.init(), Duel.init(), ShopPurchase.init()]);
  const app = express();
  app.use(express.json());
  app.use('/user', verifyAuth, userRoutes);
  app.use('/pro', verifyAuth, proRoutes);
  app.use('/coins', verifyAuth, coinRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); await mongoose.disconnect(); if (db) await db.stop(); });
beforeEach(async () => { deleteFailure = false; revoked = false; deletedUsers.clear(); claims = { uid: 'a', email: 'user@example.com', email_verified: true }; await Promise.all([UserOnboarding.deleteMany({}), UserStats.deleteMany({}), ChallengeResult.deleteMany({}), ChallengeDay.deleteMany({}), Duel.deleteMany({}), ShopPurchase.deleteMany({})]); });

const account = (uid, extra = {}) => UserOnboarding.create({ uid, targetApps: ['YouTube'], createdAt: new Date(Date.now() - 86400000 * 30), ...extra });
const result = (index, success = true) => ({ eventId: `event_${String(index).padStart(8, '0')}`, targetApp: 'YouTube', elapsedTime: success ? 2 : 20, wasSuccessful: success, timestamp: Date.now() - 3600000 + index * 1000 });
const request = (path, body, method = 'POST') => fetch(origin + path, { method, headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

test('profile requests cannot replace verified identity with an owner email', async () => {
  process.env.OWNER_EMAILS = 'owner@example.com';
  claims = { uid: 'a', email: 'user@example.com', email_verified: true };
  await account('a');
  const response = await request('/user/onboarding', { email: 'owner@example.com', verifiedEmail: 'owner@example.com' });
  assert.equal(response.status, 200);
  const profile = await UserOnboarding.findOne({ uid: 'a' });
  assert.equal(profile.email, 'user@example.com');
  assert.equal(profile.verifiedEmail, 'user@example.com');
  assert.equal((await (await request('/pro', null, 'GET')).json()).isOwner, false);
});

test('direct coin and freeze claims cannot grant rewards', async () => {
  await account('a');
  assert.equal((await request('/coins/award', { reason: 'perfect_day' })).status, 403);
  assert.equal((await request('/pro/freeze/grant', {})).status, 403);
  const profile = await UserOnboarding.findOne({ uid: 'a' });
  assert.equal(profile.coins, 0);
  assert.equal(profile.streakFreezes, 0);
});

test('monthly Pro coin refill is granted once under concurrent refreshes', async () => {
  await account('a', { proPlan: 'monthly', proSource: 'store', proExpiresAt: new Date(Date.now() + 86400000), starterCoinsGrantedAt: new Date() });
  await Promise.all(Array.from({ length: 8 }, () => request('/pro', null, 'GET')));
  const profile = await UserOnboarding.findOne({ uid: 'a' });
  assert.equal(profile.coins, 500);
  assert.equal(profile.streakFreezes, 20);
});

test('owner status requires verified Firebase email, including old owner entitlements', () => {
  process.env.OWNER_EMAILS = ' Owner@example.com ';
  assert.equal(verifiedEmailFrom({ email: 'owner@example.com', email_verified: false }), null);
  assert.equal(isOwner(verifiedEmailFrom({ email: 'OWNER@example.com', email_verified: true })), true);
  assert.equal(isProActive({ email: 'owner@example.com', verifiedEmail: null, proPlan: 'lifetime', proSource: 'owner', trialEndsAt: null, proExpiresAt: null }), false);
});

test('concurrent retries grant one challenge win and one reward', async () => {
  await account('a');
  const event = result(1);
  await Promise.all(Array.from({ length: 12 }, () => recordResult('a', event)));
  assert.equal(await ChallengeResult.countDocuments(), 1);
  assert.equal((await UserStats.findOne({ userId: 'a' })).totalChallenges, 1);
  assert.equal((await UserOnboarding.findOne({ uid: 'a' })).coins, 10);
  await recordResult('a', { ...event, eventId: 'different_id_123' });
  assert.equal((await UserOnboarding.findOne({ uid: 'a' })).coins, 10);
});

test('daily challenges and perfect-day reward have a single shared limit', async () => {
  await account('a', { dailyChallengeLimit: 3 });
  const base = Date.now() - 3600000;
  await Promise.all(Array.from({ length: 12 }, (_, i) => recordResult('a', { ...result(i), timestamp: base + i * 1000 })));
  assert.equal((await UserStats.findOne({ userId: 'a' })).totalChallenges, 3);
  assert.equal((await UserOnboarding.findOne({ uid: 'a' })).coins, 80);
});

test('failed challenge uses one freeze despite retries', async () => {
  await account('a', { streakFreezes: 1 });
  await UserStats.create({ userId: 'a', currentStreak: 4, longestStreak: 4 });
  const event = result(1, false);
  await Promise.all(Array.from({ length: 8 }, () => recordResult('a', event)));
  assert.equal((await UserOnboarding.findOne({ uid: 'a' })).streakFreezes, 0);
  assert.equal((await UserStats.findOne({ userId: 'a' })).currentStreak, 4);
});

test('reclaim charges once and restores the recorded lost streak', async () => {
  await account('a', { coins: 500 });
  await UserStats.create({ userId: 'a', currentStreak: 7, longestStreak: 7 });
  const event = result(1, false);
  await recordResult('a', event);
  await Promise.all(Array.from({ length: 8 }, () => reclaimResult('a', event.eventId)));
  assert.equal((await UserOnboarding.findOne({ uid: 'a' })).coins, 300);
  assert.equal((await UserStats.findOne({ userId: 'a' })).currentStreak, 7);
});

test('concurrent duel acceptance and cancellation charge and refund exactly once', async () => {
  await account('a', { coins: 500 }); await account('b', { coins: 500 });
  const duel = await Duel.create({ fromUid: 'a', toUid: 'b', app: 'YouTube', stake: 100 });
  await Promise.all(Array.from({ length: 8 }, () => acceptDuel(String(duel._id), 'b')));
  assert.equal((await UserOnboarding.findOne({ uid: 'a' })).coins, 400);
  assert.equal((await UserOnboarding.findOne({ uid: 'b' })).coins, 400);
  await Promise.all(Array.from({ length: 8 }, () => cancelDuel(String(duel._id), 'a')));
  assert.equal((await UserOnboarding.findOne({ uid: 'a' })).coins, 500);
  assert.equal((await UserOnboarding.findOne({ uid: 'b' })).coins, 500);
});

test('insufficient opponent balance rolls back challenger charge', async () => {
  await account('a', { coins: 500 }); await account('b', { coins: 0 });
  const duel = await Duel.create({ fromUid: 'a', toUid: 'b', app: 'YouTube', stake: 100 });
  await assert.rejects(() => acceptDuel(String(duel._id), 'b'));
  assert.equal((await UserOnboarding.findOne({ uid: 'a' })).coins, 500);
  assert.equal((await Duel.findById(duel._id)).status, 'pending');
});

test('concurrent settlement pays one pot, and stale interim data cannot win', async () => {
  await account('a', { coins: 400 }); await account('b', { coins: 400 });
  const end = new Date(Date.now() - 1000);
  const duel = await Duel.create({ fromUid: 'a', toUid: 'b', app: 'YouTube', stake: 100, status: 'active', startAt: new Date(end - 86400000), endAt: end, fromMinutes: 5, toMinutes: 10, fromReportedAt: new Date(), toReportedAt: new Date(end - 1000) });
  assert.equal(await settleDuel(String(duel._id)), null);
  await Duel.updateOne({ _id: duel._id }, { $set: { toReportedAt: new Date() } });
  await Promise.all(Array.from({ length: 8 }, () => settleDuel(String(duel._id))));
  assert.equal((await UserOnboarding.findOne({ uid: 'a' })).coins, 600);
  assert.equal((await UserOnboarding.findOne({ uid: 'b' })).coins, 400);
});

test('missing final usage refunds once after the grace period', async () => {
  await account('a', { coins: 400 }); await account('b', { coins: 400 });
  const duel = await Duel.create({ fromUid: 'a', toUid: 'b', app: 'YouTube', stake: 100, status: 'active', endAt: new Date(Date.now() - 700000) });
  await Promise.all(Array.from({ length: 8 }, () => settleDuel(String(duel._id))));
  assert.equal((await Duel.findById(duel._id)).status, 'void');
  assert.equal((await UserOnboarding.findOne({ uid: 'a' })).coins, 500);
});

test('concurrent cosmetic purchases debit once even with different request IDs', async () => {
  await account('a', { coins: 1000 });
  const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => request('/coins/buy', { item: 'theme', themeId: 'ice', requestId: `purchase_theme_${i}` })));
  assert.ok(responses.every((res) => res.status === 200));
  const profile = await UserOnboarding.findOne({ uid: 'a' });
  assert.equal(profile.coins, 800);
  assert.deepEqual([...profile.unlockedThemes], ['ice']);
});

test('consumable retries reuse a receipt and reject reuse for another item', async () => {
  await account('a', { coins: 1000 });
  const body = { item: 'freeze', requestId: 'same_purchase_123' };
  await Promise.all(Array.from({ length: 8 }, () => request('/coins/buy', body)));
  assert.equal((await request('/coins/buy', body)).status, 200);
  assert.equal((await request('/coins/buy', { ...body, item: 'theme', themeId: 'ice' })).status, 409);
  const profile = await UserOnboarding.findOne({ uid: 'a' });
  assert.equal(profile.coins, 900);
  assert.equal(profile.streakFreezes, 1);
  assert.equal(await ShopPurchase.countDocuments(), 1);
});

test('concurrent monthly Pro purchases debit once', async () => {
  await account('a', { coins: 10000 });
  await Promise.all(Array.from({ length: 8 }, (_, i) => request('/coins/buy', { item: 'proWeek', requestId: `purchase_pro_${i}` })));
  assert.equal((await UserOnboarding.findOne({ uid: 'a' })).coins, 10000 - PRO_WEEK_PRICE);
  assert.equal(await ShopPurchase.countDocuments(), 1);
});

test('account deletion refunds opponents once and removes daily and purchase data', async () => {
  await account('a', { coins: 400 }); await account('b', { coins: 400 });
  await Duel.create({ fromUid: 'a', toUid: 'b', app: 'YouTube', stake: 100, status: 'active', startAt: new Date(), endAt: new Date(Date.now() + 86400000) });
  await ChallengeDay.create({ _id: 'a:day', userId: 'a', limit: 5 });
  await ShopPurchase.create({ _id: 'a:receipt', userId: 'a', fingerprint: 'test' });
  const responses = await Promise.all(Array.from({ length: 6 }, () => request('/user/account', null, 'DELETE')));
  assert.ok(responses.every((res) => res.status === 200));
  assert.equal((await UserOnboarding.findOne({ uid: 'b' })).coins, 500);
  assert.equal(await UserOnboarding.countDocuments({ uid: 'a' }), 0);
  assert.equal(await ChallengeDay.countDocuments({ userId: 'a' }), 0);
  assert.equal(await ShopPurchase.countDocuments({ userId: 'a' }), 0);
  assert.equal(await Duel.countDocuments(), 0);
});

test('Firebase deletion failure stays retryable without another refund', async () => {
  await account('a'); await account('b', { coins: 400 });
  await Duel.create({ fromUid: 'a', toUid: 'b', app: 'YouTube', stake: 100, status: 'active' });
  deleteFailure = true;
  assert.equal((await request('/user/account', null, 'DELETE')).status, 503);
  assert.equal((await request('/pro', null, 'GET')).status, 409);
  assert.equal((await UserOnboarding.findOne({ uid: 'b' })).coins, 500);
  deleteFailure = false;
  assert.equal((await request('/user/account', null, 'DELETE')).status, 200);
  assert.equal((await request('/user/account', null, 'DELETE')).status, 200);
  assert.equal((await UserOnboarding.findOne({ uid: 'b' })).coins, 500);
});

test('acceptance racing account deletion cannot strand an opponent entry fee', async () => {
  await account('a', { coins: 500 }); await account('b', { coins: 500 });
  const duel = await Duel.create({ fromUid: 'a', toUid: 'b', app: 'YouTube', stake: 100 });
  await Promise.allSettled([acceptDuel(String(duel._id), 'b'), request('/user/account', null, 'DELETE')]);
  assert.equal((await UserOnboarding.findOne({ uid: 'b' })).coins, 500);
  assert.equal(await Duel.countDocuments(), 0);
});

test('account-local midnight starts a new allowance before UTC midnight', async () => {
  await account('a', { dailyChallengeLimit: 3, challengeTimeZone: 'Asia/Tbilisi' });
  const date = new Date(); date.setUTCHours(0, 0, 0, 0);
  const midnight = date.getTime() - 3 * 86400000;
  for (let i = 0; i < 3; i++) await recordResult('a', { ...result(i), timestamp: midnight + 19 * 3600000 + i * 1000 });
  const afterMidnight = midnight + 21 * 3600000;
  const uploaded = await recordResult('a', { ...result(10), timestamp: afterMidnight });
  assert.equal(uploaded.result.counted, true);
  assert.notEqual(challengeDay(midnight + 19 * 3600000, 'Asia/Tbilisi'), challengeDay(afterMidnight, 'Asia/Tbilisi'));
  assert.equal((await UserStats.findOne({ userId: 'a' })).totalChallenges, 4);
});

test('time zone is pinned after first account configuration', async () => {
  await account('a');
  assert.equal((await request('/user/onboarding', { timeZone: 'Asia/Tbilisi' })).status, 200);
  assert.equal((await request('/user/onboarding', { timeZone: 'America/New_York' })).status, 200);
  assert.equal((await UserOnboarding.findOne({ uid: 'a' })).challengeTimeZone, 'Asia/Tbilisi');
});

test('difficulty validation uses the server settings at the event start', async () => {
  const now = Date.now();
  await account('a', { difficultyLevel: 'HARD', challengeSettings: [
    { effectiveAt: new Date(now - 86400000), difficultyLevel: 'EASY', dailyChallengeLimit: 5, targetApps: ['YouTube'] },
    { effectiveAt: new Date(now - 50000), difficultyLevel: 'HARD', dailyChallengeLimit: 5, targetApps: ['YouTube'] },
  ] });
  await recordResult('a', { ...result(1), elapsedTime: 7, timestamp: now - 100000 });
  await assert.rejects(() => recordResult('a', { ...result(2), elapsedTime: 7, timestamp: now - 1000 }), (error) => error.status === 422);
  await assert.rejects(() => recordResult('a', { ...result(3), targetApp: 'Instagram', timestamp: now - 2000 }), (error) => error.status === 422);
  assert.equal((await UserOnboarding.findOne({ uid: 'a' })).coins, 10);
});

test('a revoked token cannot delete an existing account', async () => {
  await account('a');
  revoked = true;
  assert.equal((await request('/user/account', null, 'DELETE')).status, 401);
  assert.equal(await UserOnboarding.countDocuments({ uid: 'a' }), 1);
});

test('latest settings win when baseline and update share a timestamp', async () => {
  const effectiveAt = new Date(Date.now() - 100000);
  await account('a', { difficultyLevel: 'HARD', challengeSettings: [
    { effectiveAt, difficultyLevel: 'EASY', dailyChallengeLimit: 5, targetApps: ['YouTube'] },
    { effectiveAt, difficultyLevel: 'HARD', dailyChallengeLimit: 5, targetApps: ['YouTube'] },
  ] });
  await assert.rejects(() => recordResult('a', { ...result(7), elapsedTime: 6, timestamp: Date.now() - 1000 }), (error) => error.status === 422);
});

test('a new account keeps 150 starter coins and claims one chosen theme and freeze once', async () => {
  const created = await request('/user/onboarding', { targetApps: ['YouTube'], goals: ['focus'], difficultyLevel: 'EASY' });
  assert.equal(created.status, 200);
  const starter = await (await request('/pro', null, 'GET')).json();
  assert.equal(starter.coins, 150);
  assert.equal(starter.welcomeGiftAvailable, true);
  const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => request('/pro/welcome-gift', { themeId: i % 2 ? 'ice' : 'matrix' })));
  assert.ok(responses.every((response) => response.status === 200));
  const profile = await UserOnboarding.findOne({ uid: 'a' });
  assert.equal(profile.coins, 150);
  assert.equal(profile.streakFreezes, 1);
  assert.equal(profile.unlockedThemes.length, 1);
  assert.equal(profile.themeId, profile.welcomeGiftTheme);
  assert.ok(profile.welcomeGiftClaimedAt);
  const afterRestart = await (await request('/pro', null, 'GET')).json();
  assert.equal(afterRestart.welcomeGiftAvailable, false);
  assert.equal(afterRestart.coins, 150);
  assert.equal(afterRestart.streakFreezes, 1);
  assert.equal((await request('/pro/welcome-gift', { themeId: 'unknown' })).status, 400);
});

test('legacy accounts cannot enable a welcome gift through profile input', async () => {
  await account('a', { coins: 75, starterCoinsGrantedAt: new Date() });
  await request('/user/onboarding', { welcomeGiftEligible: true, welcomeGiftClaimedAt: null });
  assert.equal((await request('/pro/welcome-gift', { themeId: 'ice' })).status, 409);
  assert.equal((await UserOnboarding.findOne({ uid: 'a' })).coins, 75);
});

test('500-coin Pro purchase is not refunded by monthly benefits and stays once per month', async () => {
  await account('a', { coins: 500, starterCoinsGrantedAt: new Date() });
  const purchase = await request('/coins/buy', { item: 'proWeek', requestId: 'pro_week_new_500' });
  assert.equal(purchase.status, 200);
  await Promise.all(Array.from({ length: 8 }, () => request('/pro', null, 'GET')));
  const profile = await UserOnboarding.findOne({ uid: 'a' });
  assert.equal(profile.coins, 0);
  assert.equal(profile.streakFreezes, 20);
  assert.equal(profile.proSource, 'coins');
  assert.ok(Math.abs(profile.proExpiresAt.getTime() - Date.now() - 7 * 86400000) < 10000);
  await UserOnboarding.updateOne({ uid: 'a' }, { $set: { proExpiresAt: new Date(Date.now() - 1000), coins: 500 } });
  assert.equal((await request('/coins/buy', { item: 'proWeek', requestId: 'another_pro_week_500' })).status, 409);
  assert.equal((await UserOnboarding.findOne({ uid: 'a' })).coins, 500);
});

test('invite Pro gets freeze benefits but no monthly coin bonus', async () => {
  await account('a', { proPlan: 'monthly', proSource: 'invites', proExpiresAt: new Date(Date.now() + 86400000), starterCoinsGrantedAt: new Date() });
  await Promise.all(Array.from({ length: 5 }, () => request('/pro', null, 'GET')));
  const profile = await UserOnboarding.findOne({ uid: 'a' });
  assert.equal(profile.coins, 0);
  assert.equal(profile.streakFreezes, 20);
});

test('paid Pro receives coins independently of the freeze refill, once per calendar month', async () => {
  await account('a', { proPlan: 'monthly', proSource: 'store', proExpiresAt: new Date(Date.now() + 86400000), freezesRefilledAt: new Date(), starterCoinsGrantedAt: new Date() });
  await Promise.all(Array.from({ length: 8 }, () => request('/pro', null, 'GET')));
  assert.equal((await UserOnboarding.findOne({ uid: 'a' })).coins, 500);
  await UserOnboarding.updateOne({ uid: 'a' }, { $set: { proCoinsGrantedAt: new Date(Date.UTC(2020, 0, 1)) } });
  await Promise.all(Array.from({ length: 5 }, () => request('/pro', null, 'GET')));
  assert.equal((await UserOnboarding.findOne({ uid: 'a' })).coins, 1000);
});

test('existing paid Pro bonuses are not granted a second time during migration', async () => {
  await account('a', { coins: 500, proPlan: 'monthly', proSource: 'store', proExpiresAt: new Date(Date.now() + 86400000), freezesRefilledAt: new Date(), starterCoinsGrantedAt: new Date() });
  await UserOnboarding.collection.updateOne({ uid: 'a' }, { $unset: { proCoinsGrantedAt: '' } });
  await Promise.all(Array.from({ length: 6 }, () => request('/pro', null, 'GET')));
  assert.equal((await UserOnboarding.findOne({ uid: 'a' })).coins, 500);
});

test('earned Pro still doubles both win and perfect-day rewards', async () => {
  await account('a', { proPlan: 'monthly', proSource: 'coins', proExpiresAt: new Date(Date.now() + 86400000), dailyChallengeLimit: 3 });
  for (let i = 0; i < 3; i++) await recordResult('a', result(i));
  assert.equal((await UserOnboarding.findOne({ uid: 'a' })).coins, 160);
});
