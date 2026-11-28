# `router bgp <other-as>` on a box already running BGP — "BGP is already running; AS is N"

**Question (one, narrow).** With a BGP process already configured, what does an IOS-like box do when
`router bgp <as>` is typed again with a **different** AS number — create a second process, renumber the
existing one, or refuse — and in what words?

**Verdict: refused, in one unprefixed line that names the AS already running, and nothing changes.** The
local AS stays where it was, the neighbours stay as they were, and no second process exists. Typing the
**same** AS again creates nothing either; a box says nothing at all there and simply re-enters its
`(config-router)#` sub-mode.

```
R4(config)#router bgp 65001
R4(config-router)#exit
R4(config)#router bgp 65002
BGP is already running; AS is 65001
R4(config)#
```

This console read every `router bgp <as>` as a (re)definition: the AS was overwritten in place and the
line answered `BGP enabled, local AS <new>`. A typo therefore renumbered a live process — the neighbours
kept their `remote-as`, `show ip bgp summary` began reporting a local AS the operator never meant, and
`show running-config` saved it, so the mistake survived a reload. Retyping the same AS answered
`BGP enabled` over a process that already existed: a creation receipt for a line that created nothing, the
same defect family as #1666 (`vlan 20`), #1675 (`channel-group`) and #1685 (`no vrrp`).

## The evidence

| Typed (running AS -> typed AS) | Printed | Source |
|---|---|---|
| 34 -> 35, from inside `(config-router)#` | `BGP is already running; AS is 34` | https://www.networkengineerpro.com/tutorials/cisco/ccnp-enarsi-300-410/bgp/ibgp-and-ebgp-peerings/ |
| 200 -> 201 | `BGP is already running; AS is 200` | http://ithitman.blogspot.com/2012/06/configuring-bgp-local-as-one-router.html |
| 64512 -> 65001 (6500-class router) | `BGP is already running; AS is 64512` | https://community.cisco.com/t5/routing/how-do-i-find-out-the-as-number-my-ebgp-neighbour-is-using-to/td-p/1078712 |
| 8234 -> 5000 | `BGP is already running; AS is 8234` | https://community.cisco.com/t5/routing/two-bgp/td-p/1046091 |
| 64050 -> 60021 (ASR-1001-X, under a VRF definition) | `BGP is already running; AS is 64050` | https://community.cisco.com/t5/routing/multiple-bgp-instance-in-one-router/m-p/4189864 |
| 203735 -> 203725 (IOS XE 3) | `BGP is already running; AS is 203735` | https://networkengineering.stackexchange.com/questions/50672/edit-bgp-on-ios-xe3 |

Six independent captures across classic IOS, IOS XE and an ASR, and they agree on all four details that
matter:

1. **The sentence names the AS that is running, not the one typed.** The operator's typo is answered with
   the truth about the box, which is what makes the line useful.
2. **There is no leading `%`.** Not one of the six pastes shows one — and these are raw session pastes, two
   of them with the prompt and `(config-router)#` echo intact either side of it. This console's refusals are
   `%`-prefixed by house style; this line is printed the way the box prints it, because the whole point of
   the sentence is that an operator recognises it. (Compare `static-route-own-next-hop.md`, where the pastes
   decided the spacing after the `%` the same way.)
3. **No trailing full stop**, and the `;` is ASCII.
4. **The prompt returns to `(config)#`** and the box is unchanged: the `two-bgp` transcript prints
   `show ip protocols` after the attempt and still lists `bgp 8234`, the same process name as before.

A seventh, adjacent capture shows the same fact in a different place: `no router bgp <old-as>` followed by
`router bgp <new-as>` is the documented way to move a router to another AS (a workshop lab instructs exactly
that sequence: https://nsrc.org/activities/agendas/en/riso-5-days/networking/routing-security/en/labs/rov.html),
i.e. the process must be removed first because the second line alone will not do it.

## What is inferred rather than witnessed

* **The same-AS retype is silent.** All six captures are of a *different* AS. A box given its own AS again
  goes to `(config-router)#` with no output; that is the behaviour every IOS session relies on when it
  re-enters the section to add a neighbour, and it is why a lab's command list says `router bgp <as>` before
  every neighbour line. This console has no router sub-mode (docs/BGP-POLICY.md section 9.2), so it cannot be
  silent without looking like a dropped keystroke: it prints its own receipt - `BGP is already running as
  65001, so there was nothing to enable` - the shape `vlan 20` uses on an existing VLAN. The words are the
  console's; the fact is the box's.
* **The refusal does not depend on neighbours existing.** Two of the six boxes had peers configured, one is a
  VRF-scoped attempt; the sentence is the same. The rule is read as "one BGP process per box", not "one per
  neighbour set".
* **The AS is compared numerically.** `65001` and `065001` are the same AS; no capture shows a leading-zero
  form, and the console parses with `parseInt`, so both reach the same process.
* **Four-byte ASNs behave the same way.** The captures are all two-byte ASNs; the console's range check is
  already 1-4294967295 and the refusal sentence prints whatever number is stored, so a 4-byte AS renumbers
  nothing either. Not witnessed.

## What remains unresolved

* **`no router bgp <wrong-as>`.** Whether a box refuses the deletion when the AS does not match the running
  one, or ignores the argument and removes the process. This console ignores the argument (`no router bgp`
  with any number disables BGP) and no capture in hand tests it. **What would settle it:** one paste of
  `no router bgp <other>` on a box running BGP, followed by `show ip protocols`.
* **NX-OS, IOS XR and Arista.** NX-OS is widely reported to print the same sentence; IOS XR's XML API returns
  its own error text (`AS number is wrong - BGP is already running with AS number 3`) for the same condition,
  which shows the family is not uniform. This console speaks for IOS, and only IOS pastes are used above.
* **A VRF-scoped attempt.** The ASR paste above suggests the same sentence is used from inside a VRF context,
  but this console models no VRFs, so nothing is claimed about one.

## What the model does now

The `as` branch of `_bgp()` in `engine/cli.js` reads the running AS before writing anything:

* different AS -> `BGP is already running; AS is <running>` (no `%`, no full stop), and `config.bgp.as` is
  untouched, so `show ip bgp summary`, `show running-config` and a saved lab all keep the original process;
* same AS -> `BGP is already running as <as>, so there was nothing to enable`, again with nothing written;
* no process yet -> `BGP enabled, local AS <as>`, unchanged;
* `% Invalid AS number "<x>"` still fires first, so an out-of-range AS is still refused by value.

`test/bgp-second-router-as.test.js` (20 checks): the creation receipt and stored AS on a fresh box; the
same-AS receipt; the exact vendor sentence for a different AS with no `%` and no full stop; three retries in
a row all naming the original AS with the neighbour and its `remote-as` intact; `show ip bgp summary`
reporting the original local AS; `show running-config` printing `router bgp 65001` and never the refused
number; `no router bgp` freeing the AS for a new process; and the out-of-range refusal still first.
