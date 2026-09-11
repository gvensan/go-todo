'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const folders = require('../lib/folders');
const { searchTodos, parseQuery, isOverdue } = require('../lib/search');

const now = new Date('2026-09-10T12:00:00+05:30');
const todos = [
  { title: 'Ask Alice about launch', folder: 'People/Alice', tags: ['phone'], priority: 'high', dueAt: '2026-09-10T10:00:00+05:30', status: 'open' },
  { title: 'File receipts', folder: 'Areas/Finance', tags: ['admin'], priority: 'low', dueAt: '2026-09-11T10:00:00+05:30', status: 'open' },
  { title: 'Read the book', folder: null, tags: [], priority: 'none', plannedDate: '2026-09-10', status: 'someday', notes: 'library copy' },
];

test('folder paths normalize, nest, move and list with ancestors', () => {
  assert.equal(folders.normalizeFolder(' People / Alice / '), 'People/Alice');
  assert.equal(folders.normalizeFolder('a//b\\c'), 'a/b/c');
  assert.equal(folders.normalizeFolder('  '), null);
  assert.equal(folders.isWithin('People/Alice', 'people'), true);
  assert.equal(folders.isWithin('Peoples', 'People'), false);
  assert.equal(folders.rebase('People/Alice/Work', 'People/Alice', 'Contacts/Alice'), 'Contacts/Alice/Work');
  assert.equal(folders.rebase('Areas/Home', 'People', 'Contacts'), 'Areas/Home');
  assert.equal(folders.parentOf('People/Alice'), 'People');
  const list = folders.listFolders(todos, [{ path: 'Work/Project Alpha/Docs' }]);
  assert.deepEqual(list.map((f) => f.path), ['Areas', 'Areas/Finance', 'People', 'People/Alice', 'Work', 'Work/Project Alpha', 'Work/Project Alpha/Docs']);
  const people = list.find((f) => f.path === 'People');
  assert.equal(people.count, 0);
  assert.equal(people.total, 1);
  assert.equal(list.find((f) => f.path === 'Work/Project Alpha/Docs').depth, 2);
});

test('search supports text and operators', () => {
  assert.equal(searchTodos(todos, 'alice').length, 1);
  assert.equal(searchTodos(todos, 'library').length, 1, 'notes are searched');
  assert.equal(searchTodos(todos, 'in:people tag:phone priority:high', now).length, 1);
  assert.equal(searchTodos(todos, 'due:tomorrow', now)[0].title, 'File receipts');
  assert.equal(searchTodos(todos, 'due:week', now).length, 2);
  assert.equal(searchTodos(todos, 'planned:today', now)[0].title, 'Read the book');
  assert.equal(searchTodos(todos, 'is:overdue', now)[0].title, 'Ask Alice about launch');
  assert.equal(searchTodos(todos, 'is:someday', now).length, 1);
  assert.equal(searchTodos(todos, 'is:unfiled', now).length, 1);
  assert.equal(searchTodos(todos, 'nothing:here', now).length, 0, 'an unknown operator is a plain word');
  assert.deepEqual(parseQuery('Alice in:people due:today').terms, ['alice']);
  assert.equal(isOverdue(todos[0], now), true);
  assert.equal(isOverdue({ ...todos[0], completedAt: '2026-09-10T09:00:00Z' }, now), false);
});
