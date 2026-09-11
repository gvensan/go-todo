# TodoNow bookmarklet

A bookmark that turns the page you are looking at into a todo. It runs in the
page itself, so it sees SSO pages exactly as you do, and opens a small popup
served by the local service where you set the folder, a date and tags.

## Install

1. Open the web UI, go to Settings > Setup checklist (or the Capture card under
   Settings).
2. Drag the "TodoNow" button to the bookmarks bar of any browser.
   Alternatively click "Copy code" and create a bookmark with the copied
   `javascript:` URL as its address.

## What it sends

Only to `http://localhost:<port>/add`: the page URL, the document title and up
to 500 characters of selected text (which becomes the notes). Nothing leaves
the machine. The URL is stored on the todo and shown as a link in every list
and in the edit drawer.
