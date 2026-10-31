const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server-core');
const { UserOnboarding } = require('../dist/models/UserOnboarding');
const { UserStats } = require('../dist/models/UserStats');
const { ChallengeResult } = require('../dist/models/ChallengeResult');
const { ChallengeDay } = require('../dist/models/ChallengeDay');
const { Duel } = require('../dist/models/Duel');
const { recordResult, reclaimResult } = require('../dist/services/challenges');
const { acceptDuel, cancelDuel, settleDuel } = require('../dist/services/duelTransactions');
const { verifiedEmailFrom, isOwner } = require('../dist/services/identity');
const { isProActive } = require('../dist/routes/proRoutes');
const express = require('express');
let claims = { uid: 'a', email: 'user@example.com', email_verified: true };
const adminPath = require.resolve('../dist/config/firebaseAdmin');
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: { __esModule: true, default: { auth: () => ({ verifyIdToken: async () => claims }) } } };
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
  await Promise.all([UserOnboarding.init(), UserStats.init(), ChallengeResult.init(), ChallengeDay.init(), Duel.init()]);
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
beforeEach(async () => { await Promise.all([UserOnboarding.deleteMany({}), UserStats.deleteMany({}), ChallengeResult.deleteMany({}), ChallengeDay.deleteMany({}), Duel.deleteMany({})]); });

const account = (uid, extra = {}) => UserOnboarding.create({ uid, createdAt: new Date(Date.now() - 86400000 * 30), ...extra });
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
