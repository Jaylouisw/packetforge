# A two-id run in `switchport trunk allowed vlan`: `157,158` or `157-158`?

**Question (one, narrow).** A trunk's allowed list is printed folded into ranges (`1-4,7,11,13-4094`). When
two consecutive ids meet - `157` and `158` - does the box write `157-158`, or does it write them out as two
ids? The same question decides every pair this console's printer emits, in `show running-config`, in the
console's receipt for the command, and in the `switchport:` sentence of `show interfaces`.

**Verdict: a pair is printed as two ids, and only a run of three or more folds.** Three real
`show running-config` captures spell pairs out, and none folds one; the same captures fold a run of four. The
rule the samples fit is arithmetic, not tribal: a range is written only where it is **shorter** than the list
it replaces, and `81-82` is exactly as long as `81,82`. PacketForge folded every run, so a backup of a trunk
carrying 157 and 158 read `157-158` where the box that was configured the same way reads `157,158` - a
difference a diff against a real device shows, in the one line an operator is most likely to retype.

## Evidence (observed output, not command reference text)

| Source | Shows |
| --- | --- |
| [Cisco support doc 68100, *Configure VLANs on Wireless LAN Controllers*, Catalyst verification](https://www.cisco.com/c/en/us/support/docs/wireless-mobility/wireless-vlan/68100-wlan-controllers-vlans.html) | `w-backbone-6k#show running-config interface gigabitethernet 2/1`: `switchport trunk native vlan 999` / **`switchport trunk allowed vlan 1,81,82,171,999`** / `switchport mode trunk`. A pair (`81,82`) is two ids. |
| [Configuración de Puertos Trunk y Acceso (captured session, uploaded by Ricardo Romero)](https://www.scribd.com/document/102521078/Configuracion-de-Puerto-en-Modo-Trunk) | `MEXSWP04-NAP#sh run int fa2/0/39` on a Catalyst 3750 stack (the same page's `sh cdp nei` names the peer `WS-C3750V`): `switchport access vlan 160` / `switchport trunk encapsulation dot1q` / `switchport trunk native vlan 160` / **`switchport trunk allowed vlan 59,157,158,160`** / `switchport mode trunk` / `switchport voice vlan 155`. A pair (`157,158`) is two ids, on a port where four lines of the block are visible together. |
| Same document, second box | `MEXSW09-NAP#sh run int gi1/0/3`: `switchport trunk allowed vlan` **`55,56,59,155,157,158,160,200`** - two pairs (`55,56` and `157,158`), both spelled out, in one line. |
| [Cisco TAC KB, *How to define the VLANs allowed on a trunk link*](https://community.cisco.com/t5/networking-knowledge-base/how-to-define-the-vlans-allowed-on-a-trunk-link/tac-p/4947136) | `c3550(config-if)#switchport trunk allowed vlan remove 5-10,12` then `add 7`, then `show interfaces fastEthernet 0/2 trunk` prints `Fa0/2 1-4,7,11,13-4094`. A run of **four** folds (`1-4`), and the 4,082-long tail folds. This is device-computed output - nobody typed `1-4` in that session. |
| [Catalyst 3650 thread, `show running-config interface` paste](https://community.cisco.com/t5/network-management/vmware-hosts-not-responding-on-catalyst-3650-switch/td-p/4389451) | A backup line in the same shape: `switchport trunk allowed vlan 1-3,100` - a run of three folded. Weaker than the c3550 (the engineer may have typed the range), so it corroborates rather than settles the threshold. |

## What is known

1. **A pair is two ids.** Three independent `show running-config` captures - two of them full interface blocks
   from production switches, one a support-document verification - print `81,82`, `157,158` and `55,56`
   without folding. No capture in hand folds a pair.
2. **A run of four folds.** `1-4` in the c3550's trunk view, produced by the device from a `remove 5-10,12`
   plus `add 7`, so the fold is the box's own.
3. **The threshold is three.** `3-5` is two characters shorter than `3,4,5`; `81-82` is the same length as
   `81,82`. A printer that emits a range only when it saves characters therefore folds from three up, which is
   exactly the boundary the captures show (`1-4`, `1-3` fold; all three pairs do not).
4. **The line is stable across the IOS family**: the captures are IOS 12.2-era 3750s and a 6500-class
   `w-backbone-6k`, and the c3550 is older still - so this is not one release's formatting.

## What is inferred

* That the threshold is an implementation of "write the shorter form", not a special case for two. The
  arithmetic fits all five samples and predicts the untested middle (a run of three folds), which the 3650
  paste agrees with. A capture of a *device-computed* run of exactly three would make that prediction an
  observation; the ones in hand are typed ranges.
* That the same fold is used wherever the set is printed: `show running-config`, the console's receipt, and
  the `switchport:` sentence in `show interfaces` all read the same list in every capture where two of them
  appear together. This console prints all three from `engine/vlan.js formatVlanList()`, so they cannot drift.

## What is unresolved

* **A device-computed run of exactly three.** `1-3,100` in the 3650 paste may have been typed as a range. What
  would settle it: a `show running-config` after `switchport trunk allowed vlan remove <list>` on a default
  trunk that leaves three consecutive ids, e.g. `remove 1-9,13-4094` leaving `10-12` (this console prints
  `10-12`).
* **The order the ids were typed in.** IOS stores the list as a set (the c3550's `add 7` lands in the middle
  of the printed list), so this model sorts. A capture where an operator typed `30,10,20` and the box printed
  `10,20,30` would confirm it; none was sought for this note.

## What changed in PacketForge

* `engine/vlan.js` - `formatVlanList()` now emits a range only for three or more consecutive ids; a pair is
  written `a,b`. The comment above it carries the captures and the arithmetic.
* `web/app.js` - the panel's mirror `vlanListText()` follows the same rule, because the panel and the console
  sentence are compared over a matrix of port states (`test/switchport-agreement.test.js`).
* `test/running-config-allowed-vlan-two-id-run.test.js` - 12 checks: the three captured pairs character for
  character, a run of three and a run of four folding, the whole five-line `fa2/0/39` block, the long
  `gi1/0/3` list, the receipt and the `switchport:` sentence agreeing with the config line, and the printed
  list re-typing to itself.
* `test/trunk-allowed-remove-from-all.test.js` - the assertion that pinned the old guess ("a pair folds too,
  as the box prints it") now pins the capture, and two more assert the captured pairs.
* `test/switchport-agreement.test.js` - the matrix gained pair-bearing lists (`[157,158]`,
  `[59,157,158,160]`) and a run of three, and its sentence reader now expands a range before comparing it
  with the data plane.
