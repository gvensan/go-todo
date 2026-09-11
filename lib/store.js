'use strict';

// File-backed store for todos, folders, settings and the reminder ledger.
// Atomic writes (tmp + rename), .bak of the previous version, daily backups,
// and hot reload when the files change on disk. Same model as Golinks.

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { normalizeFolder, isWithin } = require('./folders');

const ROOT = path.resolve(__dirname, '..');
// TODONOW_HOME lets personal data live outside the code folder (default: the code folder).
const HOME_DIR = process.env.TODONOW_HOME ? path.resolve(process.env.TODONOW_HOME) : ROOT;
const DATA_DIR = path.join(HOME_DIR, 'data');
const DEFAULTS_DIR = path.join(ROOT, 'data', 'defaults');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = 14;

const FILES = {
  todos: 'todos.json',
  folders: 'folders.json',
  settings: 'settings.json',
  reminderState: 'reminder-state.json',
};

const DEFAULTS = {
  todos: () => [],
  folders: () => [],
  settings: () => ({
    port: 7778,
    theme: 'system',
    weekStartsOn: 1,
    trashDays: 30,
    dailyReminder: { enabled: true, time: '09:00' },
    deadlineReminder: { enabled: true, minutesBefore: 60 },
    quietHours: { enabled: false, start: '22:00', end: '07:00' },
    setup: {},
  }),
  reminderState: () => ({ sent: {} }),
};

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

class Store extends EventEmitter {
  constructor(dataDir = DATA_DIR) {
    super();
    this.dataDir = dataDir;
    this.backupDir = path.join(dataDir, 'backups');
    this.data = {};
    this.lastWritten = {};
    this.watcher = null;
    this.reloadTimer = null;
  }

  filePath(name) { return path.join(this.dataDir, FILES[name]); }

  loadAll() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    for (const name of Object.keys(FILES)) this.load(name);
    return this.data;
  }

  load(name) {
    const file = this.filePath(name);
    let value;
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      try {
        value = JSON.parse(text);
        this.lastWritten[name] = text;
      } catch (err) {
        // Corrupt file: keep the in-memory copy if we have one, otherwise the default.
        console.error(`[store] ${FILES[name]} is not valid JSON, keeping previous state: ${err.message}`);
        value = this.data[name] !== undefined ? this.data[name] : DEFAULTS[name]();
      }
    } else {
      // First run: copy the shipped default if there is one.
      const shipped = path.join(DEFAULTS_DIR, FILES[name]);
      value = DEFAULTS[name]();
      if (fs.existsSync(shipped)) {
        try { value = JSON.parse(fs.readFileSync(shipped, 'utf8')); } catch { /* keep default */ }
      }
      this.write(name, value);
    }
    if (name === 'settings') value = mergeSettings(value);
    if (name === 'todos' && !Array.isArray(value)) value = [];
    if (name === 'folders' && !Array.isArray(value)) value = [];
    if (name === 'reminderState' && (!value || typeof value !== 'object' || Array.isArray(value))) value = DEFAULTS.reminderState();
    if (name === 'reminderState' && (!value.sent || typeof value.sent !== 'object')) value.sent = {};
    this.data[name] = value;
    return value;
  }

  write(name, value) {
    const file = this.filePath(name);
    const text = JSON.stringify(value, null, 2) + '\n';
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (fs.existsSync(file)) {
      try { fs.copyFileSync(file, file + '.bak'); } catch { /* best effort */ }
    }
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    this.lastWritten[name] = text;
    if (name === 'todos') this.dailyBackup(text);
  }

  save(name) {
    this.write(name, this.data[name]);
    this.emit('saved', name);
  }

  dailyBackup(text) {
    try {
      fs.mkdirSync(this.backupDir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      const file = path.join(this.backupDir, `todos-${day}.json`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, text);
      const all = fs.readdirSync(this.backupDir).filter((f) => /^todos-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      while (all.length > BACKUP_KEEP) fs.unlinkSync(path.join(this.backupDir, all.shift()));
    } catch (err) {
      console.error('[store] backup failed:', err.message);
    }
  }

  // Watch the data directory. Reload files that changed on disk and were not written by us.
  watch() {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.dataDir, { persistent: false }, (_event, filename) => {
        if (!filename) return;
        const name = Object.keys(FILES).find((key) => FILES[key] === filename);
        if (!name) return;
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.reloadIfChanged(name), 300);
      });
    } catch (err) {
      console.error('[store] watch failed:', err.message);
    }
  }

  reloadIfChanged(name) {
    const file = this.filePath(name);
    if (!fs.existsSync(file)) return;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    if (text === this.lastWritten[name]) return;
    try { JSON.parse(text); } catch { return; } // half-written file, wait for the next event
    this.load(name);
    console.log(`[store] reloaded ${FILES[name]} from disk`);
    this.emit('reloaded', name);
  }

  close() {
    if (this.watcher) this.watcher.close();
    this.watcher = null;
  }

  // ---- todo helpers ----

  // Every stored todo, including completed ones and the trash.
  get todos() { return this.data.todos; }
  get folders() { return this.data.folders; }
  get settings() { return this.data.settings; }
  get reminderState() { return this.data.reminderState; }
  // Open todos: not completed, not in the trash. Views, counts and reminders work on these.
  get active() { return this.todos.filter((todo) => !todo.deletedAt && !todo.completedAt); }
  get completed() { return this.todos.filter((todo) => !todo.deletedAt && todo.completedAt); }
  // Soft-deleted todos (deletedAt holds the time they were trashed).
  get trashed() { return this.todos.filter((todo) => todo.deletedAt); }
  // Everything that is not in the trash.
  get live() { return this.todos.filter((todo) => !todo.deletedAt); }
  findTodo(id) { return this.todos.find((todo) => todo.id === id) || null; }

  // ---- archived folders: a finished project drops out of every view, count, picker and reminder ----
  get archivedFolders() { return this.folders.filter((rec) => rec && rec.archived).map((rec) => rec.path); }
  // True for a folder path (or a todo, by its folder) that is archived itself or sits inside an archived folder.
  isArchived(pathOrTodo) {
    const p = typeof pathOrTodo === 'string' ? pathOrTodo : pathOrTodo && pathOrTodo.folder;
    if (!p) return false;
    return this.archivedFolders.some((a) => isWithin(p, a));
  }

  newId() {
    const ids = new Set(this.todos.map((todo) => todo.id));
    for (;;) {
      let id = '';
      for (let i = 0; i < 6; i += 1) id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
      if (!ids.has(id)) return id;
    }
  }

  // ---- folder helpers ----

  // The stored record for a folder path (case-insensitive), or null.
  findFolder(folder) {
    const normalized = normalizeFolder(folder);
    if (!normalized) return null;
    const key = normalized.toLowerCase();
    return this.folders.find((item) => item && String(item.path).toLowerCase() === key) || null;
  }

  // Remember a folder (and its ancestors) so it exists even without todos. Returns the
  // normalized path. Does not save; callers save('folders') after a batch.
  ensureFolder(folder) {
    const normalized = normalizeFolder(folder);
    if (!normalized) return null;
    const parts = normalized.split('/');
    for (let index = 1; index <= parts.length; index += 1) {
      const current = parts.slice(0, index).join('/');
      if (!this.findFolder(current)) this.folders.push({ path: current, createdAt: new Date().toISOString() });
    }
    return this.findFolder(normalized).path;
  }
}

function mergeSettings(value) {
  const base = DEFAULTS.settings();
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...base,
    ...input,
    dailyReminder: { ...base.dailyReminder, ...(input.dailyReminder || {}) },
    deadlineReminder: { ...base.deadlineReminder, ...(input.deadlineReminder || {}) },
    quietHours: { ...base.quietHours, ...(input.quietHours || {}) },
    setup: { ...base.setup, ...(input.setup || {}) },
  };
}

module.exports = { Store, ROOT, HOME_DIR, DATA_DIR, DEFAULTS_DIR, BACKUP_DIR, DEFAULTS, FILES, mergeSettings };
