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
