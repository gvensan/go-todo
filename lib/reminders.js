'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { localDay, isOverdue } = require('./search');

// bin/todonow install builds a small AppleScript applet so notifications carry the TodoNow name
// and icon. Without it, osascript posts them (they then show under Script Editor).
const NOTIFIER = path.join(__dirname, '..', 'bin', 'TodoNow.app', 'Contents', 'MacOS', 'applet');
function notifierAvailable() {
  try { fs.accessSync(NOTIFIER, fs.constants.X_OK); return true; } catch { return false; }
}

function minutesOfDay(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function inQuietHours(settings, now) {
  const quiet = settings.quietHours || {};
  if (!quiet.enabled) return false;
  const start = minutesOfDay(quiet.start);
  const end = minutesOfDay(quiet.end);
  if (start == null || end == null) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function collectNotifications(todos, settings, state, now = new Date()) {
  const notifications = [];
  const sent = state.sent || (state.sent = {});
  if (inQuietHours(settings, now)) return notifications;
  const active = todos.filter((todo) => !todo.completedAt && !todo.deletedAt);
  const today = localDay(now);
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  const daily = settings.dailyReminder || {};
  const dailyMinute = minutesOfDay(daily.time);
  const dailyKey = `daily:${today}`;
  if (daily.enabled && dailyMinute != null && currentMinute >= dailyMinute && !sent[dailyKey]) {
    const dueToday = active.filter((todo) => todo.dueAt && localDay(new Date(todo.dueAt)) === today).length;
    const overdue = active.filter((todo) => isOverdue(todo, now)).length;
    const parts = [`${active.length} open ${active.length === 1 ? 'todo' : 'todos'}`];
    if (dueToday) parts.push(`${dueToday} due today`);
    if (overdue) parts.push(`${overdue} overdue`);
    notifications.push({ key: dailyKey, title: 'Daily reminder', message: parts.join(' · '), kind: 'daily' });
  }

  const defaultDeadline = settings.deadlineReminder || {};
  for (const todo of active) {
    if (!todo.dueAt) continue;
    const due = Date.parse(todo.dueAt);
    if (!Number.isFinite(due)) continue;
    const reminder = todo.reminder || {};
    const enabled = reminder.enabled == null ? defaultDeadline.enabled : reminder.enabled;
    if (!enabled) continue;
    const minutesBefore = Number.isFinite(Number(reminder.minutesBefore)) ? Number(reminder.minutesBefore) : Number(defaultDeadline.minutesBefore || 60);
    const snoozed = reminder.snoozedUntil ? Date.parse(reminder.snoozedUntil) : null;
    const fireAt = Number.isFinite(snoozed) && snoozed > due - minutesBefore * 60000 ? snoozed : due - minutesBefore * 60000;
    const key = `deadline:${todo.id}:${todo.dueAt}:${Number.isFinite(snoozed) ? reminder.snoozedUntil : minutesBefore}`;
    if (now.getTime() >= fireAt && now.getTime() < due + 86400000 && !sent[key]) {
      notifications.push({ key, title: 'Deadline approaching', message: todo.title, kind: 'deadline', todoId: todo.id });
    }
  }
  return notifications;
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
}

function notifyMac(title, message, options = {}) {
  if (options.dryRun || process.env.TODONOW_NO_NOTIFICATIONS === '1' || process.platform !== 'darwin') return Promise.resolve();
  const useApp = !options.plain && notifierAvailable();
  // The applet shows "TodoNow" as the sender, so the title stays short. osascript shows
  // "Script Editor", so the app name goes into the title instead.
  const shownTitle = useApp ? title : `TodoNow: ${title}`;
  // The applet reads its text from the environment: applets launched from the command line do
  // not receive arguments in their run handler on current macOS.
  const command = useApp ? NOTIFIER : '/usr/bin/osascript';
  const args = useApp ? [] : ['-e', `display notification ${appleScriptString(message)} with title ${appleScriptString(shownTitle)}`];
  const env = useApp ? { ...process.env, TODONOW_TITLE: String(shownTitle), TODONOW_MESSAGE: String(message), TODONOW_SUBTITLE: String(options.subtitle || '') } : process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', env });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${useApp ? 'notification app' : 'osascript'} exited ${code}`)));
  });
}

class ReminderScheduler {
  constructor(store, notify = notifyMac, intervalMs = 30000) {
    this.store = store;
    this.notify = notify;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick(now = new Date()) {
    if (this.running) return [];
    this.running = true;
    const delivered = [];
    try {
      const todos = typeof this.store.isArchived === 'function' ? this.store.todos.filter((todo) => !this.store.isArchived(todo)) : this.store.todos;
      const due = collectNotifications(todos, this.store.settings, this.store.reminderState, now);
      for (const item of due) {
        try {
          await this.notify(item.title, item.message);
          this.store.reminderState.sent[item.key] = now.toISOString();
          delivered.push(item);
        } catch (err) {
          console.error('[reminder] notification failed:', err.message);
        }
      }
      if (delivered.length) this.store.save('reminderState');
      this.prune(now);
    } finally {
      this.running = false;
    }
    return delivered;
  }

  prune(now) {
    const cutoff = now.getTime() - 45 * 86400000;
    let changed = false;
    for (const [key, value] of Object.entries(this.store.reminderState.sent || {})) {
      if (Date.parse(value) < cutoff) { delete this.store.reminderState.sent[key]; changed = true; }
    }
    if (changed) this.store.save('reminderState');
  }
}

module.exports = { ReminderScheduler, collectNotifications, notifyMac, notifierAvailable, minutesOfDay, inQuietHours, NOTIFIER };
