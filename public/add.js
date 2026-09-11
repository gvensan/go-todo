/* "Add to TodoNow" popup opened by the bookmarklet. */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const qs = new URLSearchParams(location.search);
  const url = qs.get('url') || '';
  $('#url').textContent = url;
  $('#title').value = qs.get('title') || '';
  $('#notes').value = qs.get('selection') || '';
  const chips = chipEditor($('#tags'), {});
  const folderPick = folderPicker($('#folder'), { placeholder: 'No folder' });

  function dayKey(offset) {
    const d = new Date();
    d.setDate(d.getDate() + (offset || 0));
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  document.querySelectorAll('[data-plan]').forEach((b) => (b.onclick = () => { $('#planned').value = dayKey(Number(b.dataset.plan)); }));

  async function api(method, path, body) {
    const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || res.statusText); e.data = data; e.status = res.status; throw e; }
    return data;
  }

  async function init() {
    if (!url) { $('#info').innerHTML = '<div class="alert error">No page given. Use the bookmarklet from a page.</div>'; }
    try {
      const [meta, same] = await Promise.all([api('GET', '/api/meta'), url ? api('GET', '/api/todos?view=open&q=' + encodeURIComponent(url)) : { todos: [] }]);
      chips.setAll(meta.tags.map((t) => t.name));
      folderPick.setFolders(meta.folders);
      if (meta.settings && (meta.settings.theme === 'light' || meta.settings.theme === 'dark')) document.documentElement.dataset.theme = meta.settings.theme;
      const dup = same.todos.find((t) => t.url === url);
      if (dup) $('#info').innerHTML = '<div class="alert warn">An open todo already points at this page: "' + esc(dup.title) + '". Adding again makes a second one.</div>';
    } catch (err) {
      $('#info').innerHTML = '<div class="alert error">' + esc(err.message) + '</div>';
    }
    $('#title').focus();
    $('#title').select();
  }

  async function save() {
    const title = $('#title').value.trim();
    if (!title) { $('#title').focus(); $('#status-line').textContent = 'A title is needed.'; return; }
    $('#save').disabled = true;
    $('#status-line').innerHTML = '<span class="spin"></span>';
    try {
      const body = {
        title, url, folder: folderPick.get(), tags: chips.get(), notes: $('#notes').value,
        dueAt: $('#due').value ? new Date($('#due').value).toISOString() : null,
        plannedDate: $('#planned').value || null,
        priority: $('#priority').value, status: $('#status').value,
        nowOrder: $('#now').checked ? Date.now() : null,
      };
      const r = await api('POST', '/api/todos', body);
      $('#form').classList.add('hidden');
      const d = $('#saved');
      d.classList.remove('hidden');
      d.innerHTML = '<b>Added</b><div class="muted">' + esc(r.todo.title) + '</div><div class="small muted" style="margin-top:14px">This window closes in a moment.</div>';
      setTimeout(() => window.close(), 1200);
    } catch (err) {
      $('#save').disabled = false;
      $('#status-line').textContent = err.message;
    }
  }

  $('#save').onclick = save;
  $('#cancel').onclick = () => window.close();
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape' && !e.defaultPrevented) window.close();
  });
  init();
})();
