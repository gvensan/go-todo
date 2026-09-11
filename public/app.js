/* TodoNow web UI. Vanilla JS, no build step. Same shell and widgets as Golinks. */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const VIEWS = ['all', 'inbox', 'today', 'now', 'upcoming', 'waiting', 'someday', 'unfiled', 'completed', 'trash'];
  const VIEW_LABELS = { all: 'All todos', inbox: 'Inbox', today: 'Today', now: 'Now', upcoming: 'Upcoming', waiting: 'Waiting', someday: 'Someday', unfiled: 'Unfiled', completed: 'Completed', trash: 'Trash' };
  const SETTINGS_TABS = ['general', 'setup', 'data'];

  const state = {
    route: { page: 'todos', view: 'today', folder: null, tag: null, todoId: null, tab: null },
    q: '',
    layout: 'list',
    results: [],
    total: 0,
    terms: [],
    selected: 0,
    meta: null,
    editing: null, // the todo open in the drawer; { id: null } while creating one
    showAllTags: false,
    tagFilter: '',
    folderFilter: '',
    expanded: new Set(),
    collapsed: new Set(), // sidebar sections folded away: 'folders', 'tags', 'done'
    sideWidth: null, // px chosen by dragging the divider; null means size to content
    down: false,
    sel: new Set(), // ids picked for a bulk action (checkbox, Shift+click, X)
    anchor: null, // index of the last picked row, for Shift+click ranges
  };
  const TOP_TAGS = 12;
  try { state.layout = localStorage.getItem('todonow.layout') || 'list'; } catch { /* ignore */ }
  try { state.expanded = new Set(JSON.parse(localStorage.getItem('todonow.folders.open') || '[]')); } catch { /* ignore */ }
  try { state.collapsed = new Set(JSON.parse(localStorage.getItem('todonow.side.collapsed') || '[]')); } catch { /* ignore */ }
  try { const w = Number(localStorage.getItem('todonow.side.width')); if (w) state.sideWidth = w; } catch { /* ignore */ }
  function saveExpanded() { try { localStorage.setItem('todonow.folders.open', JSON.stringify([...state.expanded])); } catch { /* ignore */ } }
  function saveCollapsed() { try { localStorage.setItem('todonow.side.collapsed', JSON.stringify([...state.collapsed])); } catch { /* ignore */ } }

  // ------------------------------------------------------------------ api
  async function api(method, path, body, opts) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      setDown(true);
      throw new Error('service not reachable');
    }
    setDown(false);
    let data = null;
    try { data = await res.json(); } catch { data = {}; }
    if (!res.ok && !(opts && opts.allow && opts.allow.includes(res.status))) {
      const e = new Error(data.error || res.statusText);
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  }

  function setDown(down) {
    if (down === state.down) return;
    state.down = down;
    const b = $('#banner');
    b.classList.toggle('hidden', !down);
    b.innerHTML = down ? 'Service not reachable. Start it with <code>bin/todonow start</code> and reload.' : '';
  }

  // ------------------------------------------------------------------ helpers
  // action: { label, onClick } adds a button (used for Undo after a delete or completion).
  function toast(msg, ms, action) {
    const t = $('#toast');
    t.textContent = msg;
    if (action) {
      const b = document.createElement('button');
      b.textContent = action.label;
      b.onclick = () => { t.classList.remove('show'); clearTimeout(toast.timer); action.onClick(); };
      t.appendChild(b);
    }
    t.classList.toggle('with-action', Boolean(action));
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), ms || (action ? 7000 : 2200));
  }

  function rel(iso) {
    if (!iso) return 'never';
    const d = (Date.now() - Date.parse(iso)) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    if (d < 86400 * 30) return Math.floor(d / 86400) + 'd ago';
    if (d < 86400 * 365) return Math.floor(d / 86400 / 30) + 'mo ago';
    return Math.floor(d / 86400 / 365) + 'y ago';
  }

  // Local YYYY-MM-DD for a Date (or today).
  function dayKey(date) {
    const d = date || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function shiftDay(days) { const d = new Date(); d.setDate(d.getDate() + days); return dayKey(d); }
  // "Today", "Tomorrow", "Yesterday", else "Mon 15 Sep" (with the year when it differs).
  function dayLabel(day) {
    if (!day) return '';
    if (day === dayKey()) return 'Today';
    if (day === shiftDay(1)) return 'Tomorrow';
    if (day === shiftDay(-1)) return 'Yesterday';
    const d = new Date(day + 'T12:00:00');
    const opts = { weekday: 'short', day: 'numeric', month: 'short' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return new Intl.DateTimeFormat(undefined, opts).format(d);
  }
  function timeLabel(iso) { return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso)); }
  function dueLabel(todo) { return todo.dueAt ? dayLabel(dayKey(new Date(todo.dueAt))) + ', ' + timeLabel(todo.dueAt) : ''; }
  function dueClass(todo) {
    if (!todo.dueAt) return '';
    if (todo.overdue) return 'overdue';
    return dayKey(new Date(todo.dueAt)) === dayKey() ? 'today' : '';
  }
  // datetime-local value <-> ISO string
  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const shifted = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return shifted.toISOString().slice(0, 16);
  }
  function fromLocalInput(value) { return value ? new Date(value).toISOString() : null; }

  function hl(text, terms) {
    const safe = esc(text);
    if (!terms || !terms.length) return safe;
    const words = terms.filter((t) => t.length > 1);
    if (!words.length) return safe;
    const re = new RegExp('(' + words.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
    return safe.replace(re, '<mark>$1</mark>');
  }

  function host(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
  }

  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const firstLine = (s) => { const src = String(s || '').trim(); return src ? src.split(/\r?\n/).find((l) => l.trim()) || '' : ''; };

  // In-app modal replacing the browser's prompt/confirm. Resolves with the entered text
  // (or true for a plain confirm) and null when cancelled. opts: { title, message, value,
  // placeholder, help, ok, danger, list (datalist values), input (false for confirm only) }.
  function dialog(opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const prev = document.activeElement;
      const withInput = opts.input !== false;
      const withCheck = Boolean(opts.checkbox);
      const el = document.createElement('div');
      el.id = 'modal';
      el.innerHTML = '<div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="modalTitle">' +
        '<h3 id="modalTitle">' + esc(opts.title || '') + '</h3>' +
        (opts.message ? '<p class="modal-msg">' + opts.message + '</p>' : '') +
        (withInput ? '<div class="field"><input type="text" id="modalInput" value="' + esc(opts.value || '') + '" placeholder="' + esc(opts.placeholder || '') + '" autocomplete="off" spellcheck="false"' + (opts.list ? ' list="modalList"' : '') + '>' +
          (opts.list ? '<datalist id="modalList">' + opts.list.map((v) => '<option value="' + esc(v) + '">').join('') + '</datalist>' : '') +
          (opts.help ? '<div class="help">' + opts.help + '</div>' : '') + '</div>' : '') +
        (withCheck ? '<label class="modal-check"><input type="checkbox" id="modalCheck"' + (opts.checked ? ' checked' : '') + '> ' + opts.checkbox + '</label>' : '') +
        '<div class="actions modal-actions"><button class="btn" id="modalCancel">Cancel</button><button class="btn ' + (opts.danger ? 'danger' : 'primary') + '" id="modalOk">' + esc(opts.ok || 'OK') + '</button></div></div>';
      document.body.appendChild(el);
      const input = $('#modalInput', el);
      const done = (value) => {
        el.remove();
        if (prev && prev.focus && document.body.contains(prev)) prev.focus();
        resolve(value);
      };
      const check = $('#modalCheck', el);
      const ok = () => {
        if (!withInput) return done(withCheck ? { ok: true, checked: check.checked } : true);
        const v = input.value.trim();
        const bad = (!v && !opts.allowEmpty) || (opts.validate && opts.validate(v));
        if (bad) { input.focus(); input.classList.add('invalid'); if (typeof bad === 'string') toast(bad, 2500); return; }
        done(withCheck ? { value: v, checked: check.checked } : v);
      };
      $('#modalOk', el).onclick = ok;
      $('#modalCancel', el).onclick = () => done(null);
      el.addEventListener('mousedown', (e) => { if (e.target === el) done(null); });
      // Keys stay inside the dialog so the app shortcuts (Esc closes drawer, E edits) do not fire.
      el.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
        else if (e.key === 'Enter' && !(e.target.tagName === 'BUTTON' && e.target.id === 'modalCancel')) { e.preventDefault(); ok(); }
      });
      if (input) input.addEventListener('input', () => input.classList.remove('invalid'));
      requestAnimationFrame(() => { el.classList.add('show'); const f = input || $('#modalOk', el); f.focus(); if (input) input.select(); });
    });
  }

  function lbl(text, tipKey) {
    return '<label>' + text + (tipKey ? '<span class="info" tabindex="0" data-tip="' + esc(TIPS[tipKey]) + '">i</span>' : '') + '</label>';
  }
  const TIPS = {
    title: 'What needs doing. Shown in every list and matched first by search.',
    folder: 'The one place this todo lives: a person, an area or a project. Use / for nesting, for example People/Alice. Typing a new path creates the folder. A folder view lists todos from its subfolders too.',
    due: 'A real deadline with a time. Todos due today or overdue show in Today, later ones in Upcoming. A notification fires before it (see Reminder).',
    planned: 'The day you intend to work on it, without a hard deadline. Puts the todo in Today on that day.',
    status: 'Open is normal. Waiting parks it until someone or something else moves (Waiting view). Someday keeps an idea without a commitment (Someday view).',
    waiting: 'Who or what you are waiting for, shown with the todo.',
    priority: 'High priority shows a red dot and sorts first among todos with the same date.',
    estimate: 'Rough duration, shown with the todo. Handy when pulling work into Now.',
    now: 'A short, deliberate queue for your current focus. The Now view lists these in the order you added them.',
    repeat: 'When you complete this todo, the next occurrence is created with its deadline or planned day moved forward.',
    reminder: 'When the deadline notification fires. Default follows Settings. Off silences this todo only.',
    tags: 'Optional cross-cutting labels for filtering (click a tag in the sidebar) and search (tag:name). Type a tag and press Enter or comma.',
    notes: 'Anything useful: context, links, next steps. Searched too.',
    url: 'A web page this todo is about. The bookmarklet fills it in; the row shows the site as a link.',
  };

  function folderHash(path) { return '#/folder/' + path.split('/').map(encodeURIComponent).join('/'); }
  function folderSegments(path) { return path ? path.split('/') : []; }

  // ------------------------------------------------------------------ routing
  function parseHash() {
    const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
    const r = { page: 'todos', view: 'today', folder: null, tag: null, todoId: null, tab: null };
    const [head, ...rest] = h.split('/');
    const val = rest.join('/');
    if (!head) return r;
    if (VIEWS.includes(head)) r.view = head;
    else if (head === 'folder' && val) { r.view = 'open'; r.folder = val.replace(/^\/+|\/+$/g, ''); }
    else if (head === 'tag' && val) { r.view = 'open'; r.tag = val; }
    else if (head === 'todo' && val) { r.view = 'all'; r.todoId = val; }
    else if (head === 'settings') { r.page = 'settings'; r.tab = SETTINGS_TABS.includes(rest[0]) ? rest[0] : 'general'; }
    return r;
  }

  function go(hash) {
    if (location.hash === hash) onRoute(); else location.hash = hash;
  }

  async function onRoute() {
    state.route = parseHash();
    clearSelection(false);
    if (state.route.page !== 'todos' && $('#drawer').classList.contains('open')) closeDrawer();
    if (state.route.page === 'todos') {
      $('.top').classList.remove('hidden');
      document.title = pageTitle() + ' | TodoNow';
      await doSearch();
      if (state.route.todoId) {
        const todo = state.results.find((t) => t.id === state.route.todoId) || (await api('GET', '/api/todos/' + encodeURIComponent(state.route.todoId)).then((r) => r.todo).catch(() => null));
        if (todo) openDrawer(todo); else toast('That todo no longer exists', 3000);
      }
    } else renderSettingsPage(state.route.tab);
    renderSidebar();
    $('#fab').classList.toggle('hidden', state.route.page !== 'todos' || inTrash());
  }

  function pageTitle() {
    const r = state.route;
    return r.folder ? r.folder : r.tag ? '#' + r.tag : VIEW_LABELS[r.view] || 'Todos';
  }

  // ------------------------------------------------------------------ sidebar
  async function loadMeta() {
    try { state.meta = await api('GET', '/api/meta'); applyTheme(state.meta.settings.theme); } catch { /* banner shown */ }
    return state.meta;
  }

  // The system scheme applies unless Settings pins light or dark.
  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }

  // Sidebar icons: 16px line icons on a 16-unit grid, stroke follows the text colour.
  const svg = (paths, extra) => '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"' + (extra || '') + '>' + paths + '</svg>';
  const NAV_ICONS = {
    all: svg('<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>'),
    inbox: svg('<path d="M2.5 3.5h11v9h-11z"/><path d="M2.5 9h3l1.2 1.6h2.6L10.5 9h3"/>'),
    today: svg('<circle cx="8" cy="8" r="3"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>'),
    now: svg('<circle cx="8" cy="8" r="5.75"/><circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/>'),
    upcoming: svg('<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M5 2v3M11 2v3M2.5 7h11M5.5 10h2M9.5 10h1.5"/>'),
    waiting: svg('<path d="M4.5 2.5h7M4.5 13.5h7M5 2.5v2.2c0 1.6 3 2.6 3 3.3s-3 1.7-3 3.3v2.2M11 2.5v2.2c0 1.6-3 2.6-3 3.3s3 1.7 3 3.3v2.2"/>'),
    someday: svg('<path d="M8 2.3l1.8 3.7 4 .55-2.9 2.8.7 4L8 11.4l-3.6 1.95.7-4-2.9-2.8 4-.55z"/>'),
    unfiled: svg('<rect x="2.5" y="3.5" width="11" height="9" rx="1.5" stroke-dasharray="2.2 1.6"/>'),
    completed: svg('<circle cx="8" cy="8" r="5.75"/><path d="M5.4 8.2 7.2 10l3.4-3.8"/>'),
    trash: svg('<path d="M3 4.5h10M6.5 4.5v-1a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8M6.8 7v4M9.2 7v4"/>'),
    setup: svg('<circle cx="8" cy="8" r="5.75"/><path d="M5.4 8.2 7.2 10l3.4-3.8"/>'),
    settings: svg('<circle cx="8" cy="8" r="2.1"/><path d="M8 1.9v1.6M8 12.5v1.6M1.9 8h1.6M12.5 8h1.6M3.7 3.7l1.1 1.1M11.2 11.2l1.1 1.1M3.7 12.3l1.1-1.1M11.2 4.8l1.1-1.1"/>'),
    data: svg('<path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7M3 12.5h10"/>'),
    restart: svg('<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3"/>'),
    clock: svg('<circle cx="8" cy="8" r="5.75"/><path d="M8 4.75V8l2.25 1.5"/>'),
    repeat: svg('<path d="M3 6.5a5 5 0 0 1 8.6-2.1M13 9.5a5 5 0 0 1-8.6 2.1M11.5 2v2.6h-2.6M4.5 14v-2.6h2.6"/>'),
    plus: svg('<path d="M8 3v10M3 8h10"/>'),
    link: svg('<path d="M6.5 9.5 9.5 6.5M7 4.5l1.2-1.2a2.4 2.4 0 0 1 3.4 3.4L10.4 8M9 11.5l-1.2 1.2a2.4 2.4 0 0 1-3.4-3.4L5.6 8"/>'),
    bookmark: svg('<path d="M4 2.5h8v11l-4-2.6-4 2.6z"/>'),
  };

  function navItem(hash, label, count, ico, active, extra) {
    return '<a href="' + hash + '" class="' + (active ? 'active' : '') + '"' + (extra || '') + '><span class="ico">' + (ico || '') + '</span><span class="label">' + esc(label) + '</span>' + (count != null && count !== 0 ? '<span class="n">' + count + '</span>' : '') + '</a>';
  }

  // Folder and chevron icons come from folderpick.js so the sidebar and the picker match.
  const FOLDER_ICO = window.FOLDER_ICONS.closed;
  const FOLDER_OPEN_ICO = window.FOLDER_ICONS.open;
  const CHEV_RIGHT = window.FOLDER_ICONS.chevRight;
  const CHEV_DOWN = window.FOLDER_ICONS.chevDown;

  function renderSidebar() {
    const m = state.meta;
    const r = state.route;
    const isTodos = r.page === 'todos';
    const c = m ? m.counts : {};
    const viewActive = (v) => isTodos && !r.folder && !r.tag && !r.todoId && r.view === v;
    let html = '<div class="brand"><img src="/favicon.svg" alt=""> TodoNow <span class="ver">' + (m ? 'v' + esc(m.version) : '') + '</span></div>';
    html += '<div class="nav">';
    html += navItem('#/all', 'All todos', c.open, NAV_ICONS.all, viewActive('all'));
    html += navItem('#/inbox', 'Inbox', c.inbox, NAV_ICONS.inbox, viewActive('inbox'));
    html += navItem('#/today', 'Today', c.today, NAV_ICONS.today, viewActive('today')).replace('<span class="n">', c.overdue ? '<span class="n overdue" title="' + plural(c.overdue, 'overdue todo') + '">' : '<span class="n">');
    html += navItem('#/now', 'Now', c.now, NAV_ICONS.now, viewActive('now'));
    html += navItem('#/upcoming', 'Upcoming', c.upcoming, NAV_ICONS.upcoming, viewActive('upcoming'));
    html += navItem('#/waiting', 'Waiting', c.waiting, NAV_ICONS.waiting, viewActive('waiting'));
    html += navItem('#/someday', 'Someday', c.someday, NAV_ICONS.someday, viewActive('someday'));
    html += '</div>';

    // Section header: the caret and title fold the section; the buttons after it are actions.
    const section = (key, title, count, actions) => {
      const open = !state.collapsed.has(key);
      return '<h4 class="sec' + (open ? ' open' : '') + '"><button class="sec-toggle" data-sec="' + key + '" title="' + (open ? 'Collapse' : 'Expand') + ' ' + title.toLowerCase() + '" aria-expanded="' + open + '"><span class="car">' + (open ? '&#9662;' : '&#9656;') + '</span>' + title + (count && !open ? '<span class="cnt">' + count + '</span>' : '') + '</button><span class="sec-acts">' + (open ? actions : '') + '</span></h4>';
    };

    const folderCount = m ? m.folders.length : 0;
    const anyOpen = m && m.folders.some((f) => state.expanded.has(f.path.toLowerCase()));
    const anyParent = m && m.folders.some((f) => f.depth > 0);
    html += section('folders', 'Folders', folderCount,
      (anyParent ? '<button id="treeAll" title="' + (anyOpen ? 'Collapse every folder' : 'Expand every folder') + '">' + (anyOpen ? 'collapse all' : 'expand all') + '</button>' : '') +
      '<button id="newFolder" title="New folder">+ new</button>');
    if (!state.collapsed.has('folders')) {
      if (folderCount) {
        if (folderCount > 6) html += '<div class="side-filter"><input type="text" id="folderFilter" placeholder="Filter folders" value="' + esc(state.folderFilter) + '" autocomplete="off" spellcheck="false"></div>';
        html += '<div class="tree nav" id="folderTree"></div>';
      } else html += '<div class="side-note">No folders yet. Create one here or type a folder like <code>People/Alice</code> when editing a todo.</div>';
      if (folderCount) html += '<div class="nav">' + navItem('#/unfiled', 'Unfiled', c.unfiled, NAV_ICONS.unfiled, viewActive('unfiled'), ' data-drop-folder=""') + '</div>';
    }

    const tagCount = m ? m.tags.length : 0;
    html += section('tags', 'Tags', tagCount, tagCount > TOP_TAGS ? '<button id="toggleTags">' + (state.showAllTags ? 'top ' + TOP_TAGS : 'all ' + tagCount) + '</button>' : '');
    if (!state.collapsed.has('tags')) {
      if (tagCount) {
        if (tagCount > 6) html += '<div class="side-filter"><input type="text" id="tagFilter" placeholder="Filter tags" value="' + esc(state.tagFilter) + '" autocomplete="off" spellcheck="false"></div>';
        html += '<div class="badges" id="tagList"></div>';
      } else html += '<div class="side-note">No tags yet. Add them in the Tags field of a todo.</div>';
    }

    html += section('done', 'Done', (c.completed || 0) + (c.trash || 0), '');
    if (!state.collapsed.has('done')) {
      html += '<div class="nav">';
      html += navItem('#/completed', 'Completed', c.completed, NAV_ICONS.completed, viewActive('completed'));
      html += navItem('#/trash', 'Trash', c.trash, NAV_ICONS.trash, viewActive('trash'));
      html += '</div>';
    }

    html += '<div class="spacer"></div><div class="nav foot">';
    if (m && m.restartNeeded) html += '<a href="#/settings" class="restart-note" title="The code on disk is newer than the running service">' + NAV_ICONS.restart + ' restart needed</a>';
    // The setup checklist lives under Settings; the tab shows a dot while steps are left.
    html += navItem('#/settings', 'Settings', null, NAV_ICONS.settings, r.page === 'settings');
    html += '</div>';
    $('#side').innerHTML = html;
    renderTagList();
    renderFolderTree();
    applySideWidth();

    $$('[data-sec]').forEach((b) => (b.onclick = () => {
      const k = b.dataset.sec;
      if (state.collapsed.has(k)) state.collapsed.delete(k); else state.collapsed.add(k);
      saveCollapsed();
      renderSidebar();
    }));
    const ta = $('#treeAll');
    if (ta) ta.onclick = () => {
      if (anyOpen) state.expanded.clear();
      else for (const f of m.folders) state.expanded.add(f.path.toLowerCase());
      saveExpanded();
      renderSidebar();
    };
    const tt = $('#toggleTags');
    if (tt) tt.onclick = () => { state.showAllTags = !state.showAllTags; state.tagFilter = ''; renderSidebar(); };
    const tf = $('#tagFilter');
    if (tf) tf.oninput = () => { state.tagFilter = tf.value; renderTagList(); };
    const ff = $('#folderFilter');
    if (ff) ff.oninput = () => { state.folderFilter = ff.value; renderFolderTree(); applySideWidth(); };
    [tf, ff].forEach((el) => el && el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { el.value = ''; el.oninput(); el.blur(); }
      if (e.key === 'Enter') { const first = $(el === tf ? '#tagList a' : '#folderTree a'); if (first) go(first.getAttribute('href')); }
    }));
    const nf = $('#newFolder');
    if (nf) nf.onclick = () => createFolder(state.route.folder ? state.route.folder + '/' : '');
  }

  // ---- sidebar width: sized to the widest visible folder row unless the user dragged the divider
  const SIDE_MIN = 280, SIDE_MAX = 600, SIDE_DRAG_MIN = 200;
  function measureSide() {
    let need = SIDE_MIN;
    for (const a of $$('#folderTree a')) {
      const label = $('.label', a), n = $('.n', a);
      if (!label) continue;
      const w = (parseFloat(a.style.paddingLeft) || 0) + 16 + 17 + label.scrollWidth + 12 + (n ? n.offsetWidth : 0) + 8 + 20 + 24;
      if (w > need) need = w;
    }
    return Math.round(Math.min(need, SIDE_MAX, window.innerWidth * 0.45));
  }
  function setSideWidth(px) { document.documentElement.style.setProperty('--side-w', px + 'px'); }
  function applySideWidth() { setSideWidth(state.sideWidth || measureSide()); }
  (function initResizer() {
    const rz = $('#sideResizer');
    if (!rz) return;
    let startX = 0, startW = 0;
    const onMove = (e) => {
      const w = Math.max(SIDE_DRAG_MIN, Math.min(SIDE_MAX, startW + (e.clientX - startX)));
      state.sideWidth = w;
      setSideWidth(w);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('resizing');
      rz.classList.remove('dragging');
      try { localStorage.setItem('todonow.side.width', String(state.sideWidth)); } catch { /* ignore */ }
    };
    rz.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = $('#side').getBoundingClientRect().width;
      document.body.classList.add('resizing');
      rz.classList.add('dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    rz.addEventListener('dblclick', () => {
      state.sideWidth = null;
      try { localStorage.removeItem('todonow.side.width'); } catch { /* ignore */ }
      applySideWidth();
      toast('Sidebar width follows the content again');
    });
    window.addEventListener('resize', () => { if (!state.sideWidth) applySideWidth(); });
  })();

  function renderTagList() {
    const el = $('#tagList');
    if (!el || !state.meta) return;
    const f = state.tagFilter.trim().toLowerCase();
    const all = state.meta.tags;
    const list = f ? all.filter((t) => t.name.includes(f)) : state.showAllTags ? all : all.slice(0, TOP_TAGS);
    el.innerHTML = list.map((t) => '<a href="#/tag/' + encodeURIComponent(t.name) + '" class="tag-badge' + (state.route.tag === t.name ? ' active' : '') + '" title="' + plural(t.count, 'open todo') + '">' + (f ? hl(t.name, [f]) : esc(t.name)) + '<span class="n">' + t.count + '</span></a>').join('') +
      (f && !list.length ? '<span class="side-note">No tag matches "' + esc(state.tagFilter) + '"</span>' : '') +
      (!f && !state.showAllTags && all.length > TOP_TAGS ? '<button class="tag-badge more" id="moreTags">+' + (all.length - TOP_TAGS) + ' more</button>' : '');
    const more = $('#moreTags');
    if (more) more.onclick = () => { state.showAllTags = true; renderSidebar(); };
  }

  // Folder tree. Nodes stay collapsed unless opened, an ancestor of the current folder,
  // or matched by the filter (which also reveals their ancestors).
  function renderFolderTree() {
    const el = $('#folderTree');
    if (!el || !state.meta) return;
    const f = state.folderFilter.trim().toLowerCase();
    const active = (state.route.folder || '').toLowerCase();
    const byParent = new Map();
    for (const n of state.meta.folders) {
      const key = (n.parent || '').toLowerCase();
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(n);
    }
    const matches = (n) => !f || n.name.toLowerCase().includes(f);
    const anyMatch = (n) => matches(n) || (byParent.get(n.path.toLowerCase()) || []).some(anyMatch);
    const render = (nodes) => nodes.filter(anyMatch).map((n) => {
      const key = n.path.toLowerCase();
      const kids = byParent.get(key) || [];
      const isActive = active === key;
      const open = kids.length && (f ? kids.some(anyMatch) : state.expanded.has(key) || active.startsWith(key + '/'));
      return '<div class="tnode">' +
        '<a href="' + folderHash(n.path) + '" class="' + (isActive ? 'active' : '') + '" style="padding-left:' + (6 + n.depth * 14) + 'px" title="' + esc(n.path) + '" data-drop-folder="' + esc(n.path) + '" data-drag-folder="' + esc(n.path) + '" draggable="true">' +
        (kids.length ? '<button class="tw" data-tw="' + esc(n.path) + '" title="' + (open ? 'Collapse' : 'Expand') + '" aria-expanded="' + Boolean(open) + '">' + (open ? CHEV_DOWN : CHEV_RIGHT) + '</button>' : '<span class="tw"></span>') +
        (open ? FOLDER_OPEN_ICO : FOLDER_ICO) + '<span class="label">' + (f ? hl(n.name, [f]) : esc(n.name)) + '</span>' + (n.total ? '<span class="n" title="' + n.count + ' here, ' + n.total + ' including subfolders">' + n.total + '</span>' : '') + '</a>' +
        (open ? render(kids) : '') + '</div>';
    }).join('');
    const html = render(byParent.get('') || []);
    el.innerHTML = '<div class="drop-root" data-drop-root="1">' + NAV_ICONS.unfiled + ' Top level</div>' + (html || '<span class="side-note">No folder matches "' + esc(state.folderFilter) + '"</span>');
    $$('[data-tw]', el).forEach((b) => (b.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      const key = b.dataset.tw.toLowerCase();
      if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
      saveExpanded();
      renderSidebar();
    }));
  }

  const folderPaths = () => (state.meta ? state.meta.folders.map((f) => f.path) : []);

  async function createFolder(prefill) {
    const path = await dialog({ title: 'New folder', value: prefill || '', placeholder: 'People/Alice', ok: 'Create', list: folderPaths(), help: 'Use <code>/</code> for nesting, for example <code>Work/Project Alpha</code>. Missing parents are created too.' });
    if (path == null) return;
    try {
      const r = await api('POST', '/api/folders', { path });
      toast(r.existed ? 'Folder already exists' : 'Folder created');
      await loadMeta();
      for (let i = 1; i < folderSegments(r.folder.path).length; i++) state.expanded.add(folderSegments(r.folder.path).slice(0, i).join('/').toLowerCase());
      saveExpanded();
      go(folderHash(r.folder.path));
    } catch (err) { toast(err.message, 4000); }
  }

  async function renameFolder(from) {
    const to = await dialog({ title: 'Rename or move folder', message: 'Current path: <code>' + esc(from) + '</code>', value: from, ok: 'Move', list: folderPaths().filter((p) => p !== from), help: 'Give the full new path. A different parent moves the folder, for example <code>Archive/' + esc(folderSegments(from).pop()) + '</code>. Todos inside and subfolders follow.' });
    if (to == null || to === from) return;
    try {
      const r = await api('POST', '/api/folders/rename', { from, to });
      toast('Moved ' + plural(r.changed, 'todo') + ' to ' + r.to);
      await loadMeta();
      go(folderHash(r.to));
    } catch (err) { toast(err.message, 4000); }
  }

  async function deleteFolder(button, path) {
    if (!button.classList.contains('armed')) {
      button.classList.add('armed');
      button.textContent = 'Confirm: todos move up';
      clearTimeout(button._disarm);
      button._disarm = setTimeout(() => { button.classList.remove('armed'); button.textContent = 'Delete folder'; }, 4000);
      return;
    }
    try {
      const r = await api('POST', '/api/folders/delete', { path });
      toast('Folder deleted, ' + plural(r.moved, 'todo') + (r.parent ? ' moved to ' + r.parent : ' now unfiled'));
      await loadMeta();
      go(r.parent ? folderHash(r.parent) : '#/all');
    } catch (err) { toast(err.message, 4000); }
  }

  // ------------------------------------------------------------------ todos view
  const inTrash = () => state.route.view === 'trash';
  const inCompleted = () => state.route.view === 'completed';
  const canAdd = () => !inTrash() && !inCompleted();

  function renderToolbar() {
    const r = state.route;
    document.body.classList.toggle('has-selection', state.sel.size > 0);
    if (r.page !== 'todos') { $('#toolbar').innerHTML = ''; return; }
    const tb = $('#toolbar');
    if (state.sel.size) { renderBulkToolbar(tb); return; }
    let html = '';
    if (r.folder) {
      const segs = folderSegments(r.folder);
      html += '<span class="chip filter crumbs">' + FOLDER_ICO + segs.map((seg, i) => '<a href="' + folderHash(segs.slice(0, i + 1).join('/')) + '"' + (i === segs.length - 1 ? ' class="cur"' : '') + '>' + esc(seg) + '</a>').join('<span class="sep">/</span>') + ' <button data-clear title="clear">&times;</button></span>';
    } else if (r.tag) html += '<span class="chip filter">tag: ' + esc(r.tag) + ' <button data-clear title="clear">&times;</button></span>';
    else html += '<span class="title">' + esc(VIEW_LABELS[r.view] || 'Todos') + '</span>';
    html += '<span>' + plural(state.total, 'todo') + (state.q ? ' match' : '') + '</span>';
    if (r.view === 'today' && !r.folder && !r.tag) html += '<span class="small muted">' + esc(new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())) + '</span>';
    if (r.folder) html += '<button class="btn sm ghost" id="subFolder" title="Create a folder inside this one">Subfolder</button><button class="btn sm ghost" id="renameFolder" title="Rename or move this folder">Rename</button><button class="btn sm ghost danger" id="deleteFolder" title="Delete this folder and its subfolders; todos move to the parent">Delete folder</button>';
    if (r.view === 'trash') {
      const days = state.meta ? state.meta.settings.trashDays || 30 : 30;
      html += '<span class="small muted">Todos here are removed for good after ' + days + ' days. Restore brings one back.</span>';
      if (state.results.length) html += '<button class="btn sm ghost danger" id="emptyTrash" title="Remove every todo in the trash permanently">Empty trash</button>';
    }
    if (r.view === 'now' && state.results.length) html += '<span class="small muted">' + describeEstimate(state.results) + '</span>';
    html += '<span class="grow"></span>';
    html += '<span class="small muted kbd-hint"><kbd>&uarr;&darr;</kbd> move <kbd>&#8629;</kbd> ' + (inTrash() ? 'open' : 'edit') + (inTrash() ? '' : ' <kbd>space</kbd> ' + (inCompleted() ? 'reopen' : 'done')) + ' <kbd>X</kbd> select' + (canAdd() ? ' <kbd>N</kbd> new' : '') + '</span>';
    html += '<div class="seg"><button data-layout="list" class="' + (state.layout === 'list' ? 'on' : '') + '" title="List">&#9776; List</button><button data-layout="grid" class="' + (state.layout === 'grid' ? 'on' : '') + '" title="Grid">&#9638; Grid</button></div>';
    tb.innerHTML = html;
    $$('[data-clear]', tb).forEach((b) => (b.onclick = () => go('#/all')));
    $$('[data-layout]', tb).forEach((b) => (b.onclick = () => { state.layout = b.dataset.layout; try { localStorage.setItem('todonow.layout', state.layout); } catch { /* ignore */ } renderResults(); renderToolbar(); }));
    const et = $('#emptyTrash');
    if (et) et.onclick = async () => {
      const n = state.total;
      const ok = await dialog({ input: false, ok: 'Empty trash', danger: true, title: 'Empty the trash?', message: plural(n, 'todo') + ' ' + (n === 1 ? 'is' : 'are') + ' removed permanently. This cannot be undone.' });
      if (!ok) return;
      try { const r = await api('POST', '/api/trash/empty'); toast('Trash emptied, ' + r.deleted + ' removed'); await refreshAll(); } catch (err) { toast(err.message, 4000); }
    };
    const sf = $('#subFolder');
    if (sf) sf.onclick = () => createFolder(r.folder + '/');
    const rf = $('#renameFolder');
    if (rf) rf.onclick = () => renameFolder(r.folder);
    const df = $('#deleteFolder');
    if (df) df.onclick = () => deleteFolder(df, r.folder);
  }

  function describeEstimate(todos) {
    const minutes = todos.reduce((sum, t) => sum + (t.estimateMinutes || 0), 0);
    if (!minutes) return '';
    return 'about ' + (minutes >= 60 ? (Math.round(minutes / 6) / 10) + ' h' : minutes + ' min') + ' of estimated work';
  }

  // ---- selection and bulk actions
  function clearSelection(render) {
    if (!state.sel.size && state.anchor == null) return;
    state.sel.clear();
    state.anchor = null;
    if (render !== false) { $$('.picked', $('#content')).forEach((el) => el.classList.remove('picked')); syncPicked(); renderToolbar(); }
  }

  // Toggle one row; with Shift, every row between the last picked one and this one joins.
  function togglePick(i, shift) {
    const todo = state.results[i];
    if (!todo) return;
    if (shift && state.anchor != null) {
      const [a, b] = [Math.min(state.anchor, i), Math.max(state.anchor, i)];
      const on = !state.sel.has(todo.id);
      for (let k = a; k <= b; k++) { if (on) state.sel.add(state.results[k].id); else state.sel.delete(state.results[k].id); }
    } else if (state.sel.has(todo.id)) state.sel.delete(todo.id);
    else state.sel.add(todo.id);
    state.anchor = i;
    syncPicked();
    renderToolbar();
  }

  function syncPicked() {
    $$('.row, .card', $('#content')).forEach((el) => {
      const on = state.sel.has(el.dataset.id);
      el.classList.toggle('picked', on);
      const p = $('.pick', el);
      if (p) p.setAttribute('aria-checked', String(on));
    });
  }

  function selectAllVisible() {
    for (const t of state.results) state.sel.add(t.id);
    if (state.results.length) state.anchor = state.results.length - 1;
    syncPicked();
    renderToolbar();
  }

  function renderBulkToolbar(tb) {
    const n = state.sel.size;
    let html = '<b>' + n + ' selected</b>';
    if (inTrash()) {
      html += '<button class="btn sm primary" data-bulk="restore" title="Bring the selected todos back">Restore</button>';
      html += '<button class="btn sm ghost danger" data-bulk="purge" title="Remove the selected todos permanently">Delete forever</button>';
    } else if (inCompleted()) {
      html += '<button class="btn sm" data-bulk="reopen" title="Mark the selected todos open again">Reopen</button>';
      html += '<button class="btn sm ghost danger" data-bulk="trash" title="Move the selected todos to the trash">Delete</button>';
    } else {
      html += '<button class="btn sm primary" data-bulk="complete" title="Mark the selected todos done">Complete</button>';
      html += '<button class="btn sm" data-bulk="move" title="Move the selected todos to a folder">Move to folder</button>';
      html += '<button class="btn sm" data-bulk="' + (state.route.view === 'now' ? 'unnow' : 'now') + '" title="' + (state.route.view === 'now' ? 'Take the selected todos out of Now' : 'Add the selected todos to Now') + '">' + (state.route.view === 'now' ? 'Remove from Now' : 'Add to Now') + '</button>';
      html += '<button class="btn sm ghost danger" data-bulk="trash" title="Move the selected todos to the trash">Delete</button>';
    }
    html += '<span class="grow"></span>';
    if (n < state.results.length) html += '<button class="btn sm ghost" id="pickAll">Select all ' + state.results.length + '</button>';
    html += '<button class="btn sm ghost" id="pickNone" title="Clear the selection (Esc)">Clear</button>';
    tb.innerHTML = html;
    $$('[data-bulk]', tb).forEach((b) => (b.onclick = () => bulkAction(b.dataset.bulk, b)));
    const pa = $('#pickAll');
    if (pa) pa.onclick = selectAllVisible;
    $('#pickNone').onclick = () => clearSelection();
  }

  async function bulkAction(op, button) {
    const ids = [...state.sel];
    const n = ids.length;
    const body = { ids, op };
    if (op === 'move') {
      const folder = await dialog({ title: 'Move ' + plural(n, 'todo') + ' to', value: state.route.folder || '', placeholder: 'People/Alice', ok: 'Move', list: folderPaths(), help: 'Type a folder path; a new one is created. Leave the field empty to move the todos out of their folders.', allowEmpty: true });
      if (folder == null) return;
      body.folder = folder;
    } else if (op === 'purge') {
      const ok = await dialog({ input: false, danger: true, ok: 'Delete forever', title: 'Delete ' + plural(n, 'todo') + ' permanently?', message: 'This cannot be undone.' });
      if (!ok) return;
    }
    if (button) button.disabled = true;
    try {
      const r = await api('POST', '/api/todos/bulk', body);
      const skipped = r.skipped.length ? ', ' + plural(r.skipped.length, 'skipped') + ' (' + esc(r.skipped[0].reason) + ')' : '';
      const undo = op === 'trash' && r.changed ? { label: 'Undo', onClick: () => bulkUndo(ids, 'restore') }
        : op === 'complete' && r.changed ? { label: 'Undo', onClick: () => bulkUndo(ids, 'reopen') } : null;
      const msg = op === 'move' ? (body.folder ? 'Moved ' + plural(r.changed, 'todo') + ' to ' + r.folder : 'Moved ' + plural(r.changed, 'todo') + ' out of their folders')
        : op === 'complete' ? 'Completed ' + plural(r.changed, 'todo')
        : op === 'reopen' ? 'Reopened ' + plural(r.changed, 'todo')
        : op === 'trash' ? 'Moved ' + plural(r.changed, 'todo') + ' to the trash'
        : op === 'restore' ? 'Restored ' + plural(r.changed, 'todo')
        : op === 'purge' ? 'Deleted ' + plural(r.changed, 'todo') + ' permanently'
        : op === 'now' ? 'Added ' + plural(r.changed, 'todo') + ' to Now'
        : 'Removed ' + plural(r.changed, 'todo') + ' from Now';
      clearSelection(false);
      toast(msg + skipped, undo ? 7000 : 3000, undo);
      await refreshAll();
    } catch (err) {
      toast(err.message, 4000);
      if (button) button.disabled = false;
    }
  }

  async function bulkUndo(ids, op) {
    try {
      const r = await api('POST', '/api/todos/bulk', { ids, op });
      toast((op === 'restore' ? 'Restored ' : 'Reopened ') + plural(r.changed, 'todo'));
      await refreshAll();
    } catch (err) { toast(err.message, 4000); }
  }

  let searchTimer = null;
  let searchSeq = 0;
  function scheduleSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(doSearch, 110);
  }

  async function doSearch() {
    if (state.route.page !== 'todos') return;
    const r = state.route;
    const params = new URLSearchParams();
    state.q = $('#q').value;
    if (state.q) params.set('q', state.q);
    if (r.folder) params.set('folder', r.folder);
    if (r.tag) params.set('tag', r.tag);
    params.set('view', r.view);
    params.set('limit', '500');
    const seq = ++searchSeq;
    let data;
    try { data = await api('GET', '/api/todos?' + params); } catch (err) { $('#content').innerHTML = '<div class="empty"><b>' + esc(err.message) + '</b></div>'; return; }
    if (seq !== searchSeq) return;
    state.results = data.todos;
    state.total = data.total;
    state.terms = data.terms;
    state.selected = Math.min(state.selected, Math.max(0, state.results.length - 1));
    if (state.meta) state.meta.counts = data.counts;
    // picked todos that dropped out of the results (moved, completed, trashed) leave the selection
    if (state.sel.size) { const ids = new Set(state.results.map((t) => t.id)); for (const id of [...state.sel]) if (!ids.has(id)) state.sel.delete(id); }
    renderToolbar();
    renderResults();
  }

  // ---- rows and cards
  function badges(t) {
    let html = '';
    if (t.status === 'waiting' && !t.completedAt) html += ' <span class="badge warn" title="' + (t.waitingFor ? 'Waiting for ' + esc(t.waitingFor) : 'Waiting') + '">waiting</span>';
    if (t.status === 'someday' && !t.completedAt) html += ' <span class="badge">someday</span>';
    if (t.recurrence) html += ' <span class="badge" title="Repeats ' + esc(t.recurrence) + '">' + esc(t.recurrence) + '</span>';
    if (t.reminder && t.reminder.enabled === false && t.dueAt) html += ' <span class="badge" title="No deadline notification for this todo">muted</span>';
    return html;
  }

  function whenLine(t) {
    if (t.deletedAt) return 'deleted ' + rel(t.deletedAt);
    if (t.completedAt) return 'done ' + rel(t.completedAt);
    if (t.dueAt) return '<span class="due ' + dueClass(t) + '">' + NAV_ICONS.clock + ' ' + esc(dueLabel(t)) + '</span>';
    if (t.plannedDate) return '<span class="due' + (t.plannedDate < dayKey() ? ' overdue' : t.plannedDate === dayKey() ? ' today' : '') + '" title="Planned for ' + esc(t.plannedDate) + '">' + NAV_ICONS.today + ' ' + esc(dayLabel(t.plannedDate)) + '</span>';
    return '<span class="muted">added ' + rel(t.createdAt) + '</span>';
  }

  function subLine(t, terms) {
    const parts = [];
    if (t.folder && !state.route.folder) parts.push('<a class="fpath" href="' + folderHash(t.folder) + '" title="' + esc(t.folder) + '">' + FOLDER_ICO + '<span class="fl">' + esc(t.folder) + '</span></a>');
    else if (t.folder && state.route.folder && t.folder.toLowerCase() !== state.route.folder.toLowerCase()) parts.push('<a class="fpath" href="' + folderHash(t.folder) + '" title="' + esc(t.folder) + '">' + FOLDER_ICO + '<span class="fl">' + esc(t.folder.slice(state.route.folder.length + 1)) + '</span></a>');
    if (t.url) parts.push('<a class="fpath link" href="' + esc(t.url) + '" target="_blank" rel="noopener" title="' + esc(t.url) + '">' + NAV_ICONS.link + '<span class="fl">' + esc(host(t.url)) + '</span></a>');
    if (t.dueAt && t.plannedDate && t.plannedDate !== dayKey(new Date(t.dueAt))) parts.push('<span title="Planned for ' + esc(t.plannedDate) + '">plan ' + esc(dayLabel(t.plannedDate)) + '</span>');
    if (t.status === 'waiting' && t.waitingFor) parts.push('<span>waiting for ' + hl(t.waitingFor, terms) + '</span>');
    if (t.estimateMinutes) parts.push('<span>' + (t.estimateMinutes >= 60 ? (Math.round(t.estimateMinutes / 6) / 10) + ' h' : t.estimateMinutes + ' min') + '</span>');
    if (t.tags && t.tags.length) parts.push('<span class="tags">' + t.tags.map((tag) => '<span class="chip">' + hl(tag, terms) + '</span>').join('') + '</span>');
    return parts.join('<span class="sep"></span>');
  }

  function rowActions(t) {
    if (inTrash()) return '<div class="acts"><button class="btn sm primary" data-restore title="Bring this todo back">Restore</button><button class="btn sm ghost danger" data-purge title="Remove permanently (click twice)">Delete forever</button></div>';
    if (t.completedAt) return '<div class="acts"><button class="btn sm" data-reopen title="Mark open again">Reopen</button><button class="btn sm ghost" data-edit title="Edit (E)">Edit</button><button class="btn sm ghost danger" data-del title="Move to the trash (click twice)">Delete</button></div>';
    return '<div class="acts"><button class="btn sm" data-edit title="Edit (E)">Edit</button>' + (Number.isFinite(t.nowOrder) ? '<button class="btn sm ghost" data-unnow title="Take out of Now">Unfocus</button>' : '<button class="btn sm ghost" data-now title="Add to Now">Now</button>') + '<button class="btn sm ghost danger" data-del title="Move to the trash (click twice)">Delete</button></div>';
  }

  const pickBox = (t) => '<span class="pick" data-pick role="checkbox" aria-checked="' + state.sel.has(t.id) + '" title="Select (X). Shift+click selects a range"></span>';
  const doneBox = (t) => '<button class="tick' + (t.priority === 'high' && !t.completedAt ? ' high' : '') + '" data-done role="checkbox" aria-checked="' + Boolean(t.completedAt) + '" title="' + (t.completedAt ? 'Reopen' : 'Complete (space)') + '"' + (t.deletedAt ? ' disabled' : '') + '></button>';
  const titleHtml = (t, terms) => '<span class="t" title="' + esc(t.title) + '">' + hl(t.title, terms) + '</span>' + (t.priority !== 'none' && !t.completedAt ? '<span class="prio ' + esc(t.priority) + '" title="' + esc(t.priority) + ' priority"></span>' : '') + (Number.isFinite(t.nowOrder) && state.route.view !== 'now' ? '<span class="now-mark" title="In Now">' + NAV_ICONS.now + '</span>' : '');

  function quickHtml() {
    if (!canAdd()) return '';
    const r = state.route;
    const where = r.folder ? 'in ' + r.folder : r.tag ? 'tagged ' + r.tag : r.view === 'today' ? 'for today' : r.view === 'now' ? 'to Now' : r.view === 'waiting' ? 'to Waiting' : r.view === 'someday' ? 'to Someday' : r.view === 'upcoming' ? 'due tomorrow' : 'to Inbox';
    return '<form class="quick" id="quick" autocomplete="off"><span class="plus">' + NAV_ICONS.plus + '</span><input id="quickTitle" type="text" placeholder="Add a todo ' + esc(where) + '" spellcheck="true"><span class="hint"><kbd>&#8629;</kbd> add <kbd>&#8984;&#8629;</kbd> add and edit</span></form>';
  }

  function renderResults() {
    const c = $('#content');
    const r = state.route;
    if (!state.results.length) {
      c.innerHTML = quickHtml() + '<div class="empty"><b>' + (state.q ? 'No matches for "' + esc(state.q) + '"' : r.view === 'trash' ? 'The trash is empty' : r.view === 'completed' ? 'Nothing completed yet' : r.view === 'today' ? 'Nothing planned for today' : r.view === 'now' ? 'Now is empty' : r.view === 'inbox' ? 'Inbox zero' : r.folder ? 'Empty folder' : 'Nothing here yet') + '</b>' +
        (state.q ? 'Try fewer words, or operators like <code>in:People</code>, <code>tag:phone</code>, <code>due:today</code>, <code>is:overdue</code>, <code>priority:high</code>.'
          : r.view === 'trash' ? 'Deleted todos wait here for ' + (state.meta ? state.meta.settings.trashDays || 30 : 30) + ' days before they are removed for good.'
          : r.view === 'completed' ? 'Finished todos show up here, newest first.'
          : r.view === 'today' ? 'Todos due or planned for today, and anything overdue, land here. Add one above or set a date on an existing todo.'
          : r.view === 'now' ? 'Pull a few todos in with the Now button on a row, or the Focus box when editing, to build a short queue for your current focus.'
          : r.view === 'inbox' ? 'New todos without a folder, date or status wait here until you file them.'
          : r.folder ? 'Add a todo above, or drag one onto this folder in the sidebar.'
          : 'Add a todo above, or press <kbd>N</kbd> for the full form.') +
        '</div>';
      bindQuick();
      return;
    }
    const terms = state.terms;
    const trash = inTrash();
    if (state.layout === 'grid') {
      c.innerHTML = quickHtml() + '<div class="grid">' + state.results.map((t, i) => {
        return '<div class="card' + (i === state.selected ? ' selected' : '') + (state.sel.has(t.id) ? ' picked' : '') + (t.completedAt ? ' completed' : '') + '" data-i="' + i + '" data-id="' + esc(t.id) + '" draggable="' + (trash ? 'false' : 'true') + '">' +
          '<div class="head">' + doneBox(t) + '<span class="small">' + whenLine(t) + '</span>' + pickBox(t) + '</div>' +
          '<div class="body"><div class="title">' + titleHtml(t, terms) + '</div>' +
          (firstLine(t.notes) ? '<div class="desc" title="' + esc(firstLine(t.notes)) + '">' + hl(firstLine(t.notes), terms) + '</div>' : '') +
          '<div class="host">' + subLine(t, terms) + '</div>' +
          '<div class="meta"><span>' + badges(t) + '</span><span>' + (t.completedAt || t.deletedAt ? '' : 'added ' + rel(t.createdAt)) + '</span></div>' +
          rowActions(t) +
          '</div></div>';
      }).join('') + '</div>';
    } else {
      c.innerHTML = quickHtml() + '<div class="list">' + state.results.map((t, i) => {
        return '<div class="row' + (i === state.selected ? ' selected' : '') + (state.sel.has(t.id) ? ' picked' : '') + (t.completedAt ? ' completed' : '') + '" data-i="' + i + '" data-id="' + esc(t.id) + '" draggable="' + (trash ? 'false' : 'true') + '">' + pickBox(t) + doneBox(t) +
          '<div class="main"><div class="title">' + titleHtml(t, terms) + badges(t) + '</div>' +
          (firstLine(t.notes) ? '<div class="desc" title="' + esc(firstLine(t.notes)) + '">' + hl(firstLine(t.notes), terms) + '</div>' : '') +
          '<div class="sub">' + subLine(t, terms) + '</div></div>' +
          '<div class="right">' + whenLine(t) + '</div>' +
          rowActions(t) +
          '</div>';
      }).join('') + '</div>';
    }
    bindQuick();
  }

  function bindQuick() {
    const form = $('#quick');
    if (!form) return;
    const input = $('#quickTitle', form);
    const submit = async (andEdit) => {
      const title = input.value.trim();
      if (!title) return;
      const r = state.route;
      const body = { title };
      if (r.folder) body.folder = r.folder;
      if (r.tag) body.tags = [r.tag];
      if (r.view === 'today') body.plannedDate = dayKey();
      if (r.view === 'now') body.nowOrder = Date.now();
      if (r.view === 'waiting') body.status = 'waiting';
      if (r.view === 'someday') body.status = 'someday';
      if (r.view === 'upcoming') { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); body.dueAt = d.toISOString(); }
      input.disabled = true;
      try {
        const res = await api('POST', '/api/todos', body);
        input.value = '';
        await refreshAll();
        const shown = state.results.some((t) => t.id === res.todo.id);
        if (andEdit) openDrawer(res.todo);
        else toast(shown ? 'Added' : 'Added to Inbox', shown ? 1800 : 5000, shown ? null : { label: 'Open', onClick: () => go('#/todo/' + res.todo.id) });
        const again = $('#quickTitle');
        if (again && !andEdit) again.focus();
      } catch (err) { toast(err.message, 4000); }
      finally { input.disabled = false; }
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(false); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(true); }
      if (e.key === 'Escape') { input.value = ''; input.blur(); }
    });
  }

  function select(i, scroll) {
    if (!state.results.length) return;
    state.selected = Math.max(0, Math.min(state.results.length - 1, i));
    $$('.row.selected, .card.selected').forEach((e) => e.classList.remove('selected'));
    const el = $('[data-i="' + state.selected + '"]');
    if (el) { el.classList.add('selected'); if (scroll) el.scrollIntoView({ block: 'nearest' }); }
  }

  function selectedTodo() { return state.results[state.selected]; }

  $('#content').addEventListener('click', (e) => {
    const item = e.target.closest('.row, .card');
    if (!item) return;
    const i = Number(item.dataset.i);
    const t = state.results[i];
    if (!t) return;
    if (e.target.closest('a.fpath')) return; // folder link: let the hash change
    if (e.target.closest('[data-pick]') || e.shiftKey) { e.preventDefault(); togglePick(i, e.shiftKey); select(i); return; }
    select(i);
    if (e.target.closest('[data-done]')) { toggleDone(t); return; }
    if (e.target.closest('[data-edit]')) { openDrawer(t); return; }
    if (e.target.closest('[data-reopen]')) { toggleDone(t); return; }
    if (e.target.closest('[data-now]')) { setNow(t, true); return; }
    if (e.target.closest('[data-unnow]')) { setNow(t, false); return; }
    const del = e.target.closest('[data-del]');
    if (del) { confirmDelete(del, t); return; }
    const restore = e.target.closest('[data-restore]');
    if (restore) { restoreOne(t); return; }
    const purge = e.target.closest('[data-purge]');
    if (purge) { confirmPurge(purge, t); return; }
    if (e.target.closest('.btn')) return;
    openDrawer(t);
  });
  $('#content').addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.row, .card');
    if (!item) return;
    e.preventDefault();
    openDrawer(state.results[Number(item.dataset.i)]);
  });

  async function toggleDone(t) {
    const completing = !t.completedAt;
    try {
      const r = await api('POST', '/api/todos/' + t.id + '/' + (completing ? 'complete' : 'reopen'));
      replaceResult(r.todo);
      if (completing) toast('Completed "' + t.title + '"' + (t.recurrence ? ', next one filed' : ''), 6000, { label: 'Undo', onClick: () => api('POST', '/api/todos/' + t.id + '/reopen').then(refreshAll).catch((err) => toast(err.message, 4000)) });
      else toast('Reopened');
      await refreshAll();
    } catch (err) { toast(err.message, 4000); }
  }

  async function setNow(t, on) {
    try {
      const r = await api('PUT', '/api/todos/' + t.id, { nowOrder: on ? Date.now() : null });
      replaceResult(r.todo);
      toast(on ? 'Added to Now' : 'Removed from Now');
      await refreshAll();
    } catch (err) { toast(err.message, 4000); }
  }

  // ------------------------------------------------------------------ drag a todo onto a folder
  let dragId = null;
  let hoverTimer = null;
  $('#content').addEventListener('dragstart', (e) => {
    const item = e.target.closest('.row, .card');
    if (!item) { if (!e.target.closest('a[href]')) e.preventDefault(); return; }
    dragId = item.dataset.id;
    const t = state.results.find((x) => x.id === dragId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', t ? t.title : dragId);
    e.dataTransfer.setData('application/x-todonow-id', dragId);
    setTimeout(() => { if (dragId) { item.classList.add('dragging'); document.body.classList.add('dragging-todo'); } }, 0);
    if (e.dataTransfer.setDragImage && t) {
      const ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.innerHTML = NAV_ICONS.completed + '<span>' + esc(t.title) + '</span>';
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 18, 18);
      setTimeout(() => ghost.remove(), 0);
    }
  });
  $('#content').addEventListener('dragend', (e) => {
    const item = e.target.closest('.row, .card');
    if (item) item.classList.remove('dragging');
    document.body.classList.remove('dragging-todo');
    $$('#side .drop').forEach((el) => el.classList.remove('drop'));
    dragId = null;
  });
  const side = $('#side');
  // ---- folders can be dragged onto other folders (or "Top level") to move them
  let dragFolder = null;
  side.addEventListener('dragstart', (e) => {
    const a = e.target.closest('[data-drag-folder]');
    if (!a) return;
    dragFolder = a.dataset.dragFolder;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragFolder);
    e.dataTransfer.setData('application/x-todonow-folder', dragFolder);
    setTimeout(() => { if (dragFolder) { document.body.classList.add('dragging-folder'); a.classList.add('dragging'); } }, 0);
    if (e.dataTransfer.setDragImage) {
      const ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.innerHTML = FOLDER_ICO + '<span>' + esc(folderSegments(dragFolder).pop()) + '</span>';
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 14, 14);
      setTimeout(() => ghost.remove(), 0);
    }
  });
  side.addEventListener('dragend', () => {
    dragFolder = null;
    document.body.classList.remove('dragging-folder');
    $$('#side .dragging, #side .drop').forEach((el) => el.classList.remove('dragging', 'drop'));
  });
  // A folder may not be dropped on itself, inside itself, or on its current parent.
  const folderDropOk = (from, toParent) => {
    const f = from.toLowerCase(), p = (toParent || '').toLowerCase();
    if (!p) return folderSegments(from).length > 1;
    if (p === f || p.startsWith(f + '/')) return false;
    return (folderSegments(from).slice(0, -1).join('/').toLowerCase()) !== p;
  };
  const dropTarget = (e) => e.target.closest('[data-drop-folder], [data-drop-root]');
  side.addEventListener('dragover', (e) => {
    const t = dropTarget(e);
    if (dragFolder && t) {
      const toParent = t.dataset.dropRoot ? '' : t.dataset.dropFolder;
      if (!folderDropOk(dragFolder, toParent)) { e.dataTransfer.dropEffect = 'none'; return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!t.classList.contains('drop')) { $$('#side .drop').forEach((el) => el.classList.remove('drop')); t.classList.add('drop'); }
      return;
    }
    if (!dragId || !t || t.dataset.dropRoot) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!t.classList.contains('drop')) {
      $$('#side .drop').forEach((el) => el.classList.remove('drop'));
      t.classList.add('drop');
      clearTimeout(hoverTimer);
      const tw = t.querySelector('[data-tw]');
      if (tw && tw.title === 'Expand') hoverTimer = setTimeout(() => { state.expanded.add(t.dataset.dropFolder.toLowerCase()); saveExpanded(); renderFolderTree(); }, 650);
    }
  });
  side.addEventListener('dragleave', (e) => {
    const t = dropTarget(e);
    if (t && !t.contains(e.relatedTarget)) { t.classList.remove('drop'); clearTimeout(hoverTimer); }
  });
  side.addEventListener('drop', async (e) => {
    const t = dropTarget(e);
    if (!t) return;
    e.preventDefault();
    clearTimeout(hoverTimer);
    $$('#side .drop').forEach((el) => el.classList.remove('drop'));
    const movingFolder = e.dataTransfer.getData('application/x-todonow-folder') || dragFolder;
    if (movingFolder) {
      dragFolder = null;
      document.body.classList.remove('dragging-folder');
      const toParent = t.dataset.dropRoot ? '' : t.dataset.dropFolder;
      if (!folderDropOk(movingFolder, toParent)) return;
      const name = folderSegments(movingFolder).pop();
      const to = toParent ? toParent + '/' + name : name;
      const node = state.meta && state.meta.folders.find((f) => f.path.toLowerCase() === movingFolder.toLowerCase());
      const count = node ? node.total : 0;
      const hasKids = node && state.meta.folders.some((f) => f.parent && f.parent.toLowerCase() === movingFolder.toLowerCase());
      const along = [count ? plural(count, 'todo') : '', hasKids ? 'its subfolders' : ''].filter(Boolean).join(' and ');
      const ok = await dialog({ input: false, ok: 'Move', title: toParent ? 'Move into ' + toParent + '?' : 'Move to the top level?', message: 'Folder <b>' + esc(name) + '</b> becomes <code>' + esc(to) + '</code>' + (along ? ', taking ' + along + ' along.' : '.') });
      if (!ok) return;
      try {
        const r = await api('POST', '/api/folders/rename', { from: movingFolder, to });
        if (toParent) state.expanded.add(toParent.toLowerCase());
        saveExpanded();
        toast('Moved to ' + r.to + (r.changed ? ' with ' + plural(r.changed, 'todo') : ''));
        await loadMeta();
        if (state.route.folder && state.route.folder.toLowerCase().startsWith(movingFolder.toLowerCase())) go(folderHash(r.to + state.route.folder.slice(movingFolder.length)));
        else await refreshAll();
      } catch (err) { toast(err.message, 4000); }
      return;
    }
    if (t.dataset.dropRoot) return;
    const id = e.dataTransfer.getData('application/x-todonow-id') || dragId;
    document.body.classList.remove('dragging-todo');
    dragId = null;
    const todo = state.results.find((x) => x.id === id);
    if (!todo) return;
    const folder = t.dataset.dropFolder || '';
    if ((todo.folder || '') === folder) { toast(folder ? 'Already in ' + folder : 'Already unfiled'); return; }
    const ok = await dialog({
      input: false, ok: 'Move',
      title: folder ? 'Move to ' + folder + '?' : 'Remove from its folder?',
      message: '<b>' + esc(todo.title) + '</b>' + (todo.folder ? ' leaves <code>' + esc(todo.folder) + '</code>' : '') + (folder ? ' and goes into <code>' + esc(folder) + '</code>.' : ' and becomes unfiled.'),
    });
    if (!ok) return;
    try {
      const r = await api('PUT', '/api/todos/' + todo.id, { folder });
      replaceResult(r.todo);
      toast(folder ? 'Moved to ' + folder : 'Moved out of its folder');
      await refreshAll();
    } catch (err) { toast(err.message, 4000); }
  });

  // ------------------------------------------------------------------ keyboard
  document.addEventListener('keydown', (e) => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    const inSearch = e.target.id === 'q';
    const drawerOpen = $('#drawer').classList.contains('open');
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); if (state.route.page !== 'todos') go('#/all'); const q = $('#q'); q.focus(); q.select(); return; }
    if (e.key === 'Escape') {
      if (drawerOpen) { closeDrawer(); return; }
      if (state.sel.size && !inField) { clearSelection(); return; }
      if (inSearch && $('#q').value) { $('#q').value = ''; scheduleSearch(); return; }
      if (inField) e.target.blur();
      return;
    }
    if (mod && e.key.toLowerCase() === 's' && drawerOpen) { e.preventDefault(); saveDrawer(); return; }
    if (mod && e.key === 'Enter' && drawerOpen && e.target.closest('#drawer')) { e.preventDefault(); saveDrawer(); return; }
    if (mod && e.key.toLowerCase() === 'a' && !inField && state.route.page === 'todos' && state.results.length) { e.preventDefault(); selectAllVisible(); return; }
    if (inField && !inSearch) return;
    if (state.route.page !== 'todos') return;

    if (e.key === 'ArrowDown') { e.preventDefault(); select(state.selected + 1, true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(state.selected - 1, true); }
    else if (e.key === 'Enter') { e.preventDefault(); const t = selectedTodo(); if (t) openDrawer(t); }
    else if (!inField) {
      if (e.key === ' ') { e.preventDefault(); const t = selectedTodo(); if (t && !t.deletedAt) toggleDone(t); }
      else if (e.key === 'e') { e.preventDefault(); const t = selectedTodo(); if (t) openDrawer(t); }
      else if (e.key === 'x') { e.preventDefault(); if (state.results.length) togglePick(state.selected, e.shiftKey); }
      else if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
      else if (e.key === 'l') { state.layout = state.layout === 'list' ? 'grid' : 'list'; try { localStorage.setItem('todonow.layout', state.layout); } catch { /* ignore */ } renderResults(); renderToolbar(); }
      else if (e.key === 'n' && canAdd()) { e.preventDefault(); openDrawer(null); }
      else if (e.key === 'a' && canAdd()) { e.preventDefault(); const q = $('#quickTitle'); if (q) q.focus(); }
    }
  });

  $('#q').addEventListener('input', scheduleSearch);
  $('#fab').onclick = () => openDrawer(null);

  // ------------------------------------------------------------------ drawer
  let drawerChips = null;
  let drawerFolder = null;

  // Defaults for a new todo follow the current view, so "N" in a folder files the todo there.
  function newTodoDefaults() {
    const r = state.route;
    return {
      id: null, title: '', notes: '', folder: r.folder || null, tags: r.tag ? [r.tag] : [], priority: 'none',
      status: r.view === 'waiting' ? 'waiting' : r.view === 'someday' ? 'someday' : 'open',
      dueAt: null, plannedDate: r.view === 'today' ? dayKey() : null, nowOrder: r.view === 'now' ? Date.now() : null,
      estimateMinutes: null, waitingFor: null, reminder: null, recurrence: null,
    };
  }

  function reminderValue(t) {
    if (!t.reminder) return 'default';
    if (t.reminder.enabled === false) return 'off';
    return t.reminder.minutesBefore == null ? 'default' : String(t.reminder.minutesBefore);
  }

  function openDrawer(todo) {
    const t = todo || newTodoDefaults();
    const isNew = !t.id;
    state.editing = t;
    const d = $('#drawer');
    const trashed = Boolean(t.deletedAt);
    const opt = (v, label, cur) => '<option value="' + esc(v) + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + esc(label) + '</option>';
    d.innerHTML =
      '<div class="drawer-head"><h3 title="' + esc(t.title || 'New todo') + '">' + (isNew ? 'New todo' : esc(t.title)) + '</h3>' +
      (isNew || trashed ? '' : '<button class="btn sm" id="dDone" title="' + (t.completedAt ? 'Reopen' : 'Complete') + '">' + (t.completedAt ? 'Reopen' : 'Complete') + '</button>') +
      '<button class="btn sm ghost" id="dClose" title="Close (Esc)">&times;</button></div>' +
      '<div class="drawer-body">' +
      (trashed ? '<div class="alert warn">In the trash since ' + rel(t.deletedAt) + '. Restore it to edit; it is removed for good after ' + (state.meta ? state.meta.settings.trashDays || 30 : 30) + ' days.</div>' : '') +
      (t.completedAt && !trashed ? '<div class="alert ok">Completed ' + rel(t.completedAt) + '. Reopen it to work on it again.</div>' : '') +
      (t.overdue && !t.completedAt && !trashed ? '<div class="alert error">Overdue: was due ' + esc(dueLabel(t)) + '.</div>' : '') +
      '<div class="field">' + lbl('Title', 'title') + '<input type="text" id="fTitle" value="' + esc(t.title) + '" placeholder="What needs doing?"></div>' +
      '<div class="field">' + lbl('Folder', 'folder') + '<div id="fFolder"></div><div class="help">Pick from the tree or type a new path with <code>/</code></div></div>' +
      '<div class="field">' + lbl('Link', 'url') + '<input type="url" id="fUrl" value="' + esc(t.url || '') + '" placeholder="https://">' + (t.url ? '<div class="help"><a href="' + esc(t.url) + '" target="_blank" rel="noopener">Open ' + esc(host(t.url)) + '</a></div>' : '') + '</div>' +
      '<div class="row2"><div class="field">' + lbl('Deadline', 'due') + '<input type="datetime-local" id="fDue" value="' + esc(toLocalInput(t.dueAt)) + '"></div>' +
      '<div class="field">' + lbl('Plan for', 'planned') + '<input type="date" id="fPlanned" value="' + esc(t.plannedDate || '') + '"></div></div>' +
      '<div class="row2"><div class="field">' + lbl('Status', 'status') + '<select id="fStatus">' + opt('open', 'Open', t.status) + opt('waiting', 'Waiting', t.status) + opt('someday', 'Someday', t.status) + '</select></div>' +
      '<div class="field">' + lbl('Waiting for', 'waiting') + '<input type="text" id="fWaiting" value="' + esc(t.waitingFor || '') + '" placeholder="Person or event"></div></div>' +
      '<div class="row2"><div class="field">' + lbl('Priority', 'priority') + '<select id="fPriority">' + opt('none', 'None', t.priority) + opt('low', 'Low', t.priority) + opt('medium', 'Medium', t.priority) + opt('high', 'High', t.priority) + '</select></div>' +
      '<div class="field">' + lbl('Estimate', 'estimate') + '<select id="fEstimate">' + opt('', 'None', t.estimateMinutes || '') + opt('5', '5 minutes', t.estimateMinutes) + opt('15', '15 minutes', t.estimateMinutes) + opt('30', '30 minutes', t.estimateMinutes) + opt('60', '1 hour', t.estimateMinutes) + opt('120', '2 hours', t.estimateMinutes) + opt('240', 'Half a day', t.estimateMinutes) + '</select></div></div>' +
      '<div class="row2"><div class="field">' + lbl('Repeat', 'repeat') + '<select id="fRepeat">' + opt('', 'Never', t.recurrence || '') + opt('daily', 'Daily', t.recurrence) + opt('weekdays', 'Weekdays', t.recurrence) + opt('weekly', 'Weekly', t.recurrence) + opt('monthly', 'Monthly', t.recurrence) + '</select></div>' +
      '<div class="field">' + lbl('Reminder', 'reminder') + '<select id="fReminder">' + opt('default', 'Use default', reminderValue(t)) + opt('0', 'At the deadline', reminderValue(t)) + opt('15', '15 minutes before', reminderValue(t)) + opt('60', '1 hour before', reminderValue(t)) + opt('1440', '1 day before', reminderValue(t)) + opt('off', 'Off', reminderValue(t)) + '</select></div></div>' +
      '<div class="field checks"><label><input type="checkbox" id="fNow"' + (Number.isFinite(t.nowOrder) ? ' checked' : '') + '> In Now, my current focus queue<span class="info" tabindex="0" data-tip="' + esc(TIPS.now) + '">i</span></label></div>' +
      '<div class="field">' + lbl('Tags', 'tags') + '<div id="fTags"></div></div>' +
      '<div class="field">' + lbl('Notes', 'notes') + '<textarea id="fNotes" placeholder="Context, links, next steps">' + esc(t.notes || '') + '</textarea></div>' +
      (isNew ? '' : '<div class="stats"><span>Added <b>' + rel(t.createdAt) + '</b></span><span>Updated <b>' + rel(t.updatedAt) + '</b></span>' + (t.completedAt ? '<span>Completed <b>' + rel(t.completedAt) + '</b></span>' : '') + (t.reminder && t.reminder.snoozedUntil && Date.parse(t.reminder.snoozedUntil) > Date.now() ? '<span>Reminder snoozed until <b>' + esc(timeLabel(t.reminder.snoozedUntil)) + '</b></span>' : '') + '<span>Id <b>' + esc(t.id) + '</b></span></div>') +
      '</div>' +
      (trashed
        ? '<div class="drawer-foot"><button class="btn primary" id="dRestore">Restore</button><button class="btn" id="dClose2">Close</button><span class="grow"></span><button class="btn danger" id="dDelete">Delete forever</button></div>'
        : '<div class="drawer-foot"><button class="btn primary" id="dSave">' + (isNew ? 'Add todo' : 'Save') + ' <kbd>&#8984;S</kbd></button><button class="btn" id="dClose2">Cancel</button><span class="grow"></span>' + (isNew ? '' : (t.dueAt && !t.completedAt ? '<button class="btn ghost" id="dSnooze" title="Hold the deadline notification for an hour">Snooze 1h</button>' : '') + '<button class="btn danger" id="dDelete">Delete</button>') + '</div>');
    d.classList.add('open');
    d.setAttribute('aria-hidden', 'false');
    if (trashed) $$('#drawer input, #drawer textarea, #drawer select').forEach((el) => { el.disabled = true; });
    drawerChips = chipEditor($('#fTags'), { values: t.tags || [], all: state.meta ? state.meta.tags.map((x) => x.name) : [] });
    if (drawerFolder) drawerFolder.destroy();
    drawerFolder = folderPicker($('#fFolder'), { value: t.folder || '', folders: state.meta ? state.meta.folders : [] });
    if (trashed) drawerFolder.input.disabled = true;
    // Waiting for only matters with the Waiting status; the field hints at that.
    const status = $('#fStatus'), waiting = $('#fWaiting');
    const syncWaiting = () => { waiting.placeholder = status.value === 'waiting' ? 'Person or event' : 'Set status to Waiting to use this'; };
    status.onchange = syncWaiting; syncWaiting();
    waiting.oninput = () => { if (waiting.value.trim() && status.value !== 'waiting') status.value = 'waiting'; };

    $('#dClose').onclick = closeDrawer;
    $('#dClose2').onclick = closeDrawer;
    const ds = $('#dSave');
    if (ds) ds.onclick = saveDrawer;
    const dd = $('#dDone');
    if (dd) dd.onclick = async () => { closeDrawer(); await toggleDone(t); };
    const dr = $('#dRestore');
    if (dr) dr.onclick = async () => { closeDrawer(); await restoreOne(t); };
    const sn = $('#dSnooze');
    if (sn) sn.onclick = async () => {
      try { await api('POST', '/api/todos/' + t.id + '/snooze', { minutes: 60 }); toast('Deadline notification snoozed for an hour'); closeDrawer(); await refreshAll(); } catch (err) { toast(err.message, 4000); }
    };
    const del = $('#dDelete');
    if (del) del.onclick = async (e) => {
      const b = e.currentTarget;
      const label = trashed ? 'Delete forever' : 'Delete';
      if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = trashed ? 'Confirm: gone for good' : 'Confirm delete'; setTimeout(() => { b.classList.remove('armed'); b.textContent = label; }, 3000); return; }
      try {
        await api('DELETE', '/api/todos/' + t.id + (trashed ? '?permanent=1' : ''));
        closeDrawer();
        if (trashed) toast('Deleted permanently');
        else toast('Moved "' + t.title + '" to the trash', 7000, { label: 'Undo', onClick: () => restoreOne(t, true) });
        await refreshAll();
      } catch (err) { toast(err.message, 4000); }
    };
    setTimeout(() => { const f = $('#fTitle'); if (f && !f.disabled) f.focus(); }, 50);
  }

  function drawerBody() {
    const reminderChoice = $('#fReminder').value;
    let reminder = null;
    if (reminderChoice === 'off') reminder = { enabled: false };
    else if (reminderChoice !== 'default') reminder = { enabled: true, minutesBefore: Number(reminderChoice) };
    const t = state.editing || {};
    return {
      title: $('#fTitle').value,
      folder: drawerFolder ? drawerFolder.get() : '',
      url: $('#fUrl').value.trim(),
      dueAt: fromLocalInput($('#fDue').value),
      plannedDate: $('#fPlanned').value || null,
      status: $('#fStatus').value,
      waitingFor: $('#fWaiting').value,
      priority: $('#fPriority').value,
      estimateMinutes: $('#fEstimate').value || null,
      recurrence: $('#fRepeat').value || null,
      reminder: reminder && t.reminder && t.reminder.snoozedUntil && reminder.enabled !== false ? { ...reminder, snoozedUntil: t.reminder.snoozedUntil } : reminder,
      nowOrder: $('#fNow').checked ? (Number.isFinite(t.nowOrder) ? t.nowOrder : Date.now()) : null,
      tags: drawerChips ? drawerChips.get() : [],
      notes: $('#fNotes').value,
    };
  }

  async function saveDrawer() {
    const t = state.editing;
    if (!t || t.deletedAt || !$('#fTitle')) return;
    const body = drawerBody();
    if (!body.title.trim()) { $('#fTitle').focus(); toast('A title is needed', 2500); return; }
    const isNew = !t.id;
    try {
      const r = isNew ? await api('POST', '/api/todos', body) : await api('PUT', '/api/todos/' + t.id, body);
      replaceResult(r.todo);
      closeDrawer();
      await refreshAll();
      const shown = state.results.some((x) => x.id === r.todo.id);
      if (isNew) toast(shown ? 'Added' : 'Added, not in this view', shown ? 2200 : 5000, shown ? null : { label: 'Open', onClick: () => go('#/todo/' + r.todo.id) });
      else toast('Saved');
    } catch (err) {
      toast(err.message, 4000);
    }
  }

  function closeDrawer() {
    const d = $('#drawer');
    d.classList.remove('open');
    d.setAttribute('aria-hidden', 'true');
    state.editing = null;
    if (drawerFolder) { drawerFolder.destroy(); drawerFolder = null; }
    if (state.route.todoId) history.replaceState(null, '', '#/all');
  }

  // Two-step delete: first click arms the button for 3 seconds, second click moves the todo
  // to the trash. The toast offers Undo.
  async function confirmDelete(button, t) {
    if (!button.classList.contains('armed')) {
      button.classList.add('armed');
      button.textContent = 'Confirm delete';
      clearTimeout(button._disarm);
      button._disarm = setTimeout(() => { button.classList.remove('armed'); button.textContent = 'Delete'; }, 3000);
      return;
    }
    button.disabled = true;
    try {
      await api('DELETE', '/api/todos/' + t.id);
      toast('Moved "' + t.title + '" to the trash', 7000, { label: 'Undo', onClick: () => restoreOne(t, true) });
      if (state.editing && state.editing.id === t.id) closeDrawer();
      await refreshAll();
    } catch (err) {
      toast(err.message, 4000);
      button.disabled = false;
    }
  }

  async function confirmPurge(button, t) {
    if (!button.classList.contains('armed')) {
      button.classList.add('armed');
      button.textContent = 'Confirm: gone for good';
      clearTimeout(button._disarm);
      button._disarm = setTimeout(() => { button.classList.remove('armed'); button.textContent = 'Delete forever'; }, 3000);
      return;
    }
    button.disabled = true;
    try {
      await api('DELETE', '/api/todos/' + t.id + '?permanent=1');
      toast('Deleted "' + t.title + '" permanently');
      if (state.editing && state.editing.id === t.id) closeDrawer();
      await refreshAll();
    } catch (err) { toast(err.message, 4000); button.disabled = false; }
  }

  async function restoreOne(t, quiet) {
    try {
      await api('POST', '/api/todos/' + t.id + '/restore');
      toast(quiet ? 'Restored' : 'Restored "' + t.title + '"');
      if (state.editing && state.editing.id === t.id) closeDrawer();
      await refreshAll();
    } catch (err) { toast(err.message, 4000); }
  }

  function replaceResult(t) {
    const i = state.results.findIndex((x) => x.id === t.id);
    if (i >= 0) state.results[i] = t;
    if (state.editing && state.editing.id === t.id) state.editing = t;
  }

  async function refreshAll() {
    await loadMeta();
    renderSidebar();
    if (state.route.page === 'todos') await doSearch();
  }

  // ------------------------------------------------------------------ settings page (tabs)
  const TAB_DEFS = [['general', 'Settings', 'settings'], ['setup', 'Setup checklist', 'setup'], ['data', 'Import and export', 'data']];
  let settingsSeq = 0;
  function pageShell(title, inner) {
    $('.top').classList.add('hidden');
    $('#toolbar').innerHTML = '';
    document.title = title + ' | TodoNow';
    $('#content').innerHTML = '<div class="page"><h1>' + esc(title) + '</h1>' + inner + '</div>';
  }
  function tabShell(inner) { const b = $('#tabBody'); if (b) b.innerHTML = inner; }

  async function renderSettingsPage(tab) {
    tab = tab || 'general';
    const seq = ++settingsSeq;
    pageShell('Settings',
      '<div class="tabs" role="tablist">' + TAB_DEFS.map(([k, label, ico]) => '<a role="tab" href="#/settings' + (k === 'general' ? '' : '/' + k) + '" class="tab' + (k === tab ? ' on' : '') + '" aria-selected="' + (k === tab) + '">' + NAV_ICONS[ico] + esc(label) + (k === 'setup' && state.meta && !state.meta.setupComplete ? '<span class="dot" title="Steps left"></span>' : '') + '</a>').join('') + '</div>' +
      '<div id="tabBody"><div class="card-box"><span class="spin"></span></div></div>');
    document.title = TAB_DEFS.find((t) => t[0] === tab)[1] + ' | TodoNow';
    const guard = () => seq === settingsSeq && $('#tabBody');
    if (tab === 'setup') await renderSetupPage(guard);
    else if (tab === 'data') await renderDataTab(guard);
    else await renderGeneralTab(guard);
  }

  // The bookmarklet button and its Copy button, shared by the Settings tab and the setup
  // checklist. bindBookmarklet wires the copy and stops a plain click from running it here.
  function bookmarkletHtml(bm, id) {
    return '<a class="btn bm" id="' + id + '" href="' + esc(bm.href) + '" title="Drag me to the bookmarks bar"><img src="/favicon.svg" alt="" draggable="false"> TodoNow</a> <button class="btn sm ghost" id="' + id + 'Copy" title="Copy the bookmarklet code to paste into a new bookmark by hand">Copy code</button>';
  }
  function bindBookmarklet(bm, id) {
    const a = $('#' + id);
    if (a) a.onclick = (e) => { e.preventDefault(); toast('Drag this button to the bookmarks bar; clicking it here does nothing.', 3000); };
    const b = $('#' + id + 'Copy');
    if (b) b.onclick = () => copy(bm.href, 'Bookmarklet code copied');
  }

  async function renderGeneralTab(guard) {
    const m = state.meta || (await loadMeta());
    let health, bm;
    try { [health, bm] = await Promise.all([api('GET', '/api/health'), api('GET', '/api/bookmarklet')]); } catch (err) { tabShell('<div class="alert error">' + esc(err.message) + '</div>'); return; }
    if (guard && !guard()) return;
    const s = m.settings;
    const timeOpt = (v, label, cur) => '<option value="' + v + '"' + (Number(cur) === v ? ' selected' : '') + '>' + label + '</option>';
    tabShell(
      '<div class="card-box"><h2>Reminders</h2>' +
      '<p class="small muted">Notifications come from this Mac through macOS Notification Center. The service checks every 30 seconds; nothing leaves your machine.</p>' +
      '<div class="row2"><div class="field checks"><label><input type="checkbox" id="sDailyOn" ' + (s.dailyReminder.enabled ? 'checked' : '') + '> Daily summary of open, due and overdue todos</label></div>' +
      '<div class="field"><label>Daily summary time</label><input type="time" id="sDailyTime" value="' + esc(s.dailyReminder.time) + '"><div class="help">Shown once a day, shortly after this time (or when the Mac wakes).</div></div></div>' +
      '<div class="row2"><div class="field checks"><label><input type="checkbox" id="sDeadlineOn" ' + (s.deadlineReminder.enabled ? 'checked' : '') + '> Notify before deadlines</label></div>' +
      '<div class="field"><label>Default notice</label><select id="sDeadlineMin">' + timeOpt(0, 'At the deadline', s.deadlineReminder.minutesBefore) + timeOpt(15, '15 minutes before', s.deadlineReminder.minutesBefore) + timeOpt(30, '30 minutes before', s.deadlineReminder.minutesBefore) + timeOpt(60, '1 hour before', s.deadlineReminder.minutesBefore) + timeOpt(180, '3 hours before', s.deadlineReminder.minutesBefore) + timeOpt(1440, '1 day before', s.deadlineReminder.minutesBefore) + '</select><div class="help">Each todo can override this in its Reminder field.</div></div></div>' +
      '<div class="row2"><div class="field checks"><label><input type="checkbox" id="sQuietOn" ' + (s.quietHours.enabled ? 'checked' : '') + '> Quiet hours</label></div>' +
      '<div class="field"><label>Quiet from / until</label><div class="row2"><input type="time" id="sQuietStart" value="' + esc(s.quietHours.start) + '"><input type="time" id="sQuietEnd" value="' + esc(s.quietHours.end) + '"></div><div class="help">Held notifications are shown after quiet hours end.</div></div></div>' +
      '<div class="actions"><button class="btn primary" id="sSave">Save settings</button><button class="btn" id="sTest">Send a test notification</button><button class="btn ghost" id="sOpenNotif" title="System Settings > Notifications, on the TodoNow entry">Notification settings</button><span id="sMsg" class="small muted"></span></div></div>' +

      '<div class="card-box"><h2>General</h2>' +
      '<div class="row2"><div class="field"><label>Theme</label><select id="sTheme"><option value="system"' + (s.theme === 'system' ? ' selected' : '') + '>Follow the system</option><option value="light"' + (s.theme === 'light' ? ' selected' : '') + '>Light</option><option value="dark"' + (s.theme === 'dark' ? ' selected' : '') + '>Dark</option></select><div class="help">Same palette as Golinks; the system choice switches with macOS.</div></div>' +
      '<div class="field"><label>Keep deleted todos for (days)</label><input type="number" id="sTrash" min="1" max="3650" value="' + (s.trashDays || 30) + '"><div class="help">Deleted todos wait in the <a href="#/trash">Trash</a> and can be restored. After this many days they are removed for good.</div></div></div>' +
      '<div class="row2"><div class="field"><label>Port</label><input type="number" id="sPort" min="1024" max="65535" value="' + s.port + '"><div class="help">Active: ' + health.port + '. Changing the port needs <code>bin/todonow restart</code>.</div></div></div>' +
      '<div class="actions"><button class="btn primary" id="sSaveGeneral">Save</button><span id="sGeneralMsg" class="small muted"></span></div></div>' +

      '<div class="card-box"><h2>Capture</h2>' +
      '<p><b>From any web page:</b> drag this to the bookmarks bar, then click it on a page to turn it into a todo with the page attached: ' + bookmarkletHtml(bm, 'bmLink') + '</p>' +
      '<p><b>From Terminal:</b> <code>bin/todonow add "Call Alice" People/Alice</code>. The <a href="#/settings/setup">setup checklist</a> has the details.</p></div>' +

      '<div class="card-box"><h2>Keyboard</h2>' +
      '<div class="shortcuts-help">' +
      '<span><kbd>&#8984;K</kbd> or <kbd>/</kbd></span><span>Search. Operators: <code>in:People/Alice</code> <code>tag:phone</code> <code>due:today</code> <code>due:week</code> <code>planned:today</code> <code>is:overdue</code> <code>is:now</code> <code>is:unfiled</code> <code>priority:high</code></span>' +
      '<span><kbd>A</kbd></span><span>Focus the quick-add line. <kbd>&#8629;</kbd> adds to the current view, <kbd>&#8984;&#8629;</kbd> adds and opens the full form.</span>' +
      '<span><kbd>N</kbd></span><span>New todo with the full form</span>' +
      '<span><kbd>&uarr;</kbd> <kbd>&darr;</kbd> <kbd>&#8629;</kbd></span><span>Move between todos and open one</span>' +
      '<span><kbd>space</kbd></span><span>Complete or reopen the highlighted todo</span>' +
      '<span><kbd>X</kbd> <kbd>&#8984;A</kbd></span><span>Select for a bulk action (Shift+click for a range), select all</span>' +
      '<span><kbd>L</kbd></span><span>Switch between list and grid</span>' +
      '<span><kbd>&#8984;S</kbd> <kbd>esc</kbd></span><span>Save or close the edit drawer</span>' +
      '</div></div>' +

      '<div class="card-box"><h2>Service</h2>' +
      '<div class="shortcuts-help"><span class="muted">Version</span><span>' + esc(health.version) + '</span><span class="muted">PID</span><span>' + health.pid + '</span><span class="muted">Uptime</span><span>' + Math.floor(health.uptimeSec / 60) + ' min</span><span class="muted">Address</span><span><code>http://127.0.0.1:' + health.port + '</code></span><span class="muted">Data</span><span><code>' + esc(health.home) + '/data</code></span><span class="muted">Node</span><span>' + esc(health.node) + '</span></div>' +
      (m.restartNeeded ? '<div class="alert warn">The code on disk is newer than the running service. Click Restart to pick it up.</div>' : '') +
      '<div class="actions"><button class="btn primary" id="sRestart">Restart service</button><span id="sRestartMsg" class="small muted"></span><span class="grow"></span><button class="btn danger" id="sQuit">Stop service</button><span class="small muted">Stays stopped until you log in again or run <code>bin/todonow start</code>.</span></div></div>');

    $('#sSave').onclick = async () => {
      try {
        const r = await api('PUT', '/api/settings', {
          dailyReminder: { enabled: $('#sDailyOn').checked, time: $('#sDailyTime').value },
          deadlineReminder: { enabled: $('#sDeadlineOn').checked, minutesBefore: Number($('#sDeadlineMin').value) },
          quietHours: { enabled: $('#sQuietOn').checked, start: $('#sQuietStart').value, end: $('#sQuietEnd').value },
        });
        state.meta.settings = r.settings;
        $('#sMsg').textContent = 'Saved.';
      } catch (err) { $('#sMsg').textContent = err.message; }
    };
    $('#sTest').onclick = async () => {
      $('#sMsg').innerHTML = '<span class="spin"></span> sending';
      try { await api('POST', '/api/reminders/test'); $('#sMsg').textContent = 'Sent. If nothing appeared, allow notifications for ' + (state.meta && state.meta.notifierApp ? 'TodoNow' : 'Script Editor') + ' in System Settings > Notifications.'; }
      catch (err) { $('#sMsg').textContent = err.message; }
    };
    $('#sOpenNotif').onclick = async () => { try { await api('POST', '/api/open-settings'); toast('System Settings is opening'); } catch (err) { toast(err.message, 4000); } };
    $('#sSaveGeneral').onclick = async () => {
      try {
        const r = await api('PUT', '/api/settings', { theme: $('#sTheme').value, trashDays: Number($('#sTrash').value), port: Number($('#sPort').value) });
        state.meta.settings = r.settings;
        applyTheme(r.settings.theme);
        $('#sGeneralMsg').textContent = r.restartRequired ? 'Saved. Restart required for the port change.' : 'Saved.';
      } catch (err) { $('#sGeneralMsg').textContent = err.message; }
    };
    bindBookmarklet(bm, 'bmLink');
    $('#sTheme').onchange = () => applyTheme($('#sTheme').value);
    $('#sRestart').onclick = () => restartService($('#sRestart'), $('#sRestartMsg'), () => { loadMeta().then(() => { renderSidebar(); renderSettingsPage('general'); }); });
    $('#sQuit').onclick = async (e) => {
      const b = e.currentTarget;
      if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Confirm stop'; setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Stop service'; }, 3000); return; }
      try { await api('POST', '/quit'); } catch { /* connection drops */ }
      $('#content').innerHTML = '<div class="empty"><b>Service stopped</b>Start it again with <code>bin/todonow start</code>.</div>';
      setTimeout(() => setDown(true), 500);
    };
  }

  async function renderDataTab(guard) {
    const m = state.meta || (await loadMeta());
    let preview = null;
    try { preview = await api('GET', '/api/export?preview=1'); } catch { /* shown below */ }
    if (guard && !guard()) return;
    const c = m.counts;
    tabShell(
      '<div class="card-box"><h2>Export</h2>' +
      '<p class="small muted">Every todo (open, completed and in the trash), the folder list and your settings as one JSON file. The format for backups and for moving TodoNow between Macs.</p>' +
      '<div class="actions"><button class="btn primary" id="xGo">Download ' + (preview ? esc(preview.filename) : 'export') + '</button><span class="small muted">' + (preview ? plural(preview.count, 'todo') + ', ' + plural(preview.folders, 'folder') : '') + '</span></div></div>' +

      '<div class="card-box"><h2>Import</h2>' +
      '<p class="small muted">Reads a TodoNow JSON export. Todos are added next to the ones you have; an id that is already in use gets a new one. Folders in the file are created too.</p>' +
      '<div class="actions"><label class="btn primary">Choose file<input type="file" id="iFile" class="hidden" accept=".json,application/json"></label><span id="iMsg" class="small muted"></span></div>' +
      '<div id="iPreview"></div></div>' +

      '<div class="card-box"><h2>Backups</h2>' +
      '<p class="small muted">Every write goes to a temporary file first and keeps the previous copy beside it as <code>.bak</code>. The first write of each day also saves <code>data/backups/todos-YYYY-MM-DD.json</code>; the last 14 are kept. To restore one, stop the service, copy the file over <code>data/todos.json</code>, and start it again.</p>' +
      '<div class="shortcuts-help"><span class="muted">Data folder</span><span><code>' + esc(m.home) + '/data</code></span><span class="muted">Open</span><span>' + (c.open || 0) + '</span><span class="muted">Completed</span><span>' + (c.completed || 0) + '</span><span class="muted">In the trash</span><span>' + (c.trash || 0) + '</span></div></div>' +

      '<div class="card-box danger-zone"><h2>Empty the trash</h2>' +
      '<p class="small muted">Deleted todos wait in the <a href="#/trash">Trash</a> for ' + (m.settings.trashDays || 30) + ' days and are then removed on their own. This removes them now.</p>' +
      '<div class="actions"><button class="btn danger" id="dEmpty" ' + (c.trash ? '' : 'disabled') + '>Empty trash (' + (c.trash || 0) + ')</button><span id="dEmptyMsg" class="small muted"></span></div></div>');

    $('#xGo').onclick = () => {
      const a = document.createElement('a');
      a.href = '/api/export';
      a.download = '';
      document.body.appendChild(a); a.click(); a.remove();
      toast('Export started');
    };
    $('#iFile').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      e.target.value = '';
      let data;
      try { data = JSON.parse(await f.text()); } catch { $('#iMsg').textContent = 'That file is not valid JSON.'; return; }
      if (!data || !Array.isArray(data.todos)) { $('#iMsg').textContent = 'That file has no todos array. Use a TodoNow export.'; return; }
      const n = data.todos.length;
      const ok = await dialog({ input: false, ok: 'Import', title: 'Import ' + plural(n, 'todo') + ' from ' + f.name + '?', message: 'They are added next to your current todos' + (Array.isArray(data.folders) && data.folders.length ? ', along with ' + plural(data.folders.length, 'folder') : '') + '. Nothing is replaced.' });
      if (!ok) return;
      $('#iMsg').innerHTML = '<span class="spin"></span> importing';
      try {
        const r = await api('POST', '/api/import', { todos: data.todos, folders: data.folders });
        $('#iMsg').textContent = 'Imported ' + plural(r.added, 'todo') + (r.foldersAdded ? ' and ' + plural(r.foldersAdded, 'folder') : '') + (r.skipped.length ? ', skipped ' + r.skipped.length : '') + '.';
        $('#iPreview').innerHTML = r.skipped.length ? '<div class="alert warn">Skipped: ' + r.skipped.slice(0, 8).map((s) => esc(s.title) + ' <span class="muted">(' + esc(s.reason) + ')</span>').join(', ') + (r.skipped.length > 8 ? ' and ' + (r.skipped.length - 8) + ' more' : '') + '</div>' : '';
        await loadMeta(); renderSidebar();
        toast('Imported ' + plural(r.added, 'todo'));
      } catch (err) { $('#iMsg').textContent = err.message; }
    };
    $('#dEmpty').onclick = async () => {
      const ok = await dialog({ input: false, ok: 'Empty trash', danger: true, title: 'Empty the trash?', message: plural(c.trash, 'todo') + ' ' + (c.trash === 1 ? 'is' : 'are') + ' removed permanently. This cannot be undone.' });
      if (!ok) return;
      try {
        const r = await api('POST', '/api/trash/empty');
        $('#dEmptyMsg').textContent = 'Removed ' + r.deleted + '.';
        await loadMeta(); renderSidebar(); renderSettingsPage('data');
      } catch (err) { $('#dEmptyMsg').textContent = err.message; }
    };
  }

  // ------------------------------------------------------------------ doctor and setup
  async function renderDoctor(el) {
    el.innerHTML = '<span class="spin"></span> checking';
    let d;
    try { d = await api('GET', '/api/doctor'); } catch (err) { el.innerHTML = '<div class="alert error">' + esc(err.message) + '</div>'; return null; }
    el.innerHTML = '<div class="checks">' + d.checks.map((c) =>
      '<div class="check ' + (c.ok === true ? 'ok' : c.ok === false ? 'fail' : 'skip') + '"><span class="mark">' + (c.ok === true ? '&#10003;' : c.ok === false ? '&#10007;' : '&#8226;') + '</span>' +
      '<div><div>' + esc(c.label) + (c.detail ? ' <span class="muted small">' + esc(c.detail) + '</span>' : '') + '</div>' +
      (c.ok === false && c.fix ? '<div class="small fix">' + esc(c.fix) + '</div>' : '') + '</div></div>').join('') + '</div>' +
      (d.restartNeeded ? '<div class="alert warn">The code on disk is newer than the running service. Use the Restart button under Settings, or run <code>bin/todonow restart</code> in Terminal.</div>' : '');
    return d;
  }

  async function markSetup(key, value) {
    await api('PUT', '/api/settings', { setup: { [key]: value } });
    await loadMeta();
  }

  async function renderSetupPage(guard) {
    const m = await loadMeta();
    let bm;
    try { bm = await api('GET', '/api/bookmarklet'); } catch (err) { tabShell('<div class="alert error">' + esc(err.message) + '</div>'); return; }
    if (guard && !guard()) return;
    const done = (m.settings.setup) || {};
    // Running under launchd proves the login agent is installed; mark that step by itself.
    if (m.underLaunchd && !done.agent) { await markSetup('agent', true); if (guard && !guard()) return; return renderSetupPage(guard); }
    const step = (key, title, body, auto) =>
      '<div class="step ' + (done[key] || auto ? 'done' : '') + '" data-step="' + key + '"><div class="step-head"><span class="mark">' + (done[key] || auto ? '&#10003;' : '') + '</span><h3>' + title + '</h3>' +
      (auto ? '' : '<button class="btn sm ghost" data-toggle="' + key + '">' + (done[key] ? 'Undo' : 'Mark done') + '</button>') + '</div><div class="step-body">' + body + '</div></div>';
    const copyRow = (label, value, what) => '<span>' + label + '</span><span class="copyval"><code>' + esc(value) + '</code><button class="btn sm" data-copy-text="' + esc(value) + '" data-copy-what="' + esc(what || label) + '">Copy</button></span>';
    tabShell(
      '<p class="muted">Three short steps and two optional ones. TodoNow works without them, but each one makes it more useful. Mark a step done when you have finished it; the service step checks itself.' + (m.setupComplete ? ' <b>All done.</b>' : '') + '</p>' +

      step('agent', 'TodoNow starts when you log in',
        m.underLaunchd
          ? '<p>Version ' + esc(m.version) + ' is running as a login agent and comes back on its own after a crash or a restart of the Mac. Nothing to do here.</p>'
          : '<p>TodoNow is running, but it was started by hand, so it stops when the Terminal closes. Run the installer once so it starts at every login:</p><div class="kv">' + copyRow('Terminal', m.root + '/install.sh', 'install command') + '</div><p class="small muted">Then reload this page; the step marks itself.</p>', m.underLaunchd) +

      step('notifications', 'Allow notifications',
        '<p>Reminders arrive as macOS notifications. The first one may be silent until macOS knows they are wanted.</p>' +
        '<ol class="steps">' +
        '<li>Click <button class="btn sm" id="setupTest">Send a test notification</button> <span id="setupTestMsg" class="small muted"></span></li>' +
        (m.notifierApp
          ? '<li>macOS files a new sender as off until you allow it. <button class="btn sm" id="setupOpenNotif">Open Notification settings</button> lands on <b>TodoNow</b>: turn <b>Allow notifications</b> on and pick <b>Banners</b> or <b>Alerts</b>. Focus modes also hide notifications.</li>'
          : '<li>If nothing appears, open <b>System Settings &gt; Notifications</b>, find <b>Script Editor</b> (without the notification app, macOS shows AppleScript notifications under that name) and allow notifications for it. Focus modes also hide them.</li><li class="muted">Run <code>bin/todonow notifier</code> once to get the TodoNow name and icon on notifications.</li>') +
        '<li>Set the daily summary time and the default notice under <a href="#/settings">Settings</a>.</li>' +
        '</ol>') +

      step('bookmarklet', 'Save any web page as a todo',
        '<p>The <b>TodoNow</b> button below is a bookmark that turns the page you are looking at into a todo, with the page attached and any selected text as notes. It works on pages behind company sign-in too.</p>' +
        '<ol class="steps">' +
        '<li>Show your bookmarks bar if it is hidden: press <kbd>&#8984;</kbd><kbd>Shift</kbd><kbd>B</kbd> (Chrome, Brave, Edge and Safari all use it).</li>' +
        '<li>Drag this button onto that strip and let go: ' + bookmarkletHtml(bm, 'setupBm') + '</li>' +
        '<li>Try it: open any web page and click <b>TodoNow</b> in the bookmarks bar. A small window shows the title, folder, dates and tags; click <b>Add todo</b> (or press <kbd>&#8984;</kbd><kbd>&#8629;</kbd>).</li>' +
        '</ol>' +
        '<p class="small muted">If dragging does not work in your browser: click <b>Copy code</b> above, right-click the bookmarks bar and choose <b>Add page</b> (Chrome, Brave), <b>Add this page to favorites</b> (Edge) or <b>Add Bookmark</b> (Safari, from the Bookmarks menu). Name it <code>TodoNow</code> and paste the copied code into the address or URL field.</p>') +

      step('capture', 'Add todos from the Terminal <span class="opt">optional</span>',
        '<p>The <code>bin/todonow</code> script talks to the running service, so a todo can be added from a script or a Terminal alias:</p>' +
        '<div class="kv">' + copyRow('Add', 'bin/todonow add "Call Alice"', 'add command') + copyRow('Today', 'bin/todonow today', 'today command') + copyRow('Search', 'bin/todonow search "in:People"', 'search command') + copyRow('Done', 'bin/todonow done <id>', 'done command') + '</div>' +
        '<p class="small muted">The stable path <code>~/.todonow/bin/todonow</code> works from anywhere once installed.</p>') +

      step('import', 'Bring in an export <span class="opt">optional</span>',
        '<p>Moving from another Mac? Import the JSON export there under <a href="#/settings/data">Import and export</a>.</p>') +

      '<div class="card-box"><h2>Health</h2><div id="setupDoctor"></div><div class="actions"><button class="btn sm" id="setupDoctorRun">Re-check</button></div></div>');
    $$('[data-copy-text]').forEach((b) => (b.onclick = () => copy(b.dataset.copyText, b.dataset.copyWhat + ' copied')));
    bindBookmarklet(bm, 'setupBm');
    $$('[data-toggle]').forEach((b) => (b.onclick = async () => { await markSetup(b.dataset.toggle, !done[b.dataset.toggle]); renderSidebar(); renderSettingsPage('setup'); }));
    $('#setupTest').onclick = async () => {
      const msg = $('#setupTestMsg');
      msg.innerHTML = '<span class="spin"></span> sending';
      try { await api('POST', '/api/reminders/test'); msg.textContent = 'Sent. Saw it? Mark this step done.'; }
      catch (err) { msg.textContent = 'Not yet: ' + err.message; }
    };
    const on = $('#setupOpenNotif');
    if (on) on.onclick = async () => { try { await api('POST', '/api/open-settings'); toast('System Settings is opening'); } catch (err) { toast(err.message, 4000); } };
    const dEl = $('#setupDoctor');
    $('#setupDoctorRun').onclick = () => renderDoctor(dEl);
    renderDoctor(dEl);
  }

  async function copy(text, msg) {
    try { await navigator.clipboard.writeText(text); toast(msg || 'Copied'); return true; } catch { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      toast(ok ? (msg || 'Copied') : 'Copy failed, select the text and press Cmd+C', ok ? 2200 : 4000);
      return ok;
    } catch { toast('Copy failed, select the text and press Cmd+C', 4000); return false; }
  }

  // Ask the service to restart itself (launchd brings it back), wait for the new process,
  // then call `after`. Falls back to Terminal instructions when it is not run by launchd.
  async function restartService(button, msgEl, after) {
    button.disabled = true;
    msgEl.innerHTML = '<span class="spin"></span> restarting';
    let before = null;
    try { before = (await api('GET', '/api/health')).pid; } catch { /* ignore */ }
    let r;
    try { r = await api('POST', '/api/restart'); } catch { r = { relaunch: true }; }
    if (r && r.relaunch === false) {
      msgEl.innerHTML = 'TodoNow was started by hand, so it cannot restart itself. In Terminal, press Ctrl+C where it runs and start it again, or run <code>bin/todonow restart</code>.';
      button.disabled = false;
      return;
    }
    const t0 = Date.now();
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    while (Date.now() - t0 < 30000) {
      await sleep(1000);
      try {
        const h = await fetch('/api/health').then((x) => x.json());
        if (h && h.ok && h.pid !== before) {
          setDown(false);
          msgEl.textContent = 'Restarted.';
          toast('TodoNow restarted');
          button.disabled = false;
          if (after) after();
          return;
        }
      } catch { /* still coming back */ }
    }
    msgEl.innerHTML = 'Still not back after 30 seconds. In Terminal, run <code>bin/todonow start</code>.';
    button.disabled = false;
  }

  // ------------------------------------------------------------------ boot
  async function boot() {
    // ?layout=grid|list picks the layout up front (handy for links and screenshots).
    const qs = new URLSearchParams(location.search);
    if (qs.get('layout') === 'grid' || qs.get('layout') === 'list') {
      state.layout = qs.get('layout');
      try { localStorage.setItem('todonow.layout', state.layout); } catch { /* ignore */ }
      history.replaceState(null, '', '/' + (location.hash || '#/'));
    }
    await loadMeta();
    if (state.meta && state.meta.counts.all === 0 && !(state.meta.settings.setup && state.meta.settings.setup.seen) && !location.hash) {
      location.hash = '#/settings/setup';
      markSetup('seen', true);
    }
    window.addEventListener('hashchange', onRoute);
    await onRoute();
    // Counts drift as the day moves on (overdue, today); refresh them now and then.
    setInterval(async () => {
      if (document.hidden || state.editing || state.sel.size) return;
      const before = JSON.stringify(state.meta && state.meta.counts);
      await loadMeta();
      if (state.meta && JSON.stringify(state.meta.counts) !== before) { renderSidebar(); if (state.route.page === 'todos') doSearch(); }
    }, 30000);
  }
  boot();
})();
