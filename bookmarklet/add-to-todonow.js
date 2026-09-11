// "Add to TodoNow" bookmarklet source. The service serves a minified javascript: URL
// at GET /api/bookmarklet with __PORT__ filled in. Keep this file free of
// single-line comments at the end of code lines; the minifier drops whole-line
// comments only.
//
// It runs inside the page you are looking at, so it works on SSO pages too. It sends
// only the page URL, the document title and up to 500 characters of selected text to
// the local service, which opens a small popup where you finish the todo.
(function () {
  var d = document;
  var sel = String(window.getSelection ? window.getSelection() : '').replace(/\s+/g, ' ').trim().slice(0, 500);
  var q = 'url=' + encodeURIComponent(location.href) +
    '&title=' + encodeURIComponent(d.title || '') +
    '&selection=' + encodeURIComponent(sel);
  var w = window.open('http://localhost:__PORT__/add?' + q, 'todonow', 'width=520,height=760,resizable=yes,scrollbars=yes,menubar=no,toolbar=no,location=no,status=no');
  if (!w) { location.href = 'http://localhost:__PORT__/add?' + q; }
})();
