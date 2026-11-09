# Reporting a bug

The bar this project holds itself to: **you should not have to find out anything about PacketForge
to report a bug in it.** One click, one sentence about what you did, one about what you saw.

## The button

Top right, "Report a bug". It is a plain link, not a button, with the issue form pre-filled in its
`href` — so it works even when the app itself failed to load. That matters: the most valuable
reports arrive when the thing is broken, which is exactly when a JavaScript-driven button would
be dead.

When the app is running it adds the parts you cannot reasonably be asked to find:

| field | where it comes from | why it is there |
|---|---|---|
| PacketForge version | `GET /api/version` | "which build" is the first question and the last one answered |
| Node version and platform | the server | platform-specific bugs are otherwise indistinguishable from user error |
| Browser | `navigator.userAgent` | canvas and WebSocket bugs are browser-specific |
| Page | `location.href` | the app has tabs; the tab is often the bug |
| Catalogue size | the loaded catalogue | "no devices in the palette" means something different at 0 models than at 1,947 |

### Errors the app caught

The section most reports are missing. The app keeps a **bounded** record of what went wrong while
you were using it:

- uncaught exceptions — message, file, line, column and up to four stack frames;
- unhandled promise rejections — the same;
- failed assets — the URL that 404'd, because a missing image has no stack;
- `api()` failures — the method, the path and the status, including a server that never answered.

Five entries, newest kept, four stack frames each. A page that throws in a loop must not turn its
own bug report into a two-megabyte issue body.

If nothing was caught, the report says **"None since the page loaded"** rather than leaving the
section blank — and adds that for a visual bug the screenshot is the useful part. An empty section
reads like the app forgot to fill it in, which is worse than saying there was nothing.

## What still has to come from you

Two things, and only two:

1. **What you did.** "Added two switches and a link between them."
2. **What you saw, and what you expected.** "The link went red and the status said *unsupported
   cable*. I expected it to accept a Cat6 patch lead."

Screenshots help for anything visual: a canvas bug can be a rendering order problem that no error
message describes.

## When the popup blocker eats it

Some browsers block the new tab. The app then writes the finished report link to the browser
console (`console.warn`) **before** telling you it did, and the toast says where it went. The link
in the console is the same URL the tab would have opened — not a promise of one.

## When the server will not start

A server that cannot bind its port prints the reason and a prefilled bug-report link
(`server/startup-error.js`) for the four failures that account for almost all of them:
`EADDRINUSE`, `EACCES`, `EADDRNOTAVAIL` and an unknown option. Copy the whole block; the error code
is the diagnosis.

## When CI is the bug

If a check is red and the code looks fine, see [CI.md](CI.md) — it documents what each check
actually asserts, how to reproduce it locally, and the known failure where some pushes produce no
workflow runs at all.
