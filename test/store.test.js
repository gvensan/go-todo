'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, mergeSettings } = require('../lib/store');

test('store creates defaults, folders, atomic data, and backups', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todonow-store-'));
  try {
    const store = new Store(dir);
    store.loadAll();
    assert.equal(store.settings.port, 7778);
    assert.equal(store.settings.theme, 'system');
    assert.deepEqual(store.todos, []);
    assert.equal(store.ensureFolder('People / Alice'), 'People/Alice');
    assert.deepEqual(store.folders.map((folder) => folder.path), ['People', 'People/Alice']);
    assert.equal(store.ensureFolder('people/alice'), 'People/Alice', 'lookups are case-insensitive and keep the stored spelling');
    store.todos.push({ id: 'abc123', title: 'Ask Alice', folder: 'People/Alice' });
    store.save('folders');
    store.save('todos');
    store.save('todos');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'todos.json'), 'utf8'))[0].title, 'Ask Alice');
    assert.ok(fs.readdirSync(path.join(dir, 'backups')).some((name) => name.startsWith('todos-')));
    assert.ok(fs.existsSync(path.join(dir, 'todos.json.bak')));
    assert.equal(store.active.length, 1);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt file keeps the last good state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todonow-store-'));
  try {
    const store = new Store(dir);
    store.loadAll();
    store.todos.push({ id: 'abc123', title: 'Keep' });
    store.save('todos');
    fs.writeFileSync(path.join(dir, 'todos.json'), '{ not json');
    store.load('todos');
    assert.equal(store.todos.length, 1);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settings merge fills in every default', () => {
  const merged = mergeSettings({ theme: 'light', quietHours: { enabled: true } });
  assert.equal(merged.theme, 'light');
  assert.equal(merged.quietHours.enabled, true);
  assert.equal(merged.quietHours.start, '22:00');
  assert.equal(merged.dailyReminder.time, '09:00');
  assert.equal(mergeSettings(null).port, 7778);
});
