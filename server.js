#!/usr/bin/env node
'use strict';

// TodoNow: local personal todo service. Zero dependencies, binds 127.0.0.1 only.
// Same operational model as Golinks: launchd login agent, plain JSON data, hot reload.

const http = require('http');
const fs = require('fs');
const path = require('path');

const { Store, ROOT, HOME_DIR, DATA_DIR, BACKUP_DIR } = require('./lib/store');
const { HttpError, sendJson, sendText, readJson, serveFile } = require('./lib/http');
const folders = require('./lib/folders');
const { searchTodos, parseQuery, localDay, isOverdue } = require('./lib/search');
const { ReminderScheduler, notifyMac, notifierAvailable, minutesOfDay, NOTIFIER } = require('./lib/reminders');

const VERSION = require('./package.json').version;
const PUBLIC_DIR = path.join(ROOT, 'public');
const HOST = '127.0.0.1';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '']);
const STARTED = Date.now();

const store = new Store();
store.loadAll();
store.watch();

const PORT = Number(process.env.TODONOW_PORT || store.settings.port || 7778);
const scheduler = new ReminderScheduler(store);

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---------------------------------------------------------------------------
// Validation

const PRIORITIES = ['none', 'low', 'medium', 'high'];
const STATUSES = ['open', 'waiting', 'someday'];
const RECURRENCES = ['daily', 'weekdays', 'weekly', 'monthly'];
const THEMES = ['system', 'light', 'dark'];
const ID_RE = /^[a-z0-9]{4,16}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanText(value, max = 10000) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim().slice(0, max);
}

// Tags are slugs, the same shape the chip editor produces: lower-case letters, digits, . _ + -
function slugTag(value) {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9._+-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function cleanTags(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,\n]+/);
  return [...new Set(list.map(slugTag).filter(Boolean))].slice(0, 30);
}

function cleanEnum(value, allowed, field, fallback) {
  if (value == null || value === '') return fallback;
  const v = cleanText(value, 20).toLowerCase();
  if (!allowed.includes(v)) throw new HttpError(400, `${field} must be one of ${allowed.join(', ')}`);
  return v;
}

function cleanDate(value, field) {
  if (value == null || value === '') return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new HttpError(400, `${field} must be a valid date or date-time`);
  return new Date(time).toISOString();
}

function cleanDay(value, field) {
  if (value == null || value === '') return null;
  const day = cleanText(value, 10);
  if (!DAY_RE.test(day) || !Number.isFinite(Date.parse(day + 'T00:00:00'))) throw new HttpError(400, `${field} must be a date like 2026-09-10`);
  return day;
}

function cleanInt(value, field, min, max, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${field} must be a number between ${min} and ${max}`);
  return Math.round(n);
}

function cleanTime(value, field) {
  const text = cleanText(value, 5);
  if (minutesOfDay(text) == null) throw new HttpError(400, `${field} must be a time like 09:00`);
  return text.length === 4 ? '0' + text : text;
}

// An optional web page attached to a todo (the bookmarklet sets it). http(s) only.
function cleanUrl(value) {
  const text = cleanText(value, 2000);
  if (!text) return null;
  let parsed;
  try { parsed = new URL(text); } catch { throw new HttpError(400, 'url must be a valid http(s) address'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new HttpError(400, 'url must start with http:// or https://');
  return parsed.href;
}

function cleanNowOrder(value) {
  if (value === null || value === undefined || value === '' || value === false) return null;
  if (value === true) return Date.now();
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeReminder(value) {
  if (!value || typeof value !== 'object') return null;
  const reminder = {};
  if ('enabled' in value && value.enabled != null) reminder.enabled = Boolean(value.enabled);
  if ('minutesBefore' in value && value.minutesBefore != null && value.minutesBefore !== '') reminder.minutesBefore = cleanInt(value.minutesBefore, 'reminder minutesBefore', 0, 43200);
  if ('snoozedUntil' in value && value.snoozedUntil) reminder.snoozedUntil = cleanDate(value.snoozedUntil, 'snoozedUntil');
  return Object.keys(reminder).length ? reminder : null;
}

// Normalizes a folder path and records it (with its ancestors) in folders.json.
function setFolder(value) {
  const p = folders.normalizeFolder(value);
  if (!p) return null;
  const before = store.folders.length;
  const actual = store.ensureFolder(p);
  if (store.folders.length !== before) store.save('folders');
  return actual;
}

// ---------------------------------------------------------------------------
// Todo model

// Applies the editable fields from `body` onto `todo`. Fields that are absent are left alone,
// so the same function serves POST (with a fresh record) and PUT (with the stored one).
function applyFields(todo, body) {
  if ('title' in body) {
    const title = cleanText(body.title, 500);
    if (!title) throw new HttpError(400, 'a todo title is required');
    todo.title = title;
  }
  if ('notes' in body) todo.notes = cleanText(body.notes);
  if ('url' in body) todo.url = cleanUrl(body.url);
  if ('folder' in body) todo.folder = setFolder(body.folder);
  if ('tags' in body) todo.tags = cleanTags(body.tags);
  if ('priority' in body) todo.priority = cleanEnum(body.priority, PRIORITIES, 'priority', 'none');
  if ('status' in body) todo.status = cleanEnum(body.status, STATUSES, 'status', 'open');
  if ('dueAt' in body) todo.dueAt = cleanDate(body.dueAt, 'dueAt');
  if ('plannedDate' in body) todo.plannedDate = cleanDay(body.plannedDate, 'plannedDate');
  if ('nowOrder' in body) todo.nowOrder = cleanNowOrder(body.nowOrder);
  if ('estimateMinutes' in body) todo.estimateMinutes = cleanInt(body.estimateMinutes, 'estimateMinutes', 1, 100000) || null;
  if ('waitingFor' in body) todo.waitingFor = cleanText(body.waitingFor, 200) || null;
  if ('reminder' in body) todo.reminder = normalizeReminder(body.reminder);
  if ('recurrence' in body) todo.recurrence = cleanEnum(body.recurrence, RECURRENCES, 'recurrence', null);
  return todo;
}

function blankTodo(id, now) {
  return {
    id, title: '', notes: '', url: null, folder: null, tags: [], priority: 'none', status: 'open',
    dueAt: null, plannedDate: null, nowOrder: null, estimateMinutes: null, waitingFor: null,
    reminder: null, recurrence: null, createdAt: now, updatedAt: now, completedAt: null, deletedAt: null,
  };
}

function createTodo(body) {
  const now = new Date().toISOString();
  const todo = applyFields(blankTodo(store.newId(), now), { ...body, title: body.title });
  store.todos.push(todo);
  store.save('todos');
  return todo;
}

function updateTodo(todo, body) {
  applyFields(todo, body);
  todo.updatedAt = new Date().toISOString();
  store.save('todos');
  return todo;
}

function requireTodo(id) {
  const todo = store.findTodo(id);
  if (!todo) throw new HttpError(404, 'no such todo');
  return todo;
}

// Completing a recurring todo files the next occurrence. The copy keeps folder, tags, notes,
// priority, estimate and the reminder choice, but not a snooze, a Now slot or history.
function completeTodo(todo, now = new Date()) {
  if (todo.completedAt) return todo;
  todo.completedAt = now.toISOString();
  todo.nowOrder = null;
  todo.updatedAt = todo.completedAt;
  if (todo.recurrence) createRecurringCopy(todo, now);
  return todo;
}

function advance(date, recurrence) {
  const next = new Date(date.getTime());
  if (recurrence === 'daily') next.setDate(next.getDate() + 1);
  else if (recurrence === 'weekdays') { do { next.setDate(next.getDate() + 1); } while (next.getDay() === 0 || next.getDay() === 6); }
  else if (recurrence === 'weekly') next.setDate(next.getDate() + 7);
  else if (recurrence === 'monthly') {
    const day = next.getDate();
    next.setDate(1);
    next.setMonth(next.getMonth() + 1);
    const last = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, last));
  } else return null;
  return next;
}

function createRecurringCopy(todo, now) {
  let dueAt = null;
  let plannedDate = null;
  if (todo.dueAt) {
    const next = advance(new Date(todo.dueAt), todo.recurrence);
    if (!next) return null;
    dueAt = next.toISOString();
  } else if (todo.plannedDate) {
    const next = advance(new Date(todo.plannedDate + 'T12:00:00'), todo.recurrence);
    if (!next) return null;
    plannedDate = localDay(next);
  } else return null;
  const reminder = todo.reminder ? { ...todo.reminder } : null;
  if (reminder) delete reminder.snoozedUntil;
  const stamp = now.toISOString();
  const copy = {
    ...blankTodo(store.newId(), stamp),
    title: todo.title, notes: todo.notes, url: todo.url || null, folder: todo.folder, tags: (todo.tags || []).slice(),
    priority: todo.priority, status: todo.status === 'someday' ? 'open' : todo.status, waitingFor: todo.waitingFor,
    estimateMinutes: todo.estimateMinutes, recurrence: todo.recurrence, reminder: reminder && Object.keys(reminder).length ? reminder : null,
    dueAt, plannedDate,
  };
  store.todos.push(copy);
  return copy;
}

function trashTodo(todo, now = new Date().toISOString()) {
  if (todo.deletedAt) return todo;
  todo.deletedAt = now;
  todo.nowOrder = null;
  todo.updatedAt = now;
  return todo;
}

function decorate(todo, now = new Date()) {
  return { ...todo, overdue: isOverdue(todo, now) };
}

const VIEWS = ['all', 'open', 'inbox', 'today', 'now', 'upcoming', 'waiting', 'someday', 'unfiled', 'completed', 'archived', 'trash'];

// includeArchived: a folder view of an archived folder still shows its todos; everywhere else
// todos in archived folders stay out of the way (the Archived view and the Trash list them).
function inView(todo, view, today, now, includeArchived = false) {
  const open = !todo.completedAt && !todo.deletedAt;
  if (view === 'archived') return !todo.deletedAt && store.isArchived(todo);
  if (view !== 'trash' && !includeArchived && store.isArchived(todo)) return false;
  switch (view) {
    case 'all': return !todo.deletedAt;
    case 'open': return open;
    case 'inbox': return open && !todo.folder && !todo.plannedDate && !todo.dueAt && todo.status === 'open';
    // Due or planned today, anything overdue, and planned days that slipped past without being done.
    case 'today': return open && todo.status !== 'someday' && ((todo.plannedDate && todo.plannedDate <= today) || (todo.dueAt && localDay(new Date(todo.dueAt)) === today) || isOverdue(todo, now));
    case 'now': return open && Number.isFinite(todo.nowOrder);
    case 'upcoming': return open && Boolean(todo.dueAt) && localDay(new Date(todo.dueAt)) > today;
    case 'waiting': return open && todo.status === 'waiting';
    case 'someday': return open && todo.status === 'someday';
    case 'unfiled': return open && !todo.folder;
    case 'completed': return Boolean(todo.completedAt) && !todo.deletedAt;
    case 'trash': return Boolean(todo.deletedAt);
    default: return open;
  }
}

function compareTodos(view) {
  return (a, b) => {
    if (view === 'now') return (a.nowOrder || 0) - (b.nowOrder || 0);
    if (view === 'completed') return Date.parse(b.completedAt || 0) - Date.parse(a.completedAt || 0);
    if (view === 'trash') return Date.parse(b.deletedAt || 0) - Date.parse(a.deletedAt || 0);
    const ao = isOverdue(a), bo = isOverdue(b);
    if (ao !== bo) return ao ? -1 : 1;
    const ad = a.dueAt ? Date.parse(a.dueAt) : a.plannedDate ? Date.parse(a.plannedDate + 'T23:59:59') : Infinity;
    const bd = b.dueAt ? Date.parse(b.dueAt) : b.plannedDate ? Date.parse(b.plannedDate + 'T23:59:59') : Infinity;
    if (ad !== bd) return ad - bd;
    const rank = { high: 0, medium: 1, low: 2, none: 3 };
    if (rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority];
    return Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0);
  };
}

function listTodos(url) {
  const now = new Date();
  const today = localDay(now);
  const view = VIEWS.includes(url.searchParams.get('view')) ? url.searchParams.get('view') : 'open';
  const folder = folders.normalizeFolder(url.searchParams.get('folder'));
  const q = url.searchParams.get('q') || '';
  const includeArchived = Boolean(folder) && store.isArchived(folder);
  let todos = store.todos.filter((todo) => inView(todo, view, today, now, includeArchived));
  if (folder) todos = todos.filter((todo) => folders.isWithin(todo.folder, folder));
  const tag = slugTag(url.searchParams.get('tag'));
  if (tag) todos = todos.filter((todo) => (todo.tags || []).includes(tag));
  todos = searchTodos(todos, q, now).sort(compareTodos(view));
  const limit = cleanInt(url.searchParams.get('limit'), 'limit', 1, 5000, 0);
  const total = todos.length;
  if (limit) todos = todos.slice(0, limit);
  return { todos: todos.map((todo) => decorate(todo, now)), total, view, folder, tag: tag || null, terms: parseQuery(q).terms };
}

function counts() {
  const now = new Date();
  const today = localDay(now);
  const out = {};
  for (const view of VIEWS) out[view] = 0;
  for (const todo of store.todos) for (const view of VIEWS) if (inView(todo, view, today, now)) out[view] += 1;
  out.overdue = store.active.filter((todo) => isOverdue(todo, now) && !store.isArchived(todo)).length;
  return out;
}

// The folder tree for the sidebar and pickers. Counts leave out todos in archived folders; an
// archived folder (or one inside an archived folder) is flagged and carries its own live count.
function folderTree() {
  const live = store.active.filter((todo) => !store.isArchived(todo));
  const tree = folders.listFolders(live, store.folders);
  const archivedLive = store.live.filter((todo) => store.isArchived(todo));
  return tree.map((f) => {
    const archived = store.isArchived(f.path);
    if (!archived) return { ...f, archived: false };
    const rec = store.findFolder(f.path);
    return { ...f, archived: true, archivedHere: Boolean(rec && rec.archived), count: archivedLive.filter((t) => t.folder && t.folder.toLowerCase() === f.path.toLowerCase()).length, total: archivedLive.filter((t) => folders.isWithin(t.folder, f.path)).length };
  });
}

// Defer: move the planned day forward. `until` is tomorrow, week, or YYYY-MM-DD. A deferred todo
// leaves Now, and a Someday item becomes open again since a date is a commitment.
function deferTodo(todo, until, now = new Date()) {
  if (todo.completedAt || todo.deletedAt) throw new HttpError(409, 'only open todos can be deferred');
  const day = deferDay(until, now);
  if (todo.dueAt && localDay(new Date(todo.dueAt)) < day) throw new HttpError(400, `that is after the deadline (${localDay(new Date(todo.dueAt))})`);
  todo.plannedDate = day;
  todo.nowOrder = null;
  if (todo.status === 'someday') todo.status = 'open';
  todo.updatedAt = now.toISOString();
  return todo;
}

function deferDay(until, now = new Date()) {
  const value = cleanText(until, 10).toLowerCase();
  const d = new Date(now);
  if (!value || value === 'tomorrow') d.setDate(d.getDate() + 1);
  else if (value === 'week' || value === 'next-week') d.setDate(d.getDate() + 7);
  else if (value === 'month') d.setMonth(d.getMonth() + 1);
  else {
    const day = cleanDay(value, 'until');
    if (day < localDay(now)) throw new HttpError(400, 'a deferral has to land on today or later');
    return day;
  }
  return localDay(d);
}

function meta() {
  return {
    version: VERSION,
    port: PORT,
    pid: process.pid,
    counts: counts(),
    folders: folderTree(),
    tags: tagCounts(),
    settings: store.settings,
    setupComplete: ['notifications', 'agent', 'bookmarklet'].every((k) => store.settings.setup && store.settings.setup[k]),
    underLaunchd: process.ppid === 1,
    notificationsAvailable: process.platform === 'darwin' && process.env.TODONOW_NO_NOTIFICATIONS !== '1',
    notifierApp: notifierAvailable(),
    home: HOME_DIR,
    root: ROOT,
    execPath: process.execPath,
    node: process.version,
    restartNeeded: codeChangedSinceStart(),
  };
}

function tagCounts() {
  const tags = new Map();
  for (const todo of store.active) if (!store.isArchived(todo)) for (const tag of todo.tags || []) tags.set(tag, (tags.get(tag) || 0) + 1);
  return [...tags.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function codeChangedSinceStart() {
  try {
    const files = [path.join(ROOT, 'server.js'), ...fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, 'lib', f))];
    return files.some((f) => fs.statSync(f).mtimeMs > STARTED);
  } catch { return false; }
}

function purgeExpiredTrash() {
  const days = Math.max(1, Number(store.settings.trashDays || 30));
  const cutoff = Date.now() - days * 86400000;
  const before = store.todos.length;
  store.data.todos = store.todos.filter((todo) => !todo.deletedAt || !(Date.parse(todo.deletedAt) < cutoff));
  if (store.todos.length !== before) { store.save('todos'); log(`[trash] removed ${before - store.todos.length} expired`); }
  return before - store.todos.length;
}

// Runs inside the service process, so the results are the ones that matter.
async function doctor() {
  const checks = [];
  const add = (id, ok, label, detail, fix) => checks.push({ id, ok, label, detail: detail || '', fix: fix || '' });
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 18, `Node ${process.version}`, process.execPath, major >= 18 ? '' : 'Install Node 18 or newer, then run bin/todonow node and bin/todonow restart');
  let writable = true;
  try { fs.accessSync(DATA_DIR, fs.constants.W_OK); } catch { writable = false; }
  add('data', writable, 'Data folder is writable', DATA_DIR, writable ? '' : `Fix the permissions on ${DATA_DIR}`);
  add('agent', process.ppid === 1, 'Running as a login agent', process.ppid === 1 ? 'launchd keeps TodoNow running and starts it at login' : 'started by hand', process.ppid === 1 ? '' : 'Run ./install.sh (or bin/todonow install) once so TodoNow starts at every login');
  const osa = process.platform === 'darwin' && fs.existsSync('/usr/bin/osascript');
  add('osascript', osa, 'macOS notifications available', osa ? '/usr/bin/osascript' : 'not macOS', osa ? '' : 'Notifications need macOS; the rest of TodoNow works without them');
  if (osa) add('notifier', notifierAvailable(), 'Notifications carry the TodoNow name and icon', notifierAvailable() ? NOTIFIER.replace(/\/Contents\/MacOS\/applet$/, '') : 'not built; they show under Script Editor', notifierAvailable() ? '' : 'Run bin/todonow notifier (or bin/todonow install) to build the small notification app');
  let backups = 0;
  try { backups = fs.readdirSync(BACKUP_DIR).filter((f) => /^todos-\d{4}-\d{2}-\d{2}\.json$/.test(f)).length; } catch { /* none yet */ }
  add('backups', null, 'Daily backups', `${backups} kept in ${BACKUP_DIR}`);
  return { ok: checks.every((c) => c.ok !== false), checks, version: VERSION, port: PORT, home: HOME_DIR, restartNeeded: codeChangedSinceStart() };
}

// ---------------------------------------------------------------------------
// Import: every record is rebuilt through the same validation as the API. Ids are kept when
// they look like ours and are free; timestamps are kept when they parse.

function importTodo(raw, existing) {
  if (!raw || typeof raw !== 'object') throw new Error('not an object');
  const now = new Date().toISOString();
  const id = typeof raw.id === 'string' && ID_RE.test(raw.id) && !existing.has(raw.id) ? raw.id : store.newId();
  const todo = applyFields(blankTodo(id, now), { ...raw, title: raw.title });
  const stamp = (field) => { try { return cleanDate(raw[field], field); } catch { return null; } };
  todo.createdAt = stamp('createdAt') || now;
  todo.updatedAt = stamp('updatedAt') || todo.createdAt;
  todo.completedAt = stamp('completedAt');
  todo.deletedAt = stamp('deletedAt');
  if (todo.completedAt || todo.deletedAt) todo.nowOrder = null;
  return todo;
}

// ---------------------------------------------------------------------------
// Router

function param(url, name, def = '') {
  const v = url.searchParams.get(name);
  return v === null ? def : v;
}

async function route(req, res, url) {
  const method = req.method;
  const p = url.pathname;
  const seg = p.split('/').filter(Boolean);

  // Static files: the UI, favicon and the few scripts and styles next to it.
  if (method === 'GET' || method === 'HEAD') {
    if (p === '/') return serveFile(req, res, PUBLIC_DIR, 'index.html');
    if (p === '/add') return serveFile(req, res, PUBLIC_DIR, 'add.html');
    if (p === '/favicon.ico') return serveFile(req, res, PUBLIC_DIR, 'favicon.svg', { cache: 'public, max-age=86400' });
    if (seg.length === 1 && /\.(js|css|svg|png|html|txt)$/.test(seg[0])) return serveFile(req, res, PUBLIC_DIR, seg[0]);
  }
  if (seg[0] !== 'api' && p !== '/quit') throw new HttpError(404, 'not found');

  if (p === '/api/health') {
    return sendJson(res, 200, { ok: true, app: 'TodoNow', version: VERSION, pid: process.pid, port: PORT, uptimeSec: Math.round((Date.now() - STARTED) / 1000), todos: store.active.length, completed: store.completed.length, trash: store.trashed.length, restartNeeded: codeChangedSinceStart(), node: process.version, execPath: process.execPath, home: HOME_DIR });
  }
  if (p === '/api/meta' && method === 'GET') return sendJson(res, 200, meta());
  if (p === '/api/doctor' && method === 'GET') return sendJson(res, 200, await doctor());
  if (p === '/api/bookmarklet' && method === 'GET') return sendJson(res, 200, { href: bookmarkletCode(), port: PORT });

  // ---- todos
  if (p === '/api/todos' && method === 'GET') return sendJson(res, 200, { ...listTodos(url), counts: counts() });
  if (p === '/api/todos' && method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 201, { todo: decorate(createTodo(body)) });
  }
  if (p === '/api/todos/bulk' && method === 'POST') {
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const op = cleanEnum(body.op, ['trash', 'restore', 'purge', 'complete', 'reopen', 'move', 'now', 'unnow', 'defer'], 'op');
    if (!ids.length) throw new HttpError(400, 'ids are required');
    const folder = op === 'move' ? setFolder(body.folder) : null;
    const now = new Date();
    const until = op === 'defer' ? deferDay(body.until, now) : null;
    const stamp = now.toISOString();
    const skipped = [];
    let changed = 0;
    const keep = new Set();
    for (const id of ids) {
      const todo = store.findTodo(id);
      if (!todo) { skipped.push({ id, reason: 'no such todo' }); continue; }
      if (op === 'purge') { if (!todo.deletedAt) { skipped.push({ id, reason: 'not in the trash' }); continue; } keep.add(id); changed += 1; continue; }
      if (op === 'trash') { if (todo.deletedAt) { skipped.push({ id, reason: 'already in the trash' }); continue; } trashTodo(todo, stamp); }
      else if (op === 'restore') { if (!todo.deletedAt) { skipped.push({ id, reason: 'not in the trash' }); continue; } todo.deletedAt = null; todo.updatedAt = stamp; }
      else if (op === 'complete') { if (todo.completedAt || todo.deletedAt) { skipped.push({ id, reason: todo.deletedAt ? 'in the trash' : 'already completed' }); continue; } completeTodo(todo, now); }
      else if (op === 'reopen') { if (!todo.completedAt) { skipped.push({ id, reason: 'not completed' }); continue; } todo.completedAt = null; todo.updatedAt = stamp; }
      else if (op === 'move') { if (todo.deletedAt) { skipped.push({ id, reason: 'in the trash' }); continue; } todo.folder = folder; todo.updatedAt = stamp; }
      else if (op === 'now') { if (todo.completedAt || todo.deletedAt) { skipped.push({ id, reason: 'not open' }); continue; } if (!Number.isFinite(todo.nowOrder)) todo.nowOrder = Date.now() + changed; todo.updatedAt = stamp; }
      else if (op === 'unnow') { todo.nowOrder = null; todo.updatedAt = stamp; }
      else if (op === 'defer') { try { deferTodo(todo, until, now); } catch (err) { skipped.push({ id, reason: err.message }); continue; } }
      changed += 1;
    }
    if (op === 'purge' && keep.size) store.data.todos = store.todos.filter((todo) => !keep.has(todo.id));
    if (changed) store.save('todos');
    return sendJson(res, 200, { changed, skipped, folder, until });
  }
  if (seg[0] === 'api' && seg[1] === 'todos' && seg.length >= 3) {
    const todo = requireTodo(seg[2]);
    const action = seg[3] || '';
    if (seg.length === 3 && method === 'GET') return sendJson(res, 200, { todo: decorate(todo) });
    if (seg.length === 3 && method === 'PUT') return sendJson(res, 200, { todo: decorate(updateTodo(todo, await readJson(req))) });
    if (seg.length === 3 && method === 'DELETE') {
      if (param(url, 'permanent') === '1') {
        if (!todo.deletedAt) throw new HttpError(409, 'move the todo to the trash first');
        store.data.todos = store.todos.filter((item) => item.id !== todo.id);
        store.save('todos');
        return sendJson(res, 200, { ok: true, deleted: todo.id, permanent: true });
      }
      trashTodo(todo);
      store.save('todos');
      return sendJson(res, 200, { todo: decorate(todo) });
    }
    if (method === 'POST' && seg.length === 4) {
      if (action === 'complete') { completeTodo(todo); store.save('todos'); return sendJson(res, 200, { todo: decorate(todo) }); }
      if (action === 'reopen') { todo.completedAt = null; todo.updatedAt = new Date().toISOString(); store.save('todos'); return sendJson(res, 200, { todo: decorate(todo) }); }
      if (action === 'restore') { todo.deletedAt = null; todo.updatedAt = new Date().toISOString(); store.save('todos'); return sendJson(res, 200, { todo: decorate(todo) }); }
      if (action === 'defer') {
        const body = await readJson(req);
        deferTodo(todo, body.until);
        store.save('todos');
        return sendJson(res, 200, { todo: decorate(todo) });
      }
      if (action === 'snooze') {
        const body = await readJson(req);
        const until = body.until ? cleanDate(body.until, 'until') : new Date(Date.now() + cleanInt(body.minutes, 'minutes', 1, 10080, 60) * 60000).toISOString();
        todo.reminder = { ...(todo.reminder || {}), snoozedUntil: until };
        todo.updatedAt = new Date().toISOString();
        store.save('todos');
        return sendJson(res, 200, { todo: decorate(todo) });
      }
    }
    throw new HttpError(404, 'not found');
  }

  // ---- folders
  if (p === '/api/folders' && method === 'GET') return sendJson(res, 200, { folders: folderTree() });
  if (p === '/api/folders' && method === 'POST') {
    const body = await readJson(req);
    const wanted = folders.normalizeFolder(body.path);
    if (!wanted) throw new HttpError(400, 'a folder path is required');
    const existed = Boolean(store.findFolder(wanted));
    const actual = setFolder(wanted);
    return sendJson(res, existed ? 200 : 201, { folder: folderTree().find((f) => f.path === actual), existed });
  }
  if (p === '/api/folders/rename' && method === 'POST') {
    const body = await readJson(req);
    const from = folders.normalizeFolder(body.from);
    const to = folders.normalizeFolder(body.to);
    if (!from || !to) throw new HttpError(400, 'from and to are required');
    if (!store.findFolder(from)) throw new HttpError(404, 'no such folder');
    if (from.toLowerCase() !== to.toLowerCase() && folders.isWithin(to, from)) throw new HttpError(400, 'a folder cannot move inside itself');
    let changed = 0;
    for (const todo of store.todos) {
      const next = folders.rebase(todo.folder, from, to);
      if (next !== todo.folder) { todo.folder = next; todo.updatedAt = new Date().toISOString(); changed += 1; }
    }
    for (const rec of store.folders) rec.path = folders.rebase(rec.path, from, to) || rec.path;
    // Collapse case-duplicates and make sure every ancestor of the new path exists.
    store.data.folders = [...new Map(store.folders.map((rec) => [String(rec.path).toLowerCase(), rec])).values()];
    store.ensureFolder(to);
    store.save('folders');
    if (changed) store.save('todos');
    return sendJson(res, 200, { ok: true, from, to: store.findFolder(to).path, changed });
  }
  if (p === '/api/folders/archive' && method === 'POST') {
    const body = await readJson(req);
    const target = folders.normalizeFolder(body.path);
    if (!target || !store.findFolder(target)) throw new HttpError(404, 'no such folder');
    const rec = store.findFolder(target);
    const archived = body.archived == null ? !rec.archived : Boolean(body.archived);
    if (archived) rec.archived = true; else delete rec.archived;
    let cleared = 0;
    if (archived) for (const todo of store.todos) if (Number.isFinite(todo.nowOrder) && folders.isWithin(todo.folder, target)) { todo.nowOrder = null; todo.updatedAt = new Date().toISOString(); cleared += 1; }
    store.save('folders');
    if (cleared) store.save('todos');
    // Still inside an archived parent after unarchiving? Say so, the caller may want to unarchive that instead.
    const parentArchived = !archived && store.isArchived(target);
    return sendJson(res, 200, { ok: true, path: rec.path, archived, effective: store.isArchived(target), parentArchived, todos: store.live.filter((t) => folders.isWithin(t.folder, target)).length });
  }
  if (p === '/api/folders/delete' && method === 'POST') {
    const body = await readJson(req);
    const target = folders.normalizeFolder(body.path);
    if (!target || !store.findFolder(target)) throw new HttpError(404, 'no such folder');
    const parent = folders.parentOf(target);
    let moved = 0;
    for (const todo of store.todos) if (folders.isWithin(todo.folder, target)) { todo.folder = parent; todo.updatedAt = new Date().toISOString(); moved += 1; }
    store.data.folders = store.folders.filter((rec) => !folders.isWithin(rec.path, target));
    store.save('folders');
    if (moved) store.save('todos');
    return sendJson(res, 200, { ok: true, moved, parent });
  }

  // ---- settings
  if (p === '/api/settings' && method === 'GET') return sendJson(res, 200, { settings: store.settings });
  if (p === '/api/settings' && method === 'PUT') {
    const body = await readJson(req);
    const s = store.settings;
    if (body.dailyReminder && typeof body.dailyReminder === 'object') {
      const d = body.dailyReminder;
      s.dailyReminder = { enabled: 'enabled' in d ? Boolean(d.enabled) : s.dailyReminder.enabled, time: 'time' in d ? cleanTime(d.time, 'daily reminder time') : s.dailyReminder.time };
    }
    if (body.deadlineReminder && typeof body.deadlineReminder === 'object') {
      const d = body.deadlineReminder;
      s.deadlineReminder = { enabled: 'enabled' in d ? Boolean(d.enabled) : s.deadlineReminder.enabled, minutesBefore: 'minutesBefore' in d ? cleanInt(d.minutesBefore, 'deadline notice', 0, 43200) : s.deadlineReminder.minutesBefore };
    }
    if (body.quietHours && typeof body.quietHours === 'object') {
      const q = body.quietHours;
      s.quietHours = { enabled: 'enabled' in q ? Boolean(q.enabled) : s.quietHours.enabled, start: 'start' in q ? cleanTime(q.start, 'quiet hours start') : s.quietHours.start, end: 'end' in q ? cleanTime(q.end, 'quiet hours end') : s.quietHours.end };
    }
    if ('theme' in body) s.theme = cleanEnum(body.theme, THEMES, 'theme', 'system');
    if ('trashDays' in body) s.trashDays = cleanInt(body.trashDays, 'trashDays', 1, 3650);
    if ('weekStartsOn' in body) s.weekStartsOn = cleanInt(body.weekStartsOn, 'weekStartsOn', 0, 6);
    let restartRequired = false;
    if ('port' in body) { s.port = cleanInt(body.port, 'port', 1024, 65535); restartRequired = s.port !== PORT; }
    if (body.setup && typeof body.setup === 'object') {
      s.setup = { ...s.setup };
      for (const [key, value] of Object.entries(body.setup)) if (/^[a-z]{1,30}$/i.test(key)) s.setup[key] = Boolean(value);
    }
    store.save('settings');
    return sendJson(res, 200, { settings: s, restartRequired });
  }

  if (p === '/api/reminders/test' && method === 'POST') {
    await notifyMac('Test notification', 'Notifications are working.');
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/reminders/run' && method === 'POST') {
    const delivered = await scheduler.tick(new Date());
    return sendJson(res, 200, { delivered: delivered.map((item) => ({ key: item.key, kind: item.kind, message: item.message })) });
  }

  // ---- trash, export, import
  if (p === '/api/trash/empty' && method === 'POST') {
    const amount = store.trashed.length;
    if (amount) { store.data.todos = store.live; store.save('todos'); }
    return sendJson(res, 200, { deleted: amount });
  }
  if (p === '/api/export' && method === 'GET') {
    const body = { app: 'TodoNow', version: VERSION, exportedAt: new Date().toISOString(), todos: store.todos, folders: store.folders, settings: store.settings };
    const text = JSON.stringify(body, null, 2) + '\n';
    const preview = param(url, 'preview') === '1';
    if (preview) return sendJson(res, 200, { count: store.todos.length, folders: store.folders.length, filename: exportFilename() });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'content-disposition': `attachment; filename="${exportFilename()}"`, 'cache-control': 'no-store' });
    return res.end(text);
  }
  if (p === '/api/import' && method === 'POST') {
    const body = await readJson(req, 10 * 1024 * 1024);
    if (!Array.isArray(body.todos)) throw new HttpError(400, 'a TodoNow JSON export with a todos array is required');
    const existing = new Set(store.todos.map((todo) => todo.id));
    const added = [];
    const skipped = [];
    for (const raw of body.todos) {
      try {
        const todo = importTodo(raw, existing);
        existing.add(todo.id);
        store.todos.push(todo);
        added.push(todo.id);
      } catch (err) {
        skipped.push({ title: raw && raw.title ? String(raw.title).slice(0, 80) : '(no title)', reason: err.message });
      }
    }
    let foldersAdded = 0;
    if (Array.isArray(body.folders)) {
      for (const rec of body.folders) {
        const wanted = folders.normalizeFolder(rec && rec.path);
        if (wanted && !store.findFolder(wanted)) { store.ensureFolder(wanted); foldersAdded += 1; }
        if (wanted && rec.archived) { const kept = store.findFolder(wanted); if (kept) kept.archived = true; }
      }
    }
    if (added.length) store.save('todos');
    if (foldersAdded || (Array.isArray(body.folders) && body.folders.some((rec) => rec && rec.archived))) store.save('folders');
    return sendJson(res, 200, { added: added.length, ids: added, skipped, foldersAdded });
  }

  // ---- service
  if (p === '/quit' && method === 'POST') {
    sendJson(res, 200, { ok: true, message: 'stopping' });
    log('quit requested via /quit');
    setTimeout(() => shutdown(0), 150);
    return;
  }
  // Restart without Terminal: exit non-zero so launchd (KeepAlive on failure) starts the service
  // again. When run by hand there is nobody to relaunch it, and the caller is told so.
  if (p === '/api/restart' && method === 'POST') {
    const relaunch = process.ppid === 1;
    sendJson(res, 200, { ok: true, relaunch, pid: process.pid });
    if (!relaunch) { log('restart requested, but not running under launchd; staying up'); return; }
    log('restart requested via /api/restart');
    setTimeout(() => shutdown(1), 200);
    return;
  }

  // Open the Notifications pane of System Settings for the user (the browser cannot open
  // x-apple.systempreferences links reliably). The pane lands on the TodoNow entry.
  if (p === '/api/open-settings' && method === 'POST') {
    const { spawn } = require('child_process');
    const target = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension' + (notifierAvailable() ? '?id=dev.todonow.notifier' : '');
    spawn('/usr/bin/open', [target], { stdio: 'ignore', detached: true }).unref();
    return sendJson(res, 200, { ok: true, pane: 'notifications' });
  }

  throw new HttpError(404, 'not found');
}

function bookmarkletCode() {
  const src = fs.readFileSync(path.join(ROOT, 'bookmarklet', 'add-to-todonow.js'), 'utf8');
  const min = src
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, '').trim())
    .filter(Boolean)
    .join('')
    .replace(/__PORT__/g, String(PORT));
  return 'javascript:' + encodeURIComponent(min).replace(/%20/g, ' ');
}

function exportFilename() {
  return `todonow-${localDay()}.json`;
}

// ---------------------------------------------------------------------------
// Server

function isLocalOrigin(origin) {
  try { return LOCAL_HOSTS.has(new URL(origin).hostname); } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
    const hostHeader = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!LOCAL_HOSTS.has(hostHeader)) throw new HttpError(403, 'local access only');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && origin !== 'null' && !isLocalOrigin(origin)) throw new HttpError(403, 'cross-origin writes are not allowed');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'cross-site writes are not allowed');
    }
    await route(req, res, url);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: err.message, ...(err.extra || {}) });
    else res.end();
  } finally {
    if (url && !/^\/api\/health$|\.(js|css|svg|png)$/.test(url.pathname)) {
      log(req.method, url.pathname + (url.search || ''), res.statusCode, `${Date.now() - t0}ms`);
    }
  }
});

let trashTimer = null;

function shutdown(code) {
  clearInterval(trashTimer);
  scheduler.stop();
  store.close();
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 1000).unref();
}

process.on('SIGTERM', () => { log('SIGTERM'); shutdown(0); });
process.on('SIGINT', () => { log('SIGINT'); shutdown(0); });
process.on('uncaughtException', (err) => { console.error('uncaught', err); shutdown(1); });

server.listen(PORT, HOST, () => {
  log(`TodoNow v${VERSION} listening on http://${HOST}:${PORT} (${store.active.length} open todos, pid ${process.pid})`);
  purgeExpiredTrash();
  scheduler.start();
  trashTimer = setInterval(purgeExpiredTrash, 6 * 60 * 60 * 1000);
  trashTimer.unref();
});

module.exports = { server, store, scheduler, createTodo, updateTodo, completeTodo, deferTodo, deferDay, advance, listTodos, counts };
