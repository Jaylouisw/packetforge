# Plan: the config prints a `no` line that deletes the group it sits in

Status: **step 2's VRRP half has landed** (2026-11-18: `engine/cli.js`, a new
`test/vrrp-no-form.test.js`, a `test/config-roundtrip.test.js` fixture and the `docs/CLI.md` VRRP section;
evidence in [research/vrrp-no-form-scope.md](../../research/vrrp-no-form-scope.md)). The rest is still a
forward plan, measured on `a45f9d85`, 2026-11-17 - the "What exists today" section below describes the
console as it was measured then. Closes **no** open issue - the queue is
six device/catalogue requests (#130, #803, #807, #808, #810, #1879) and none is about the console. Scope:
four `no` branches and one printer line in `engine/cli.js`, `test/config-roundtrip.test.js`, one new suite,
`docs/CLI.md:2870`. Steps 2-5 change CLI behaviour; step 5's encapsulation case can change a subinterface's
verdict and is called out under Risks. No forwarding or election change.

Distinct from `docs/plans/acl-binding-path.md` (which asks whether a binding is ever evaluated) and from
`docs/plans/show-help-key.md` (which asks what `?` answers): this is about what a `no` line *does*, and the
cases below are all in branches neither plan touches.

The console can set a value with one word and remove it only by deleting the object that holds it. For VRRP
that reaches a state the printer writes out and the parser reads back as a deletion: a running-config with
`vrrp 10 priority 120` and `no vrrp 10 preempt` in it replays to **zero** VRRP groups.

## What exists today

**The shape done right.** Three attributes of one protocol, each removable on its own, each receipt naming the
attribute rather than the container:

```
(config-if)#ip ospf cost 20          -> OSPF cost 20 on Gi1/0/1
(config-if)#no ip ospf cost         -> OSPF cost reset on Gi1/0/1
(config-if)#no ip ospf area         -> OSPF area reset on Gi1/0/1
(config-if)#no ip ospf passive      -> OSPF active on Gi1/0/1
```

**VRRP reads the id and nothing after it.** `_vrrpIfaceCommand()` (`engine/cli.js:3029`) sets `priority`
(3078), `preempt` (3086) and `advertise`. The removal is not there: it is a bare branch in interface mode,
`engine/cli.js:1691-1700`, which parses `tokens[2]` as the vrid, drops every group with that vrid on the port,
and never looks at `tokens[3]`:

```
(config-if)#vrrp 10 ip 10.0.0.1     -> VRRP group 10 on Gi0/0 owns 10.0.0.1
(config-if)#vrrp 10 priority 120    -> VRRP group 10 priority 120
(config-if)#no vrrp 10 priority     -> VRRP group 10 removed from Gi0/0
Router#show vrrp                    -> % VRRP is not configured
```

Two further facts make this worse than an awkward undo. `_vrrpIfaceCommand()`'s own `no` branch
(`engine/cli.js:3046-3049`) is unreachable - the only call site is 1688, which fires on `head === 'vrrp'` - so
`group.preempt = !(tokens[0] === 'no')` (3088) is dead and **`preempt: false` cannot be produced from the
console at all**. The printer writes for it anyway: `engine/cli.js:5916` emits `  no vrrp <vrid> preempt`
whenever `preempt === false`. Replaying that text, measured against `generic-router` with the group at
`priority 120`:

```
> vrrp 10 ip 10.0.0.1        :: VRRP group 10 on Gi0/0 owns 10.0.0.1
> vrrp 10 priority 120       :: VRRP group 10 priority 120
> no vrrp 10 preempt         :: VRRP group 10 removed from Gi0/0
groups after replay: []
```

`test/config-roundtrip.test.js:2` exists to hold exactly this - *"a config you can paste back"* - and passes,
because no fixture reaches `preempt: false` and the rule at :263 only says the field is *printed* when it is
not the default. The state is reachable through the API and a saved topology, which is where a paste-back
matters most.

**ACL entries.** `_accessList()` (`engine/cli.js:2950`) appends one entry. The removal at 1289-1300 deletes
`config.acls[n]`, its hit counters (`aclHits`) and every `aclBindings` in/out that names the list - three
objects for one entry - and answers `Access list 10 removed`. `no access-list 10 permit 10.0.0.0 0.0.0.255`
removes the whole list; there is no way to remove one entry.

**DNS records.** `dns add <name> <A|CNAME|MX|TXT> <value>` (2277) adds a record. The `no` chain has only
`no dns zone` (1357), which answers `DNS zone lab.example removed with 2 record(s)`. `no dns add www` is
`% Unrecognized config command`.

**BGP router-id and the subinterface tag.** `bgp router-id <ip>` (2220-2225) is a set form; the only removal is
`no router bgp <as>` (1404), which disables the protocol. `encapsulation dot1q <vlan>` (`_encap()`, 1975-1989)
has no removal at all: both `no encapsulation` and `no encapsulation dot1q` are `% Unrecognized interface
command`.

**The index that is not one.** `NO_FORMS` (555-589) holds 33 entries - 16 config, 9 interface, 8 pool - and is
read only by `_noHelpKeyRefusal()` (897), to word a refusal to a `?`. It does not dispatch; the 32
`head === 'no'` branches are the real surface, written by hand beside the set branches.
`docs/CLI.md:2870` says *"32 branches - 15 in config mode, 9 at an interface, 8 in a DHCP pool"*, one short in
the config column and one short in the total.

## What is missing, ranked

1. The round trip. A printed line destroys the object that printed it. Silent, and the property test that
   should catch it does not, because the state it needs is unreachable from the console.
2. `vrrp <vrid> priority` has no reset; the group must be deleted and re-created, which re-runs the election.
3. ACL entry removal is absent, and the closest spelling takes the counters and the bindings with it.
4. DNS record removal is absent; the zone is the only container.
5. `bgp router-id` and `encapsulation dot1q` cannot be removed at all.
6. Nothing enumerates which set forms have a removal, so the next attribute lands the same way.

## Ordered steps

1. **S** - `docs/CLI.md:2870`: 32/15/9/8 -> 33/16/9/8. No code, no behaviour.
2. **S** - **landed 2026-11-18.** `no vrrp <vrid> priority` resets the priority to 100 and keeps the group; `no vrrp <vrid> preempt`
   restores preempt; `no vrrp <vrid> advertise` likewise; bare `no vrrp <vrid>` still removes. Receipts in the
   OSPF words. Add a `config-roundtrip` fixture that carries `preempt: false, priority: 120` and asserts the
   group survives the paste - this is the PR that closes the defect found above.
3. **S** - `no dns add <name> [<type> [<value>]]` removes one record and says which; `no dns zone` unchanged.
4. **S** - `no access-list <n> permit|deny <entry>` removes that entry and leaves `aclHits` and `aclBindings`
   alone; bare `no access-list <n>` keeps today's removal of the list.
5. **S** - `no bgp router-id` clears `config.bgp.routerId` so the derived ID returns; `no encapsulation dot1q`
   clears the tag on a subinterface in words that say the subinterface still exists. One PR each.
6. **M** - `test/no-form-index.test.js`: for every `NO_FORMS` entry, the set form parses, the `no` form reaches
   a branch, the receipt names the object, and no field outside that object changes. Turns "33 entries, 32
   branches" from a sentence into a checked agreement.

## Risks, tests, sizes

- Every receipt in steps 2-5 is quoted in `docs/CLI.md` and asserted in `test/docs-cli-transcript.test.js`;
  the wording and its page must land together, or `scripts/check-doc-citations.js` fails.
- ACL entry identity: on duplicates, remove the first match and say `1 entry`; do not renumber the rest.
- VRRP: do not touch `engine/vrrp.js`. A reset must print no config line at the default 100 - the printer
  already omits defaults - or the round trip oscillates.
- `no encapsulation dot1q` is a choice with a verdict behind it: clearing the tag changes whether the
  subinterface carries traffic. It needs its own case in the encapsulation suite, not a shared one.
- Sizes: steps 1-5 are S (one branch, one receipt, one test); step 6 is M.

## Deliberately left out

- The convention at `docs/CLI.md:2841` - a `no` line reads the words that name the object and ignores the rest -
  is **not** changed here. The newest branch already refuses stray words (`no ip address 10.0.0.9 255.255.255.0
  secondary`: *"the word ... was not used, and nothing was removed"*), so the console now holds two conventions,
  and picking one is a decision rather than a repair: **needs Jay's approval**. Steps 2-5 hold under either.
- `startup-config` / `write memory`: the console has no persistence at all (no match for `startup-config` in
  `engine/`, `server/` or `docs/`). Adding one is new product surface: **needs Jay's approval**.
- The device requests in the queue, and the catalogue. Nothing here touches `devices/`.

## Issues this would close

None today. #130, #803, #807, #808, #810 are device requests; #1879 is catalogue labelling. The round-trip
defect is not in the tracker - step 2 is the PR that would close it if Jay files it, and this plan does not
invent an issue number for it.
