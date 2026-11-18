# What a box prints above `show ip dhcp binding`'s columns

**Question (one, narrow).** On an IOS-like DHCP server, what is the line above the `show ip dhcp binding`
column headings — its exact wording, whether it is printed when no row follows it, and whether it changes
with the criterion — and what part of that does PacketForge owe the reader?

**Verdict: known, and the title is adopted; the columns are not.** Every IOS capture of this view opens with
`Bindings from all pools not associated with VRF:`. PacketForge started the table at its column headings, so
the view had rows and no answer to "which pools are these rows from" — the same missing-furniture defect the
MAC address table and the EtherChannel summary each carried before their own audits
(`research/mac-table-surround.md`, `research/etherchannel-summary-layout.md`).

Adopted: the title line, printed above the header whether or not a row follows it, once per table, verbatim.
Not adopted: the box's four columns and their three-deep header. This console prints
`Client identifier / MAC`, `Pool` and `Expires in` where a box prints `Client-ID/ Hardware address/ User name`,
an absolute `Lease expiration` (`Mar 29 2009 04:36 AM`, or `Infinite`) and a `Type` (`Automatic`, `Manual`,
`Static`, `On-demand`, `Relay`). Replacing those would delete the pool attribution and the countdown that the
lease tests assert on purpose (#1373), so the columns stay this model's own and only the title is the device's.
`test/dhcp-binding-title.test.js` pins the title, where it sits, and the two cases where no table is printed
at all.

## What the device prints

Cisco, *Configuring the DHCP Server On-Demand Address Pool Manager* (IOS XE 17.x). The transcript shows the
title, the three-line header, and — in the prose — the empty case:

> There are no bindings shown under the Bindings from all pools not associated with VRF field because the
> Global pool has not allocated any addresses.

```
Router# show ip dhcp binding
Bindings from all pools not associated with VRF:
IP address
Client-ID/
Lease expiration
Type
Hardware address/
User name
10.0.0.0/26   0063.6973.636f.2d64.   Mar 29 2009 04:36 AM   Automatic
              656d.6574.6572.2d47.
              4c4f.4241.4c
```

<http://cisco.com/c/en/us/td/docs/routers/ios/config/17-x/ip-addressing/b-ip-addressing/m_config-dhcp-addr-pm-xe.pdf>

Cisco, *Operate a Robust IOS XE DHCP Server* (doc 226237, IOS XE 16/17/26) — the title, the same header, and
the proof that the title follows the criterion: the `remembered` form renames it.

```
router#show ip dhcp binding remembered
Remembered bindings from all pools not associated with VRF:
IP address      Client-ID/              Lease expiration        Type       State      Interface
Hardware address/
User name
10.10.10.123    0146.81df.f153.fe       Jun 27 2026 01:47 PM    Remembered Terminated Vlan102
```

<https://www.cisco.com/c/en/us/support/docs/ip/dynamic-address-allocation-resolution/226237-operate-a-robust-ios-xe-dhcp-server.html>

A second, independent capture of the same three-line header and the same title on an ISR 4331 running IOS XE
Everest — the platform family the regression test builds its fixture from:

```
#Show ip dhcp binding
Bindings from all pools not associated with VRF:
IP address Client-ID/ Lease expiration Type State Interface
Hardware address/
User name
192.168.20.111 0118.31bf.d040.62 Infinite Automatic Active GigabitEthernet0/0/1.200
```

<https://networkengineering.stackexchange.com/questions/71484/cisco-ios-software-everest-isr-4331-vlanvrfdhcp>

and a community walkthrough that reproduces it on a lab router:

```
DHCP#show ip dhcp binding
Bindings from all pools not associated with VRF:
IP address Client-ID/ Lease expiration Type
Hardware address/
User name
192.168.12.2 0063.6973.636f.2d63. Mar 02 2002 12:24 AM Automatic
```

<https://networklessons.com/network-fundamentals/how-to-configure-dhcp-server-on-cisco-ios>

## Two release-dependent shapes, and one family that has neither

* **Old 12.x** prints the header on **one** line: `IP address Client-ID/Hardware address Lease expiration
  Type` (Cisco, *Dynamically Configuring DHCP Server Options*, doc 22920:
  <https://www.cisco.com/c/en/us/support/docs/ip/dynamic-address-allocation-resolution/22920-dhcp-ser.html>).
  The title is not visible in the extractable part of that page, so whether 12.x prints it is **inferred**, not
  read.
* **15.x/16/17/26** print the header **three deep** and add `State` and `Interface` columns (Catalyst 9800
  configuration guide, "Client binding verification":
  <https://www.cisco.com/c/en/us/td/docs/wireless/controller/9800/config-guide/newconfigmodel/b_catalyst-9800-configuration-model/m_configuring-policy-profile-features.pdf>;
  and the 226237 capture above).
* **Small-business switches are a different view entirely.** The Catalyst 1200/1300 and CBS 250/350 CLI guides
  print `IP address Hardware address Lease expiration Type` with **no title**, preceded instead by counts
  (`The number of used (all types) entries is 6`, `The number of automatic entries is 1`):
  <https://www.cisco.com/c/en/us/td/docs/switches/lan/csbms/CBS_250_350/CLI/cbs-350-cli-/dhcp-server-commands.html>.
  PacketForge's DHCP server is modelled on IOS, so IOS's title is the one it prints.

## What is still unresolved

* **The title on a box with DHCP unconfigured.** PacketForge refuses in its own words (`% This device is not a
  DHCP server (no "ip dhcp pool" configured)`), and no capture found shows what a real box prints there —
  plausibly the title and the header with nothing under them, plausibly a refusal. No engine change was made
  for that case: the refusal is deliberate and tested, and guessing at a title for it would invent a table.
* **Spacing between the columns.** Every capture above lost its padding to HTML/PDF extraction, so the widths
  the box uses for `IP address` (11), `Client-ID/` (24) and `Lease expiration` (24) are known only from
  transcripts that survived as preformatted text. Nothing here depends on them.
* **`Total number of bindings` / count lines.** The small-business family prints them; IOS does not. Whether
  any IOS release grew one is not known, and none of the four IOS captures has it.
* **What would settle the first gap:** a capture of `show ip dhcp binding` on an IOS/IOS XE box with no
  `ip dhcp pool` configured, ideally with `service dhcp` present and absent.
