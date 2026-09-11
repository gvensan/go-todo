'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectNotifications, ReminderScheduler, inQuietHours } = require('../lib/reminders');

const settings = {
  dailyReminder: { enabled: true, time: '09:00' },
  deadlineReminder: { enabled: true, minutesBefore: 60 },
  quietHours: { enabled: false, start: '22:00', end: '07:00' },
};

test('daily and one-hour deadline reminders fire once', () => {
  const now = new Date(2026, 8, 10, 9, 15);
  const due = new Date(2026, 8, 10, 10, 0).toISOString();
  const state = { sent: {} };
  const notices = collectNotifications([{ id: 'a', title: 'Prepare update', dueAt: due }], settings, state, now);
  assert.deepEqual(notices.map((notice) => notice.kind), ['daily', 'deadline']);
  assert.deepEqual(notices.map((notice) => notice.title), ['Daily reminder', 'Deadline approaching']);
  for (const notice of notices) state.sent[notice.key] = now.toISOString();
  assert.equal(collectNotifications([{ id: 'a', title: 'Prepare update', dueAt: due }], settings, state, now).length, 0);
});

test('quiet hours work across midnight', () => {
  const quiet = { ...settings, quietHours: { enabled: true, start: '22:00', end: '07:00' } };
  assert.equal(inQuietHours(quiet, new Date(2026, 8, 10, 23, 0)), true);
  assert.equal(inQuietHours(quiet, new Date(2026, 8, 10, 12, 0)), false);
});

test('scheduler marks only successfully delivered notifications', async () => {
  const now = new Date(2026, 8, 10, 9, 15);
  const saves = [];
  const store = { todos: [], settings, reminderState: { sent: {} }, save: (name) => saves.push(name) };
  const scheduler = new ReminderScheduler(store, async () => {});
  const delivered = await scheduler.tick(now);
  assert.equal(delivered.length, 1);
  assert.ok(store.reminderState.sent[`daily:2026-09-10`]);
  assert.deepEqual(saves, ['reminderState']);
});
