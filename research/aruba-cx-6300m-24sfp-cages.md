# The Aruba CX 6300M 24SFP+ 4SFP56: which of its 28 ports are copper?

**Question (one, narrow).** The catalogue's `aruba/CX 6300M 24SFP+ 4SFP56` (JL658A) declared its 24
access ports as `type: ethernet, speed: 10G` with no connector, so `derivePortHardware()` resolved them to
RJ45 copper sockets carrying 10GBASE-T - on the one row in the 6300M family whose whole purpose is fibre
access. Does HPE's own documentation say those 24 ports are module slots, at which rates, and does anything
on the box carry a copper socket?

**Verdict: settled - 24 SFP+ cages at 1G/10G, four SFP56 uplinks, no copper port anywhere.** The
portTemplate now carries `"connector": "sfp+"` and `"speedCaps": [1000, 10000]`, so all 24 access ports
report an SFP+ cage, offer the 10G and 1G optics, train at 1G or 10G, and refuse an RJ45 patch lead.
`test/aruba-cx-6300m-24sfp-cages.test.js` pins it (19 assertions), and
`scripts/audit-port-types.js` no longer lists the row under "Template ports at 10G+ presented as RJ45
copper on a box that describes itself as SFP".

## Evidence

| Source | Says |
| --- | --- |
| [HPE Aruba Networking CX 6300 Switch Series QuickSpecs, a00073540enw](https://www.hpe.com/psnow/downloadDoc/HPE%20Aruba%20Networking%20CX%206300%20Switch%20Series%20QuickSpecs-a00073540enw.pdf?id=a00073540enw.pdf) (Configuration Information, BTO models) | Model row: "Aruba 6300M 24-port SFP+ and 4-port SFP56 Switch  JL658A", then the ordering rules "**Min=0 \ Max= 24 SFP/SFP+ 100M/1/10G Transceivers**" and "**Min=0 \ Max = 4 SFP/SFP+/SFP28/SFP56 1/10/25/50G Transceiver**", plus "Must Select PSU Min1 / Max2". |
| [Aruba CX 6300 Switch Series Data Sheet, DS_6300Series.pdf](https://www.dickerdata.com.au/hubfs/HSM-ARU/Library/Datasheets/DS_6300Series.pdf) (JL658A column, "Description") | "24x 1G/10G SFP+ ports / 4x 1/10/25/50G SFP ports / 1x USB-C Console Port / 1x OOBM port / 1x USB Type A Host port". The same column repeats "24x 1G/10G SFP+ ports" in the port table; no RJ-45 data port is listed. |
| [HPE product page datasheet, PSN1012183959WWEN](https://www.scribd.com/document/743880675/HPE-Aruba-Networking-CX-6300M-24-port-SFP-and-4-port-SFP56-Switch-PSN1012183959HREN) (JL658A tech specs) | "Ports: 24 1G/10G SFP+ ports, (4) 1/10/25/50G SFP ports"; the transceiver counts are again "Max= 24 SFP/SFP+ 100M/1/10G" and "Max = 4 SFP/SFP+/SFP28/SFP56 1/10/25/50G". It also says the four uplinks do "1/10/25/50GbE (50GbE for DAC connectivity only)". |
| Same QuickSpecs, sibling SKUs (JL661A, JL663A, JL664A, JL659A, JL660A) | Every other 6300M row in the ordering table names 1GbE or Smart Rate **RJ-45** access ports and the same four SFP56 uplinks. The copper box is a different SKU, which is what rules out reading JL658A's access group as copper. |

## What is known

1. JL658A's 24 access ports are SFP/SFP+ **cages** taking "100M/1/10G" transceivers - they are not
   10GBASE-T RJ45 sockets. HPE counts them in transceivers ("Max= 24 ... Transceivers"), which nobody does
   with an RJ45 socket.
2. The 24 cages train at 1G and 10G, which is exactly the ladder `CAGE_MEDIA['sfp+']` offers.
3. The four uplinks are SFP56 cages taking SFP, SFP+, SFP28 and SFP56 modules at 1/10/25/50G.
4. Nothing on the box is copper **except** the OOBM port and the USB-C console - neither of which this
   catalogue models as a data port, and neither of which the engine's port model needs (a console is a
   line, `research/console-is-a-line-not-an-interface.md`).

## What was changed

* `devices/aruba/cx-6300m-24sfp-4sfp56.json`: the portTemplate gains `"connector": "sfp+"` and
  `"speedCaps": [1000, 10000]`. Nothing else moved - the same 24 names `1/1/1`-`1/1/24`, the same `10G`
  label, the same four uplinks `1/1/25`-`1/1/28`. The description now names the SKU and says which rates
  are modelled and which are not.
* `test/aruba-cx-6300m-24sfp-cages.test.js`: all 24 ports are SFP+ cages offering 10GBASE-SR and
  1000BASE-SX, training at 1G/10G, holding a `1000base-t-sfp` module; no port on the box reports a copper
  cage; a 10GBASE-T RJ45 host (an ASUS RT-AX89X's 10G port) is refused by an empty cage; two downlinks
  meet over 10GBASE-SR at 10G and over a 10G DAC; the four uplinks stay optical and still hold a 10G SFP+
  optic as well as a 25G one.

## What is inferred

* That the 24 cages are one family (SFP+) rather than a mix, and that all 24 run at both 1G and 10G: every
  document in hand states the group as one row ("24x 1G/10G SFP+") and the ordering rule as one ceiling
  ("Max= 24").
* That the uplinks' 50G rate being "for DAC connectivity only" is a cabling limit, not a port limit - the
  port is an SFP56 cage either way. This does not affect the model today, which stops at 25G on those
  ports (see below).

## What is unresolved

* **The 100M optic.** The QuickSpecs' access-group rule reads "100M/1/10G Transceivers", and HPE sells a
  "100M SFP LC FX 2km MMF Transceiver J9054D". The engine's `sfp+` cage has a fixed ladder of
  `[1000, 10000]`, so a 100BASE-FX module cannot be offered on these ports. Declaring `100` in
  `speedCaps` would keep the number in `port.hardware.speedCaps` while the cage still carried no
  100M medium - a cap the port could not reach - so it is left out. Adding `100base-fx` to
  `engine/media.js` and to `CAGE_MEDIA['sfp+']` is a medium-catalogue change, not a spec fix.
* **The uplinks' 50G.** The hardware runs 50G on `1/1/25`-`1/1/28`; the catalogue models them at 25G
  (`sfp28` by inference), because the engine's `sfp56` cage carries only 25G/50G media and **no 1G or 10G
  optics** (`CAGE_MEDIA.sfp56` = `50gbase-sr`, `50gbase-lr`, `25gbase-sr`, `25gbase-lr`, `dac-25g`;
  `CAGE_SPEEDS.sfp56` = `[25000, 50000]`). Moving the ports to `sfp56` today would therefore *refuse* the
  10G SFP+ module the data sheet says fits - a regression in the common case to gain the rarer one. The
  fix is to add the SFP/SFP+ optics and `dac-10g`/`dac-1g` to `CAGE_MEDIA['sfp56']` (an SFP56 cage is
  backward compatible with SFP+ modules), and then declare these four ports `sfp56` at 50G.
* **The 1G optic's link rate.** Found while writing this test, and deliberately not asserted: a
  1000BASE-SX run between two 10G cages reports `speedMbps: 10000`, because `negotiateSpeed()` returns the
  highest *shared port rate* and never looks at the medium named on the cable. Whether a box reports a 1G
  link there is a separate question (a 1G optic cannot run at 10G), and it is a negotiation question, not
  a cage one.
* **The 6300M siblings.** `CX 6300M 48G 4SFP56` (JL663A), `CX 6300M 48G CL4 PoE 4SFP56` (JL661A) and
  `CX 6405` describe their four uplinks as "1/10/25G SFP56", the same 25G understatement; none of them is
  a cage error (their access ports really are RJ45), so they are left alone here.
* **The rest of the audit class.** `scripts/audit-port-types.js` still lists two 10G+ fibre boxes under the
  same heading - `extreme/VSP 7254XSQ` (48x 10G SFP+) and `extreme/X690-48x-2q-4c` (48x 10G SFP+). Same
  defect, different vendor, not touched this run.

## What would settle the rest

An HPE transceiver guide page (or a `show interface transceiver` capture) listing J9054D as supported on
JL658A's access ports, which would justify adding `100base-fx` to the medium catalogue; and one capture of
`show interface 1/1/25` (or `show interface 1/1/25 transceiver`) showing a 10G SFP+ module linked at 10G in
an SFP56 port, which is the evidence that would let those four ports be declared `sfp56` without losing
the 1G/10G case.
