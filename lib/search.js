'use strict';

const { isWithin } = require('./folders');

// YYYY-MM-DD in local time.
function localDay(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Splits a query into operator tokens (in:, tag:, priority:, is:, due:, planned:) and
// plain words. Every token has to match. Returns { todos, terms } where terms are the
// plain words, so the UI can highlight them.
function parseQuery(query) {
  const tokens = String(query || '').trim().split(/\s+/).filter(Boolean);
  const terms = [];
  const ops = [];
  for (const token of tokens) {
    const colon = token.indexOf(':');
    const operator = colon > 0 ? token.slice(0, colon).toLowerCase() : '';
    if (OPERATORS.has(operator) && token.length > colon + 1) ops.push({ operator, value: token.slice(colon + 1).toLowerCase() });
    else terms.push(token.toLowerCase());
  }
  return { terms, ops };
}

const OPERATORS = new Set(['in', 'folder', 'tag', 'priority', 'is', 'due', 'planned']);

function searchTodos(todos, query, now = new Date()) {
  const { terms, ops } = parseQuery(query);
  if (!terms.length && !ops.length) return todos.slice();
  return todos.filter((todo) => ops.every((op) => matchOperator(todo, op.operator, op.value, now)) && terms.every((term) => matchText(todo, term)));
}

function matchText(todo, term) {
  const haystack = [todo.title, todo.notes, todo.url, todo.folder, todo.waitingFor, ...(todo.tags || [])].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(term);
}

function matchOperator(todo, operator, value, now) {
  if (operator === 'in' || operator === 'folder') return isWithin(todo.folder, value);
  if (operator === 'tag') return (todo.tags || []).some((tag) => String(tag).toLowerCase().includes(value));
  if (operator === 'priority') return String(todo.priority || 'none').toLowerCase() === value;
  if (operator === 'is') return matchStatus(todo, value, now);
  if (operator === 'due') return matchDay(todo.dueAt ? localDay(new Date(todo.dueAt)) : null, value, now, () => isOverdue(todo, now));
  if (operator === 'planned') return matchDay(todo.plannedDate || null, value, now, () => Boolean(todo.plannedDate) && todo.plannedDate < localDay(now));
  return false;
}

function matchStatus(todo, value, now) {
  const open = !todo.completedAt && !todo.deletedAt;
  if (value === 'open') return open;
  if (value === 'completed' || value === 'done') return Boolean(todo.completedAt) && !todo.deletedAt;
  if (value === 'trash' || value === 'deleted') return Boolean(todo.deletedAt);
  if (value === 'waiting') return todo.status === 'waiting' && open;
  if (value === 'someday') return todo.status === 'someday' && open;
  if (value === 'now') return Number.isFinite(todo.nowOrder) && open;
  if (value === 'overdue') return isOverdue(todo, now);
  if (value === 'unfiled') return !todo.folder;
  if (value === 'recurring') return Boolean(todo.recurrence);
  if (value === 'high') return todo.priority === 'high';
  return false;
}

function matchDay(day, value, now, overdue) {
  if (!day) return false;
  const today = localDay(now);
  if (value === 'today') return day === today;
  if (value === 'overdue') return overdue();
  if (value === 'tomorrow') {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return day === localDay(tomorrow);
  }
  if (value === 'week') {
    const end = new Date(now);
    end.setDate(end.getDate() + 7);
    return day >= today && day <= localDay(end);
  }
  return day === value;
}

function isOverdue(todo, now = new Date()) {
  return Boolean(todo.dueAt && !todo.completedAt && !todo.deletedAt && Date.parse(todo.dueAt) < now.getTime());
}

module.exports = { searchTodos, parseQuery, localDay, isOverdue };
