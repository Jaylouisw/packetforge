# `Not a valid host address - 0.0.0.1` — the blocks no mask makes a host address

**Question (one, narrow).** `Bad mask /24 for address …` is the sentence for an address that is not a host
*under the mask it was typed with* (research/ip-address-not-a-host.md). IOS has a second, different refusal that
names the address and no prefix at all. Which addresses get it, and does the mask matter?

**Verdict: known for two blocks, and adopted.** An address in **0.0.0.0/8** or **127.0.0.0/8** is refused, on any
interface type and with any mask, as

```
Not a valid host address - 0.0.0.1
```

— bare, no `%`, the address echoed as typed, and no prefix anywhere in the line. The mask does not enter into it:
the same sentence comes back for a /16 and a /24, and it wins over `Bad mask /32` when both would apply. The
model now refuses both blocks in that sentence and leaves every other reserved block alone, because the evidence
for the rest is one snippet, one screenshot, or nothing.

## The evidence

| Typed | Printed | Port | Source |
|---|---|---|---|
| `ip add 0.0.0.1 255.255.255.0` | `Not a valid host address - 0.0.0.1` | `int f0/1` on Rack1R1 | https://community.cisco.com/t5/switching/what-is-the-lowest-prefix-possible-and-the-lowest-ip/td-p/1214384 |
| `ip add 0.0.0.2 255.255.255.0` | `Not a valid host address - 0.0.0.2` | same | same |
| `ip add 1.0.0.1 255.255.255.0` | accepted (the next lines of the same paste) | same | same |
| `ip address 127.0.0.2 255.255.255.0` | `Not a valid host address - 127.0.0.2` | `interface loopback0` | https://learningnetwork.cisco.com/s/question/0D53i00000KsviSCAR/ping-127001-in-router-failed |
| `ip address 127.1.1.1 255.255.255.0` | `Not a valid host address - 127.1.1.1` | same | same |
| `ip address 127.0.0.100 255.255.0.0` | `Not a valid host address - 127.0.0.100` | `R2(config-if)` | https://learningnetwork.cisco.com/s/question/0D53i00000KszT6CAJ/ipv6-interface-loopback-address |

Four things those pastes establish rather than suggest:

1. **The sentence is bare and echoes the address.** No `%` marker, no prefix length, the address exactly as typed.
   It is the same shape as its `Bad mask` sibling, which is why the note on that rule cites this one as the second
   witness for the unmarked form.
2. **It is a block rule, not a subnet rule.** `127.1.1.1` is nowhere near `127.0.0.0/24` and is refused the same
   way; `0.255.255.254` is refused too (asserted here, extrapolated from `0.0.0.1`).
3. **The mask is irrelevant.** A /16 and a /24 print the same line. That is what the model keys on: the first
   octet, before the mask is looked at.
4. **The block is refused on the one interface type that takes a /32.** The 127/8 paste is on `loopback0`, which is
   precisely where a /32 is allowed (research/ip-address-not-a-host.md). So the `/32` allowance is a mask rule and
   does not reach this one - a loopback refuses 127/8 exactly as a routed port does.

The blocks themselves are what the address registries say they are: 0.0.0.0/8 is "this host on this network" and
127.0.0.0/8 is loopback, neither of which can be a host on a link
(https://www.rfc-editor.org/rfc/rfc6890.html, Table 1).

## What is inferred rather than witnessed

* **The range is asked before the mask.** No paste combines a reserved block with a mask that is itself wrong, so
  the order is an inference from the wording: the refusal names an address and never a prefix, and the same words
  serve two different mask lengths. The model asks the range first, so `ip address 127.0.0.1 255.255.255.255`
  answers `Not a valid host address - 127.0.0.1` and not `Bad mask /32 for address 127.0.0.1`.
* **The mask-contiguity check still runs first.** That check is this console's own parse-stage error
  (`% Invalid mask: …`), and `ip address 0.0.0.1 255.0.255.0` keeps answering it. Nothing in hand shows a box
  given a non-contiguous mask *and* a reserved address, so the existing order is left as it is.
* **0.0.0.0 itself is deliberately not covered.** The first octet of `0.0.0.0` is 0, so a naive block test would
  refuse `ip address 0.0.0.0 0.0.0.0` - and that command is the still-open `/0` question the sibling note declined
  to decide. The rule therefore excludes the exact address `0.0.0.0`, and a test pins that exclusion so nobody
  closes the `/0` question by accident.

## What is unresolved

* **224.0.0.0/4.** One comment on a CCNP lab-sim page reports the refusal for a multicast address, in a *shorter*
  form of the sentence - `Not a valid host address.`, with a full stop and no address echoed:

  ```
  Lynaic (config-if)#ip address 239.239.239.239 255.255.255.255
  Not a valid host address.
  ```

  (https://www.digitaltut.com/route-ospf-sim/comment-page-4 - a reader comment, reachable only as a search-index
  snippet; the page no longer renders its comments, so this was not read in place.) If that paste is faithful, two
  things follow that the model does **not** do: 224/4 is refused, and the sentence has a second spelling without
  the address. It is not adopted on one unverifiable paste with a different message. The model still accepts
  `ip address 224.0.0.1 255.255.0.0`.
  **What would settle it:** one raw paste of `ip address 224.0.0.1 255.255.255.0` on a physical port, and one of
  `239.239.239.239 255.255.255.255`, from a console rather than a comment.
* **255.255.255.255.** A Learning Network thread about that address has the asker show a screenshot of the refusal
  and an answer that quotes it back as `Not a valid host address`
  (https://learningnetwork.cisco.com/s/question/0D53i000011Yb4pCAC/ipv4-address-questions-part5). The mask typed is
  not in the text and there is no raw paste, so it cannot be told apart from the `Bad mask` sentence the model
  already prints for `255.255.255.255` under a /24 (its broadcast address) and under a /32.
  **What would settle it:** a paste of the command, mask included.
* **The `/0` case, unchanged.** `ip address 0.0.0.0 0.0.0.0` is accepted here, as it was before this change,
  because nothing in hand shows what a box does with it. **What would settle it:** one paste.
* **169.254.0.0/16 and the rest of the special-purpose table.** No evidence either way, and the model accepts
  them. This note does not claim a box accepts them - only that nothing in hand says it refuses them.
* **Whether the rule is "first octet" or a list of blocks.** Two blocks are witnessed, both single-octet, and the
  octet test reproduces both. A box could implement a longer list (224/4 would be the third entry). Nothing here
  distinguishes the two readings, and nothing depends on it until a third block is witnessed.
* **One message for every image?** All the pastes are classic IOS. IOS XE, NX-OS and ASA word their address
  refusals differently - an ASA guide says `Do not assign a host address (/32 ...)` for one
  (https://www.cisco.com/c/en/us/td/docs/security/asa/asa922/asdm722/general/asdm-722-general-config/interface-routed-tfw.html).
  This console speaks for the IOS family only.

## What the model does now

`_ipHostRefusal()` in `engine/cli.js`, at its top, before the `/32` and network/broadcast tests:

* first octet `0` (except the exact address `0.0.0.0`) or `127` returns
  `Not a valid host address - <address as typed>`;
* nothing is stored, so `iface.ip`, `iface.mask` and the DHCP flag are untouched and `show running-config` never
  carries the refused line;
* the sentence is bare - no `%` - matching the four pastes above and the `Bad mask` sibling;
* every other check keeps its order: mask contiguity first, then the range, then `/32`, then network/broadcast,
  then the overlap test.

`test/ip-address-not-a-host.test.js` - 43 checks (was 27): the exact line for `0.0.0.1` and `0.0.0.2`, the far end
of 0/8, `1.0.0.1` still taken, the port left unassigned in `show ip interface brief` and clean in
`show running-config`, the 127/8 pastes including `127.1.1.1`, a /16 under the same block, the range beating the
`/32` refusal, a held address surviving the refusal, a subinterface refused like its parent, the mask error still
winning, and `0.0.0.0 0.0.0.0` still accepted so the `/0` question stays open.
