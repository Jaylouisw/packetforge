# `clock rate` on a serial port: which numbers does the parser take?

**Question (one, narrow).** On a Cisco serial interface, is the set of rates `clock rate`
accepts the set of rates the *line* can run at — so a port declared at 1.544 Mbps refuses
`clock rate 9600` — or is it the parser's own menu, which every serial port prints above the
line `<300-4000000> Choose clockrate from list above`? And what does the box saying "rounded"
actually print?

**Verdict: the parser's menu, and any integer in its range.** A serial port's `clock rate ?`
lists the standard rates (1200 … 4000000) and, under them, `<300-4000000> Choose clockrate
from list above`; a value that is not one of the standard rates is accepted, rounded to the
nearest rate the hardware supports, and the console says so in the command reference's own
words: `%Clockrate rounded to nearest value that your hardware can support.` The rounded
rate — not the typed one — is what lands in `show running-config`. PacketForge checked the
typed number against the port's link-speed ladder (a 2811 offered only 64000, 128000, 256000,
512000, 1024000, 1544000) and refused 9600, 19200, 38400, 72000, 125000, 128000, 148000,
250000, 500000, 800000 and 1000000 — every one of them a rate the box's own menu prints.

## The evidence

| Source | Says |
| --- | --- |
| [Cisco IOS Interface and Hardware Component Command Reference, `clock rate`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-cr-book/ir-c2.html) | `bps`: "Desired clock rate, in bits per second: **1200, 2400, 4800, 9600, 19200, 38400, 56000, 64000, 72000, 125000, 148000, 250000, 500000, 800000, 1000000, 1300000, 2000000, 4000000**, or 8000000". Then: "For the synchronous serial port adapters (PA-8T-V35, PA-8T-X21, PA-8T-232, and PA-4T+), a nonstandard clock rate can be used. **You can enter any value from 300 to 8000000 bps.**" And: "The clock rate you enter is rounded (adjusted), if necessary, to the nearest value that your hardware can support **except for the following standard rates: 1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 56000, 64000, 128000, or 2015232**." |
| Same page, *Examples* | `Router(config)# interface serial 5/0` / `Router(config-if)# clock rate 1234567` → `%Clockrate rounded to nearest value that your hardware can support.` Then `show running-config` prints `clockrate 1151526` — the rounded rate, with no trace of the typed one. |
| [Cisco Community, "Serial Cable Speed"](https://community.cisco.com/t5/switching/serial-cable-speed/m-p/536886) — a 2501's console | `GN-2500-YDE(config-if)#clock rate ?` → `Speed (bits per second)` / `1200` `2400` `4800` `9600` `19200` `38400` `56000` `64000` `72000` `125000` `148000` `250000` `500000` `800000` `1000000` `1300000` `2000000` `4000000` / `<300-4000000> Choose clockrate from list above`. The menu and the range, in one capture. |
| [Cisco, *Troubleshooting Serial Lines*](https://www.cisco.com/en/US/docs/internetworking/troubleshooting/guide/tr1915.html) | The same list as syntax: "**bps** — Desired clock rate in bits per second: 1200, 2400, 4800, 9600, 19200, 38400, 56000, 64000, 72000, 125000, 148000, 250000, 500000, 800000, 1000000, 1300000, 2000000, 4000000, or 8000000." |
| [Cisco, *Configuring the 4-Port Serial Interface SPA*](https://cisco.com/c/en/us/td/docs/interfaces_modules/shared_port_adapters/configuration/ASR1000/xe-16-9/asr1000-sip-spa-16-9-book/asr-spa-4port-serial-config.pdf) | "Set standard clock rate, in bits per second: 1200 … 8000000. **Any nonstandard clock rates that are entered are rounded off to the nearest hardware-supported clock rate. The actual clock rate is then displayed on the console.**" |

Two independent Cisco documents give the same list, one community capture shows the menu and
the `?` banner as printed, and the command reference gives both the rounding sentence and the
proof that the *rounded* rate is what the configuration holds. That is enough to enforce.

One further rate in the vendor's menu is `128000`: it is on the "not rounded" exception list
rather than the standard-value list, which is why it appears in some captures' menus and not
others (the 2501 capture above does not show it; the 2811-era lab capture does).

## What the engine did

* `engine/cli.js` `_clock()` built its set of acceptable rates from `iface.speedCaps` — the
  serial cage's *link* ladder (`engine/media.js` `CAGE_SPEEDS.serial`: 64k, 128k, 256k, 512k,
  1.024M, 1.544M, 2.048M, 4M, 8M, cut down to the port's declared maximum). On a 2811 that is
  six values. Anything else was refused with
  `% <n> bps is not a rate <port> can clock. Choose one of: 64000, 128000, …`.
* `test/serial-links.test.js` §5 pinned the defect: `ok(/% 9600 bps is not a rate/…)` — the
  suite that exists to lock `clock rate`'s refusals had been written from the same wrong rule,
  so it agreed with the console instead of finding it. That is the second time this repo has
  caught a test written from the bug it was meant to catch (`vrrp-priority-range.md`).

## What changed

* `engine/cli.js`: `SERIAL_CLOCK_RATES` (the vendor's menu, cited at the constant) is unioned
  with the rates the port itself declares, cut to the port's top rate. The check is now:
  * on the menu → stored as typed, `Clock rate set to <n> bps …`;
  * inside 300 … top but not on the menu → stored at the nearest menu rate, and the console
    prints the command reference's line, verbatim, and nothing else:
    `%Clockrate rounded to nearest value that your hardware can support.`;
  * below 300 or above the top → refused with the range quoted,
    `% <n> bps is outside the range <port> can clock (300-<top> bps)`.
* `test/serial-clock-menu.test.js` (new, 77 checks): all seventeen standard rates at or below
  the port's top are stored verbatim and not reported as rounded; the declared T1 rate still
  is; 2000000 and 4000000 are refused with the range quoted; 299 refused, 300 accepted, the
  top accepted, top+1 refused; 1234567 rounds to 1300000 with the exact vendor sentence and
  `show running-config`/`show interfaces` print the rounded number only; 999→1200, 2000→2400,
  100000→125000, 1400000→1300000; a refused rate leaves the clock alone; `no clock rate`
  clears it; and a link clocked at 9600 bps validates at 0.0096 Mbps and carries a ping.
* `test/serial-links.test.js` §5 now asserts the opposite of what it asserted: 9600 is
  accepted, and 5000000 is refused with the range quoted.
* `docs/CLI.md` (`clock rate` row) and `docs/PHYSICAL_LAYER.md` §2.1 state the rule and cite
  this note.

## What is inferred, not published

* **The rounding target.** The box rounds to "the nearest value that your hardware can
  support", on a granularity only the card knows: the reference example rounds 1,234,567 down
  to 1,151,526 on a PA-8T, which is not a multiple of any rate in the menu. This model has no
  card-level granularity, so it rounds to the nearest rate *the port lists* — coarser than the
  hardware, and the console's sentence is the vendor's, not a claim to have matched the card.
* **The success path.** A real box prints nothing at all when it takes a rate that needs no
  rounding. This console says `Clock rate set to <n> bps on <port> (this end is DCE)`, which is
  its own voice for every accepted configuration line and was left alone: it is not a denial of
  anything the box prints, and the rounded path does print the box's sentence instead.

## What remains unresolved

* **The top of the range on a 2811.** The model declares `Se0/0/0`, `Se0/0/1` at `speed:
  "1.544M"` — a T1 line rate — so the menu here stops below 2000000. The card is another
  number: Cisco's [serial interface card guide](https://www.cisco.com/c/en/us/td/docs/routers/access/interfaces/ic/hardware/installation/guide/ser_hwic.html)
  gives the WIC-2T a synchronous maximum of **2.048 Mbps per port** (8 Mbps only in the chassis
  it lists), and the [HWIC-2T datasheet](https://www.cisco.com/c/en/us/products/collateral/interfaces-modules/high-speed-wan-interface-cards/datasheet_c78-491363.html)
  gives the HWIC-2T **8 Mbps per port**, four ports in a 2811. If the model's serial ports
  declared the card's maximum instead of a line rate, the accepted range would run to 2048000
  (WIC-2T) or 8000000 (HWIC-2T) and 2000000/4000000 would come back. Which card the 2811 model
  is meant to carry is a *device-data* question, not a parser one, so it was not changed here;
  the port decision is recorded rather than guessed.
* **Whether a 2811's menu prints 8000000.** The 2500 capture stops at 4000000 and the command
  reference lists 8000000 as available "for some" hardware. One note claims the 2811's menu is
  the sixteen values through 4000000; that note is a Packet Tracer lab guide, i.e. a simulator's
  output, so it is not evidence about hardware and is not cited as any.
* **The `k`/`m` suffixes this console accepts** (`clock rate 64k`, `clock rate 1.5m`). No IOS
  form takes a unit; a real parser would answer `% Invalid input detected at '^' marker.` This
  is an input form, not an accepted range, and it was left alone in this run — it belongs with
  the other invented input spellings, not with the menu.
