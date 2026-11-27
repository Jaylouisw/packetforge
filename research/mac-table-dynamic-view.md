# `show mac address-table dynamic`: what the filter leaves out, and what the total counts

**Question (one, narrow).** `show mac address-table` on a Catalyst prints twenty `All … STATIC … CPU` rows
before anything has been learned. When the operator narrows the same table with `dynamic`, does the box keep
those rows — and what number closes the table?

**Verdict: the CPU block is gone, and the total is the learned rows the filter printed.** Every capture of the
`dynamic` form holds `DYNAMIC` rows only, under the same title, rule, headings and closing sentence as the
unfiltered view. The criterion is the type, and the twenty CPU rows are `STATIC`, so they fail it — the same
reason `interface <port>` prints none of them (`research/mac-table-reserved-rows.md`).

This console refused the word outright until this run:

```
SW1#show mac address-table dynamic
% show mac address-table does not take "dynamic": use `show mac address-table interface <port>` for one port
```

That is a documented form of a view the console already has, and the refusal named a different form as though it
were the only one. `docs/CLI.md` and `research/mac-table-reserved-rows.md` both already listed `dynamic` among
the forms "still refused or unbuilt".

## The captures

### The vendor's own sample, three releases running

Catalyst 2960-X, IOS 15.2(7)E, *System Management Commands*, `show mac address-table dynamic`
(<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_7_e/command_reference/b_1527_2960x_cr/system_management_commands.html>),
the same page in the 15.2(4)E consolidated guide
(<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_4_e/command_reference/b_1524e_consolidated_2960x_cr/b_1524e_consolidated_2960x_cr_chapter_01011.html>),
and the 2960 15.0(2)SE command reference
(<https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/15-0_2_se/command/reference/cr2960.pdf>):

```
Switch# show mac address-table dynamic
Mac Address Table
------------------------------------------
Vlan    Mac Address       Type        Ports
----    -----------       ----        -----
   1    0030.b635.7862    DYNAMIC     Gi0/2
   1    00b0.6496.2741    DYNAMIC     Gi0/2
Total Mac Addresses for this criterion: 2
```

The unfiltered sample on the same page prints `All 0180.c200.0010 STATIC CPU` rows and closes at 12; the
`dynamic` sample closes at 2 with no `All` row anywhere. The syntax line is
`show mac address-table dynamic [address mac-address] [interface interface-id] [vlan vlan-id]`, so the word is
a filter that takes the same three narrowings as the parent command, not a synonym for it.

### A live switch, with the filter and the narrower forms side by side

Rowell Dionicio's CCNP ENCOR lab pastes `show mac address-table dynamic` from `sw1`, a switch carrying VLANs 1,
3, 103, 120, 129 and 140
(<https://rowelldionicio.com/mac-address-table-cisco-switches-ccnp-encor/>):

```
sw1#show mac address-table dynamic
Mac Address Table
-------------------------------------------
Vlan    Mac Address       Type        Ports
----    -----------       --------    -----
 129    0017.88a9.b5dc    DYNAMIC     Gi1/0/1
 129    7483.c279.3a4c    DYNAMIC     Gi1/0/14
 ...
   3    7483.c279.3a4c    DYNAMIC     Gi1/0/14
Total Mac Addresses for this criterion: 22
```

Twenty-two rows, all `DYNAMIC`, no `All` row — and the same page's `show mac address-table dynamic vlan 103`
closes at 9 for that VLAN. A Catalyst 9400 support document prints the same shape for
`show mac address-table dynamic vlan 100`
(<http://cisco.com/c/en/us/support/docs/ip/layer-two-tunnel-protocol-l2tp/217923-validate-layer-2-hardware-on-catalyst-94.html>).

### What the block is, again

The twenty rows are the box forwarding CDP's two group addresses, the `0180.c200.0000`–`0010` run and the
all-nodes broadcast to its own CPU. Nothing learned them, nothing ages them, and they belong to no VLAN — which
is why the Vlan cell reads `All` and the Type cell reads `STATIC`. A type filter that says "show me what was
learned" cannot match one.

## What PacketForge prints now

```
sw1#show mac address-table dynamic

          Mac Address Table
-------------------------------------------

Vlan    Mac Address         Type        Age     Ports
----    -----------         --------    ---     -----
   1    0200.0000.0100      DYNAMIC     0s      Fa0/1
   1    0200.0000.0200      DYNAMIC     -       Fa0/2
Total Mac Addresses for this criterion: 2
```

and on a switch nobody has touched, where the unfiltered view still reads 20:

```
sw1#show mac address-table dynamic

          Mac Address Table
-------------------------------------------

Vlan    Mac Address         Type        Age     Ports
----    -----------         --------    ---     -----
Total Mac Addresses for this criterion: 0
```

`dyn` prints the same table: a box matches a keyword by an unambiguous prefix, and `d` names only `dynamic`
among this command's words (`address`, `aging-time`, `count`, `dynamic`, `interface`, `multicast`,
`notification`, `static`, `vlan`). `dynamic interface <port>` narrows further and keeps the total to that port,
the rule `interface <port>` already followed.

## What is inferred, and what remains

* **The empty filtered table is inferred.** No Cisco page prints `dynamic` on a box that has learned nothing.
  The console prints the title, rule, headings and `Total …: 0`, because that is what it prints for an empty
  `interface <port>` view and the sentence is a count of a criterion. No `(no entry learned …)` line is added
  here: that line names a port, and this filter names none.
* **`dynamic address <mac>`, `dynamic vlan <id>`, `static`, `vlan <id>`, `count` and `aging-time` are still
  unbuilt**, and are each their own question. `vlan <id>` is the most valuable next one: the 2960-X page has a
  sample, the filter is a column this table already prints, and the CPU block's `All` cell is precisely what a
  VLAN filter has to decide about — the vendor's `show mac address-table vlan` sample is the evidence that would
  settle it.
* **The options are matched in one order only.** `dynamic interface <port>` works; a box also takes
  `interface <port> vlan <id>` and the words in any order, and this parser still reads everything after
  `interface` as the port name, so `interface Fa0/1 dynamic` is answered `% No interface Fa0/1 dynamic`. The
  vendor's syntax line has all three options optional and unordered; making the tail a small keyword parser is
  the increment that fixes it, and it is not this one.
* **The `Age` column is this model's**, not the device's, so the filtered view's columns still differ from the
  capture above by that one field (`research/mac-table-surround.md`).
* **The XE-only `0180.c200.0021` row** is still not printed for any model, and the `dynamic` view is unaffected
  by it — the row is `STATIC` and the filter excludes it either way.
