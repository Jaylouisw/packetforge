# Plan: three tables refuse the word that narrows them, and name no command that answers

Status: forward plan, no code. Measured on `e75e5c45`, 2026-11-27. Closes **no** open issue - the queue holds
zero open issues today; the only open work is three catalogue PRs (#2582, #2586, #2587). Steps 1-4 add command
forms the vendor has always had, over tables that already exist and already hold the data, so each is
**needs Jay's approval** on the spelling (every spelling below is quoted from the vendor's own syntax line).
Step 5 is docs and tests only.

This console's documented rule for a word a table cannot use is `docs/CLI.md:199`: the word is refused,
*"and where a narrower question has an answer, the refusal names the command that gives it"*. The rule is
sound, and the three tables below cannot follow it, because the narrower question has no command here at
all - so the reader is told to read a 52-row table and find the row themselves.

Measured today on an Aruba 2530-48 with two hosts (one frame each way, VLAN 20 named `SALES` on port 1):

```
sw1# show vlan id 20
% show vlan does not take "id 20": every VLAN is listed - the Id column is the VLAN number
sw1# show vlan name SALES
% show vlan does not take "name SALES": every VLAN is listed - the Id column is the VLAN number
sw1# show mac address-table vlan 20
% show mac address-table does not take "vlan 20": use `show mac address-table interface <port>` for one port
sw1# show mac address-table address 02:00:00:00:02:00
% show mac address-table does not take "address 02:00:00:00:02:00": use `show mac address-table interface <port>` for one port
sw1# show arp 10.0.0.3
% show arp does not take "10.0.0.3": the whole cache is listed - the Address column is the neighbour
```

## What exists today

| fact | evidence |
|---|---|
| the VLAN table takes `brief` and nothing else | `shortenedKeyword()` `engine/cli.js:431`, used at `:7391`; every other tail falls to the refusal at `:7392-7398`, which is reached by `id`, `name` and `mtu` alike |
| `brief` takes no id either | `:7396-7398` - `show vlan brief 20` is `% show vlan brief does not take "20": every VLAN is listed` |
| one MAC-table criterion is implemented, and only one | tail parser `:7944-7957` accepts `interface`/`int` and refuses everything else at `:7948-7949`; the filter itself is `:7989` |
| the MAC table's closing line already speaks the language of a criterion | `Total Mac Addresses for this criterion: N` `:8009`; reserved CPU rows are dropped from any filtered view `:7979`, and an empty filter says `(no entry learned on <port>)` `:7993` |
| the ARP table has no address form, by decision | `:7822-7830`; the refusal was added by #1403 because the old code printed the whole cache for one address, which reads as "that address is in the cache" |
| the model to copy already ships | `show ip dhcp binding <address or mac>` `:5637-5649` - one filter, a MAC in three spellings through `macSpelling()` `:150`, and an empty answer that names the value (`% No binding for ...`) |
| the abbreviation table is deliberately one entry deep | `research/show-tail-abbreviation.md:82` lists `brief` only, because `i` is `id` on one platform and `ifindex` on another; `test/show-tail-abbreviation.test.js:151-153` pins both `show vlan i` and `show vlan id 1` as refusals |
| what a single-VLAN view must print is already researched | `research/vlan-brief-trunk-ports.md:132` and `research/show-vlan-brief-etherchannel.md:88`: the vendor's `show vlan id <n>` prints **trunk and access** ports, while the multi-VLAN table prints access only - the rule this console applies at `:7421-7427` |
| the refusals are pinned by tests | `test/show-argument-refusal.test.js:88` (`show arp 10.0.0.2`) and `:91` (`show vlan 999`); `test/port-name-arguments.test.js:152` (a MAC filter it does not implement) |
| the docs state the refusal as behaviour | `docs/CLI.md:196` names `show arp <address>` and `show vlan <id>` among the words that are refused; `docs/CLI.md:3507` records `vlan 1` being refused on the MAC table |

## What is missing, ranked

1. **`show vlan id <n>`.** The most-asked membership question there is, and the refusal's advice ("the Id
   column is the VLAN number") is an index, not an answer: the port list is the whole point of the view.
2. **`show mac address-table vlan <n>` and `address <mac>`.** The vendor's syntax is
   `show mac address-table [address <mac>] [interface <intf>] [vlan <id>]`; one of the three works, and the
   closing "for this criterion" line implies the other two do.
3. **`show arp <address>` / `show ip arp <address>`.** #1403 was right to stop printing the whole cache; the
   half that is missing is the one-line answer, which the six-column renderer already produces.
4. **`show vlan name <name>`.** Same parser and renderer as (1); only the lookup differs, and a VLAN name is
   already unique (`research/vlan-name-length.md`).

Not weak, deliberately: `show ip interface brief <port>` (`:6954`) names `show interfaces <port>`, which is a
real answer, and `show spanning-tree <port>` and `show lldp neighbors <port>` name the row to read. The
policy holds there.

## Steps

**1. `show vlan id <n>` - M - needs Jay's approval on the spelling.** Parse `id <n>` in the `vlan` arm
(`:7385`), reusing `_vlanIdRefusal()` `:1433` for the value. One row from the same renderer, but the
membership rule for this form is the vendor's: **access and trunk** ports (`research/vlan-brief-trunk-ports.md:132`),
a second documented rule beside `:7421`. An unknown id is refused by name - and no capture of the vendor's
sentence is in `research/` today, so step 1 opens with a one-line capture note and uses this console's own
`% No VLAN <n>` shape meanwhile. An id a port still names after `no vlan` removed it prints no row, as the
multi-VLAN table already does (`:7423-7427`).

**2. `show vlan name <name>` - S - needs Jay's approval.** Same arm and renderer. The lookup is
case-insensitive over `dev.config.vlans`; an unknown name is refused with the name typed, not with the table.
No `mtu <id>`: the MTU lives in the media table this console prints only in the full view.

**3. `show mac address-table vlan <n>` and `address <mac>` - S - needs Jay's approval.** Extend the tail
parser at `:7944` to the vendor's three criteria, in any order; `only` becomes a predicate rather than a port
name so `:7989` still has one filter, and `(no entry learned ...)` `:7993` gains the two spellings it needs. A
MAC in any of the three spellings goes through `macSpelling()` as the DHCP filter does at `:5640`. Counts stay
"for this criterion" `:8009`; reserved rows stay out `:7979`.

**4. `show arp <address>` and the `show ip arp <address>` alias - S - needs Jay's approval.** Filter the
six-column table at `:7821` by an address checked with `net.isIp()` - a MAC is not an address, and gets
`% ... is not an IPv4 address`, not "no neighbour". The stale-port note the row already carries survives; an
empty answer names the address (`% No neighbour <ip> in the cache`) instead of printing a bare header. The
alias needs no second code path: `SHOW_IP_ALIASES` `:978` already routes `ip arp` here.

**5. Docs and tests - S.** `docs/CLI.md`: the refusal list `:196`, the MAC-table paragraph `:3507`, the
`show vlan` table entry `:30`, and one transcript per form. `_help()` `:8688-8690`. New
`test/show-selectors.test.js`. Rewrite, do not delete, the assertions that pin the old refusals:
`test/show-argument-refusal.test.js:88` and `:91`, `test/show-tail-abbreviation.test.js:151-153` (`show vlan i`
still refuses; `show vlan id 1` now answers).

## Risks

- **The renderer's membership rule is not the filter's.** Step 1 must print trunks; reusing `:7421` unchanged
  would make the single-VLAN form silently disagree with the vendor and with the note that settled it.
- **Two membership views that are allowed to differ.** A `vlan` filter on the MAC table lists addresses the box
  learned; `show vlan id` lists ports that are configured. `docs/CLI.md` must say so, or the next reader will
  call one of them a bug.
- **`_show()` is one long chain** (`docs/plans/show-view-seams.md`). Each step is one arm, in place.
- **Abbreviation creep.** `id` must not activate `show vlan i`; the edited test is the guard.

## Test strategy

Per step: a hit, a miss with the vendor's sentence, an empty filter, a bad value (VLAN 0, VLAN 4095, a word,
a non-address), and the untouched whole-table output byte for byte. Step 3 also: three MAC spellings, a VLAN
with no learned address, and the count line agreeing with the rows printed. Step 4: the stale-port note
survives the filter, and `show ip arp <address>` prints what `show arp <address>` prints. Then `npm test`
(the two suites above are the ones that must be edited) and `npm run check:citations`.

## Left out

`show mac address-table count`, `dynamic` and `static` - new view shapes, not filters, and the count line
already totals per criterion. `show vlan mtu <id>` - no MTU column to print it in. `show spanning-tree vlan
<n>` - the model runs one tree (`engine/stp.js:104`), so there is nothing per-VLAN to filter. `show ip
interface brief <port>` - the refusal names a command that answers. Nothing here changes engine state,
forwarding, the HTTP API or the web app, and every number in every other view is untouched.
