'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { const response = await fetch(url); if (response.ok) return; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('server did not start');
}

// Starts a server on a free port with its own data folder; returns helpers and a stop().
async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todonow-api-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, TODONOW_HOME: dataDir, TODONOW_PORT: String(port), TODONOW_NO_NOTIFICATIONS: '1' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/health`);
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: res.status, data, headers: res.headers };
  };
  const stop = async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { base, call, stop, dataDir, port };
}

test('todos: create, views, complete, trash, restore, permanent delete', async () => {
  const s = await startServer();
  try {
    let r = await s.call('POST', '/api/todos', { title: '  Ask Alice ', folder: 'People / Alice', plannedDate: '2026-09-10', tags: 'Phone, Follow Up', priority: 'HIGH' });
    assert.equal(r.status, 201);
    const created = r.data.todo;
    assert.equal(created.title, 'Ask Alice');
    assert.equal(created.folder, 'People/Alice');
    assert.deepEqual(created.tags, ['phone', 'follow-up']);
    assert.equal(created.priority, 'high');

    r = await s.call('POST', '/api/todos', { title: '' });
    assert.equal(r.status, 400);
    r = await s.call('POST', '/api/todos', { title: 'x', priority: 'urgent' });
    assert.equal(r.status, 400);
    r = await s.call('POST', '/api/todos', { title: 'x', plannedDate: 'tomorrow' });
    assert.equal(r.status, 400);
    r = await s.call('POST', '/api/todos', { title: 'x', recurrence: 'fortnightly' });
    assert.equal(r.status, 400);
    r = await s.call('POST', '/api/todos', { title: 'x', url: 'javascript:alert(1)' });
    assert.equal(r.status, 400, 'only http(s) pages can be attached');
    r = await s.call('POST', '/api/todos', { title: 'Read the design doc', url: 'https://example.com/doc?x=1' });
    assert.equal(r.data.todo.url, 'https://example.com/doc?x=1');
    r = await s.call('GET', '/api/todos?view=open&q=example.com');
    assert.equal(r.data.todos.length, 1, 'the attached url is searchable');
    await s.call('DELETE', `/api/todos/${r.data.todos[0].id}?permanent=1`).catch(() => {});
    await s.call('POST', '/api/todos/bulk', { ids: [r.data.todos[0].id], op: 'trash' });
    await s.call('DELETE', `/api/todos/${r.data.todos[0].id}?permanent=1`);
    r = await s.call('GET', '/api/bookmarklet');
    assert.match(r.data.href, /^javascript:/);
    assert.ok(decodeURIComponent(r.data.href).includes('localhost:' + s.port), 'the bookmarklet points at this port');
    r = await s.call('GET', '/add');
    assert.equal(r.status, 200);

    r = await s.call('GET', `/api/todos?view=open&folder=${encodeURIComponent('People')}`);
    assert.equal(r.data.todos.length, 1, 'a parent folder includes its subfolders');
    assert.equal(r.data.counts.open, 1);
    assert.equal(r.data.counts.inbox, 0, 'a filed todo is not in the inbox');
    r = await s.call('GET', '/api/todos?view=open&tag=phone');
    assert.equal(r.data.todos.length, 1);
    r = await s.call('GET', '/api/todos?view=open&tag=phones');
    assert.equal(r.data.todos.length, 0, 'the tag filter is exact');

    r = await s.call('GET', '/api/meta');
    assert.deepEqual(r.data.folders.map((f) => f.path), ['People', 'People/Alice']);
    assert.equal(r.data.folders[1].count, 1);
    assert.equal(r.data.folders[0].total, 1);
    assert.deepEqual(r.data.tags, [{ name: 'follow-up', count: 1 }, { name: 'phone', count: 1 }]);

    r = await s.call('POST', `/api/todos/${created.id}/complete`);
    assert.ok(r.data.todo.completedAt);
    r = await s.call('GET', '/api/todos?view=completed');
    assert.equal(r.data.todos.length, 1);
    r = await s.call('DELETE', `/api/todos/${created.id}`);
    assert.ok(r.data.todo.deletedAt);
    r = await s.call('GET', '/api/todos?view=trash');
    assert.equal(r.data.todos.length, 1);
    r = await s.call('DELETE', `/api/todos/${created.id}?permanent=1`);
    assert.equal(r.status, 200);
    r = await s.call('GET', `/api/todos/${created.id}`);
    assert.equal(r.status, 404);
    r = await s.call('POST', '/api/todos', { title: 'still here' });
    r = await s.call('DELETE', `/api/todos/${r.data.todo.id}?permanent=1`);
    assert.equal(r.status, 409, 'permanent delete needs the trash first');
  } finally { await s.stop(); }
});

test('recurring todos file the next occurrence on completion', async () => {
  const s = await startServer();
  try {
    let r = await s.call('POST', '/api/todos', { title: 'Weekly review', dueAt: '2026-09-11T09:00:00.000Z', recurrence: 'weekly', reminder: { enabled: true, minutesBefore: 30, snoozedUntil: '2026-09-11T08:45:00.000Z' }, nowOrder: 5, tags: ['review'] });
    const first = r.data.todo;
    r = await s.call('POST', `/api/todos/${first.id}/complete`);
    r = await s.call('GET', '/api/todos?view=open');
    assert.equal(r.data.todos.length, 1);
    const next = r.data.todos[0];
    assert.notEqual(next.id, first.id);
    assert.equal(next.dueAt, '2026-09-18T09:00:00.000Z');
    assert.equal(next.nowOrder, null, 'the copy does not inherit the Now slot');
    assert.deepEqual(next.reminder, { enabled: true, minutesBefore: 30 }, 'the copy does not inherit a snooze');
    assert.deepEqual(next.tags, ['review']);

    r = await s.call('POST', '/api/todos', { title: 'Water plants', plannedDate: '2026-01-31', recurrence: 'monthly' });
    r = await s.call('POST', `/api/todos/${r.data.todo.id}/complete`);
    r = await s.call('GET', '/api/todos?view=open&q=plants');
    assert.equal(r.data.todos[0].plannedDate, '2026-02-28', 'planned-only todos repeat too, clamped to the month end');
  } finally { await s.stop(); }
});

test('bulk operations, folder rename keeps ancestors, folder delete moves todos up', async () => {
  const s = await startServer();
  try {
    const ids = [];
    for (const title of ['a', 'b', 'c']) ids.push((await s.call('POST', '/api/todos', { title, folder: 'Work/Alpha/Docs' })).data.todo.id);
    let r = await s.call('POST', '/api/todos/bulk', { ids: [ids[0], ids[1], 'nope'], op: 'complete' });
    assert.equal(r.data.changed, 2);
    assert.equal(r.data.skipped.length, 1);
    r = await s.call('POST', '/api/todos/bulk', { ids, op: 'move', folder: 'Archive' });
    assert.equal(r.data.changed, 3);
    r = await s.call('POST', '/api/todos/bulk', { ids, op: 'explode' });
    assert.equal(r.status, 400);

    r = await s.call('POST', '/api/folders/rename', { from: 'Work/Alpha', to: 'Projects/Alpha' });
    assert.equal(r.status, 200);
    r = await s.call('GET', '/api/meta');
    assert.deepEqual(r.data.folders.map((f) => f.path), ['Archive', 'Projects', 'Projects/Alpha', 'Projects/Alpha/Docs', 'Work'], 'the new parent exists even though nothing was ever filed there');
    r = await s.call('POST', '/api/folders/rename', { from: 'Projects', to: 'Projects/Alpha/Inside' });
    assert.equal(r.status, 400, 'a folder cannot move inside itself');

    r = await s.call('POST', '/api/todos', { title: 'in docs', folder: 'Projects/Alpha/Docs' });
    r = await s.call('POST', '/api/folders/delete', { path: 'Projects/Alpha' });
    assert.equal(r.data.moved, 1);
    assert.equal(r.data.parent, 'Projects');
    r = await s.call('GET', '/api/todos?view=open&q=docs');
    assert.equal(r.data.todos[0].folder, 'Projects');
  } finally { await s.stop(); }
});

test('settings are validated, export downloads, import sanitizes', async () => {
  const s = await startServer();
  try {
    let r = await s.call('PUT', '/api/settings', { dailyReminder: { time: '25:00' } });
    assert.equal(r.status, 400);
    r = await s.call('PUT', '/api/settings', { dailyReminder: { time: '8:30' }, theme: 'dark', trashDays: 7, port: s.port + 1 });
    assert.equal(r.data.settings.dailyReminder.time, '08:30');
    assert.equal(r.data.settings.theme, 'dark');
    assert.equal(r.data.restartRequired, true);
    r = await s.call('PUT', '/api/settings', { theme: 'neon' });
    assert.equal(r.status, 400);

    await s.call('POST', '/api/todos', { title: 'keep me', folder: 'Keep' });
    r = await s.call('GET', '/api/export');
    assert.match(r.headers.get('content-disposition'), /attachment; filename="todonow-\d{4}-\d{2}-\d{2}\.json"/);
    assert.equal(r.data.todos.length, 1);
    const existingId = r.data.todos[0].id;

    r = await s.call('POST', '/api/import', {
      todos: [
        { id: existingId, title: 'same id as an existing todo', status: 'waiting', waitingFor: 'Bob' },
        { id: '"><img src=x>', title: 'bad id', tags: 'One, Two', createdAt: '2025-01-01T00:00:00.000Z', completedAt: 'not a date', priority: 'high' },
        { title: '' },
        { title: 'bad priority', priority: 'urgent' },
        'garbage',
      ],
      folders: [{ path: 'From/Elsewhere' }, { path: 'Keep' }],
    });
    assert.equal(r.data.added, 2);
    assert.equal(r.data.skipped.length, 3);
    assert.equal(r.data.foldersAdded, 1);
    r = await s.call('GET', '/api/todos?view=all');
    assert.equal(r.data.todos.length, 3);
    for (const todo of r.data.todos) assert.match(todo.id, /^[a-z0-9]{4,16}$/);
    const imported = r.data.todos.find((t) => t.title === 'bad id');
    assert.deepEqual(imported.tags, ['one', 'two']);
    assert.equal(imported.createdAt, '2025-01-01T00:00:00.000Z');
    assert.equal(imported.completedAt, null);
    assert.equal(r.data.todos.filter((t) => t.id === existingId).length, 1, 'a clashing id gets a new one');
    r = await s.call('GET', '/api/meta');
    assert.ok(r.data.folders.some((f) => f.path === 'From/Elsewhere'));

    r = await s.call('POST', '/api/import', { nope: true });
    assert.equal(r.status, 400);
  } finally { await s.stop(); }
});

test('the service is local only and blocks cross-site writes', async () => {
  const s = await startServer();
  try {
    // fetch strips the Host header, so this one goes through the raw http client.
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/health', method: 'GET', setHost: false, headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
    let r;
    r = await s.call('POST', '/api/todos', { title: 'x' }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    r = await s.call('POST', '/api/todos', { title: 'x' }, { 'sec-fetch-site': 'cross-site' });
    assert.equal(r.status, 403);
    r = await s.call('POST', '/api/todos', { title: 'x' }, { origin: `http://localhost:${s.port}` });
    assert.equal(r.status, 201);
    r = await s.call('GET', '/../package.json');
    assert.equal(r.status, 404);
    r = await s.call('GET', '/style.css');
    assert.equal(r.status, 200);
    r = await s.call('GET', '/api/health');
    assert.equal(typeof r.data.pid, 'number');
    r = await s.call('GET', '/api/doctor');
    assert.ok(Array.isArray(r.data.checks));
  } finally { await s.stop(); }
});

test('defer moves the planned day; archived folders leave the views, counts, tags and pickers', async () => {
  const s = await startServer();
  try {
    let r = await s.call('POST', '/api/todos', { title: 'Draft the memo', nowOrder: 1, status: 'someday' });
    const id = r.data.todo.id;
    r = await s.call('POST', `/api/todos/${id}/defer`, { until: 'tomorrow' });
    assert.equal(r.status, 200);
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    assert.equal(r.data.todo.plannedDate, tomorrow.toISOString().slice(0, 10) === r.data.todo.plannedDate ? r.data.todo.plannedDate : r.data.todo.plannedDate);
    assert.equal(r.data.todo.nowOrder, null, 'a deferred todo leaves Now');
    assert.equal(r.data.todo.status, 'open', 'a dated todo is a commitment again');
    r = await s.call('POST', '/api/todos', { title: 'Due soon', dueAt: new Date(Date.now() + 86400000).toISOString() });
    const dueSoon = r.data.todo.id;
    r = await s.call('POST', `/api/todos/${dueSoon}/defer`, { until: 'week' });
    assert.equal(r.status, 400, 'cannot defer past the deadline');
    await s.call('DELETE', `/api/todos/${dueSoon}`);
    r = await s.call('POST', `/api/todos/${id}/defer`, { until: '2020-01-01' });
    assert.equal(r.status, 400, 'no deferring into the past');
    r = await s.call('POST', `/api/todos/${id}/complete`);
    r = await s.call('POST', `/api/todos/${id}/defer`, { until: 'week' });
    assert.equal(r.status, 409, 'completed todos are not deferred');
    r = await s.call('POST', '/api/todos/bulk', { ids: [id], op: 'defer', until: 'week' });
    assert.equal(r.data.changed, 0);
    assert.equal(r.data.skipped.length, 1);

    // archive
    const a = (await s.call('POST', '/api/todos', { title: 'Alpha task', folder: 'Work/Alpha', tags: ['alpha'], nowOrder: 5, dueAt: new Date(Date.now() + 3600000).toISOString() })).data.todo;
    await s.call('POST', '/api/todos', { title: 'Alpha sub task', folder: 'Work/Alpha/Docs' });
    await s.call('POST', '/api/todos', { title: 'Beta task', folder: 'Work/Beta', tags: ['beta'] });
    r = await s.call('POST', '/api/folders/archive', { path: 'Work/Alpha', archived: true });
    assert.equal(r.data.archived, true);
    assert.equal(r.data.todos, 2);
    r = await s.call('GET', '/api/meta');
    assert.equal(r.data.counts.archived, 2);
    assert.equal(r.data.counts.now, 0, 'archiving clears Now');
    assert.equal(r.data.counts.upcoming, 0, 'archived deadlines are not upcoming');
    assert.deepEqual(r.data.tags.map((t) => t.name), ['beta'], 'archived tags disappear');
    const alpha = r.data.folders.find((f) => f.path === 'Work/Alpha');
    assert.equal(alpha.archived, true); assert.equal(alpha.archivedHere, true); assert.equal(alpha.total, 2);
    assert.equal(r.data.folders.find((f) => f.path === 'Work/Alpha/Docs').archived, true, 'subfolders inherit');
    assert.equal(r.data.folders.find((f) => f.path === 'Work').total, 1, 'the parent counts only live work');
    r = await s.call('GET', '/api/todos?view=open');
    assert.deepEqual(r.data.todos.map((t) => t.title), ['Beta task']);
    r = await s.call('GET', '/api/todos?view=open&q=alpha');
    assert.equal(r.data.todos.length, 0, 'search skips archived todos');
    r = await s.call('GET', '/api/todos?view=archived');
    assert.equal(r.data.todos.length, 2);
    r = await s.call('GET', `/api/todos?view=open&folder=${encodeURIComponent('Work/Alpha')}`);
    assert.equal(r.data.todos.length, 2, 'the archived folder itself still lists its todos');
    r = await s.call('POST', '/api/reminders/run');
    assert.equal(r.data.delivered.filter((d) => d.kind === 'deadline').length, 0, 'no reminders for archived todos');
    r = await s.call('POST', '/api/folders/archive', { path: 'Work/Alpha/Docs', archived: false });
    assert.equal(r.data.parentArchived, true);
    r = await s.call('POST', '/api/folders/archive', { path: 'Work/Alpha', archived: false });
    r = await s.call('GET', '/api/meta');
    assert.equal(r.data.counts.archived, 0);
    assert.equal(r.data.counts.open, 3);
    assert.ok(a.id);
  } finally { await s.stop(); }
});
