Never resolve a device request by declaring it impossible

A device that cannot be modelled *yet* is still a real device that a real person asked for. Closing
that request deletes the interest and throws away the evidence that someone wanted it, in exchange
for a tidier backlog - a bad trade, and one this document previously encouraged.

The rule, in the place a maintainer will look for it: **no request is closed as unbuildable, not a
packet device, or impossible.** It is either in the catalogue, or it stays open with the exact thing
that is missing written down.

Three cases that used to end in a close, and what happens instead:

- **No conventional port count** - optical transport hides its ports behind a card complement; the
  answer is a *stated* configuration in the label (`OptiXtrans E6616 (14x B1LDCD)`, `OptiXtrans E6608
  (6x B1LDCD, DC chassis)`), not a refusal. Same for a modular chassis and for a licence-gated SKU.
- **No Ethernet ports at all** - an RF radio, a mesh extender, a cellular modem. These are still
  devices on a packet lab's bench, and "it has no Ethernet port" is a fact about the box, not a
  reason to forget the request.
- **Source unreachable today** - the issue keeps the note about which table was missing and where
  the search stopped, so the next attempt starts where this one ended.

When a request does close, it is because the catalogue answers it - and the comment names the file
that does. That is the only close this project uses for a device request.

## How a bad close gets caught

Nothing checked a closure against the catalogue until six requests had been closed as impossible
while their devices were already in `devices/`. The sweeper only looks at **open** issues, so a
close - right or wrong - leaves every automated view at once.

`scripts/check-closed-issues.js` reads the other side of the ledger: closed requests matched against
the catalogue, with the closing comments checked for the file they name. It prints three counts —
answered with evidence, possibly answered with none, and nothing in the catalogue — and lists the
middle group, because that is the shape a wrong close has. It never reopens, closes or fails a
build: it is a report, and the workflow that runs it on every push to `main` is
`.forgejo/workflows/closed-audit.yml`.

A close whose comment names no file is not automatically wrong. It is *uncheckable*, which for the
next person is the same thing.
