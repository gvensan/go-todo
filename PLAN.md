# TodoNow product contract

## Product shape

TodoNow is a local-only, keyboard-friendly personal todo application for one
person. It runs on port 7778 using the same operational model, UI shell and
visual system as Golinks. Its organizing primitive is a nested folder: a todo
has one home, which may describe a person, area, or project. Tags remain
optional cross-cutting labels.

## Primary flow

1. Capture a title into Inbox or the current context (quick-add line, N, CLI).
2. Give it a folder, deadline, or planning date when those are useful.
3. Pull a small number of todos into Now and use Today for daily planning.
4. Complete, defer (tomorrow, next week, a date), wait, or move the todo
   without losing its history; archive a folder when its project is done.
5. Let the daily digest and deadline notifications resurface important work.

## Technical constraints

- Bind only to `127.0.0.1`, default port 7778; refuse other hosts and
  cross-site writes.
- Node 18+, no runtime package dependencies, no compilation.
- Plain JSON storage with atomic writes, `.bak` copies, daily backups and hot
  reload.
- launchd login agent, CLI, install/uninstall/doctor lifecycle identical in
  shape to Golinks.
- macOS notifications through the already-present `osascript` command.
- Golinks tokens, app shell (sidebar, search box, toolbar, drawer, dialog,
  toast, fab, setup checklist), widgets (`folderpick.js`, `chips.js` are the
  same files) and system-following theme with an optional pinned theme.
- Every input validated on the server; the UI never uses browser
  `prompt`/`confirm`.

## Delivered

- Todo CRUD, complete/reopen, soft-delete/restore, permanent delete.
- Repeat daily to yearly with a series id and an anchor (weekday, day of
  month, date); missed occurrences skipped; next-occurrence preview; Skip;
  reopen and undo take back the spawned copy; a repeating todo needs a date.
- Nested folders: create, rename/move (ancestors kept), delete (todos move to
  the parent), tree with expand/collapse and filter, drag and drop for todos
  and folders, folder picker in the drawer.
- Views: All, Inbox, Today, Now, Upcoming, Waiting, Someday, Unfiled,
  Completed, Trash, plus folder and tag views. List or grid.
- Defer on rows, in bulk, by keyboard and CLI: moves the planned day, leaves
  Now, stamps deferredAt and deferCount; past the deadline it is offered as
  "moves deadline" (explicit flag, this occurrence only); Upcoming lists
  planned days as well as deadlines.
- Folder archiving with archivedAt: a finished project leaves every view,
  count, picker and reminder; Done > Archived lists it grouped by project;
  unarchive restores it and clears planned days that passed meanwhile. No per-todo
  archive (Someday, Completed and Trash cover that).
- Bulk select (hover checkbox, Shift+click, X, ⌘A) with complete, defer, move,
  Now, delete, restore, purge, and Undo.
- Daily, deadline, per-todo, snooze, quiet-hours and test notifications;
  reminder ledger; `bin/todonow remind`.
- Search with operators and highlighted terms.
- Settings: reminders, theme, trash retention, port, service restart/stop,
  keyboard reference; setup checklist with health checks; import/export with
  validation and a downloadable file; automatic trash expiry.
- "TodoNow" bookmarklet and `/add` popup; an optional `url` on every
  todo, shown as a link.
- Notifications posted by a locally generated applet so they carry the TodoNow
  name and icon, with an osascript fallback.
- Local CLI (`add`, `today`, `now`, `inbox`, `search`, `done`, `remind`) and
  launchd lifecycle; `--purge` uninstall.
- Tests for the store, folders, search, reminders and the HTTP API.

## Next sensible extensions

- Natural-language parsing for dates and folders during quick capture.
- Reordering the Now queue by drag and drop.
- Markdown/CSV import and export.
- A weekly review view (completed this week, stale waiting items).
