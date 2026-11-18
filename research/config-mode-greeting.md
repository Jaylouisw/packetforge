# What a box prints when you open configuration mode

**Question (one, narrow).** An IOS session's config block always begins with one sentence. What is it,
character for character — one line or two, and how many spaces after `line.`? And which command prints it:
every entry into global configuration mode, or every config command?

**Verdict: known, and adopted.** `Enter configuration commands, one per line.  End with CNTL/Z.` — one line,
two spaces after `line.`. It is the answer to the command that opens the mode (`configure terminal`, in any
of its accepted abbreviations), printed once per entry, and nothing is printed by the config commands that
follow or by the submodes they open. This console opened config mode in silence; the sentence is now printed,
from one constant in `engine/cli.js`, and `test/config-mode-greeting.test.js` pins the string and the "once
per entry" rule (23 checks).

## The sentence

| Source | What it shows |
| --- | --- |
| Catalyst 3560 Switch Command Reference, Rel. 12.2(25)SEA, "Using the Command-Line Interface" — [PDF](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3560/software/release/12-2_25_sea/command/reference/3560cr/intro.pdf) | `Enter configuration commands, one per line.  End with CNTL/Z.` — **one line, two spaces**, in the Courier face the transcript is set in. This is the text layer of the PDF, which keeps runs of spaces |
| The same chapter in [HTML](http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst3560/software/release/12-2_25_sea/command/reference/3560cr/intro.html) | the same two sentences, rendered as **two lines**, and the double space collapsed to one |
| Cisco IOS XE 16.6 Configuration Fundamentals, "Using the Cisco IOS Command-Line Interface" — [HTML](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/configuration/xe-16-6/fundamentals-xe-16-6-book/cf-cli-basics.html) | `Router# configure` / `Configuring from terminal, memory, or network [terminal]? terminal` / `Enter configuration commands, one per line. End with CNTL/Z.` / `Router(config)#` — one line, and the sentence follows *the answer to the prompt*, not the command |
| Cisco IOS Configuration Fundamentals 12.2SX, "Using the Cisco IOS Command-Line Interface" — [HTML](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/configuration/12-2sx/cf-12-2sx-book/Using_the_Cisco_IOS_Command-Line_Interface.html) | the same session, the sentence wrapped across two lines in the rendered block |

The disagreement is the *rendering*, not the device. HTML collapses a run of spaces into one (so no HTML page
can tell one space from two) and Cisco's own pages break the sentence at `line.` in some editions and keep it
whole in others. A third rendering trap is visible in the wild: Oracle's Exadata switch instructions print the
line as `Enter configuration commands,one per line.End with CNTL/Z.` — [docs.oracle.com](https://docs.oracle.com/en/engineered-systems/exadata-database-machine/dbmin/configuring-cisco-catalyst-4948-ethernet-switch.html)
— because their documentation pipeline ate the spaces around the full stop entirely, so "what the page shows"
is not evidence of spacing at all. The PDF text layer, set in a monospaced face at one baseline, is the
evidence: one line, two spaces.

Transcripts pasted by practitioners are split down the middle the same way — netmiko's own examples print two
lines ([EXAMPLES.md](https://github.com/ktbyers/netmiko/blob/develop/EXAMPLES.md)), while an IOS XE capture in
Cisco's 16.6 guide and the 3560 PDF print one. A reader who compares a simulator against a pasted forum
transcript can therefore find a line break that the hardware did not print.

## Which command prints it, and how often

1. It belongs to the entry into **global configuration mode**. `configure terminal` prints it; `configure` on
   its own prints `Configuring from terminal, memory, or network [terminal]?` first, and the sentence comes
   after the answer (IOS XE 16.6, above).
2. It is printed **once per entry**. Nothing in the captures shows the sentence repeated inside a config
   block, and no config command or submode (`interface`, `vlan`, `router bgp`, `ip dhcp pool`) reprints it.
3. `end` prints nothing — it is a mode change, not a command with an answer.
4. A refused `configure` (`% Incomplete command`, or a word that is not `terminal`) prints no sentence,
   because no mode was entered.

## What is inferred

The two spaces are a fixed part of the string, not a tab stop or a column alignment: the sentence is printed
verbatim by the CLI, and the PDF's Courier text layer places both spaces between `line.` and `End`. The
sentence is also identical on IOS 12.x, IOS XE 16.x and 17.x, so nothing about the platform in this catalogue
changes it — and since this console speaks IOS grammar for every vendor, the IOS spelling is the one printed.

## What remains unresolved

- **Wrapping at a narrow terminal width.** IOS wraps printed output at the terminal width (`terminal width`,
  default 80 columns), and the sentence is 60 characters, so it fits at the default. Whether a box at
  `terminal width 40` breaks it after `line.` — which would produce the two-line shape so many HTML pages show
  — was not captured anywhere found. This console has no width model, so it prints one line.
- **Whether `configure terminal` is reachable from user EXEC at all.** A real box at `Router>` does not offer
  `configure` (the command list is the user-EXEC subset), so it answers the line with an error and prints no
  greeting; this console accepts the word in both EXEC modes and therefore now prints the sentence from `>`
  too. That is a different question - which commands a `>` session has - and it is left alone here.
- **NX-OS and IOS XR.** NX-OS documentation prints the same sentence; IOS XR prints `Entering configuration
  mode` instead. Neither changes what this console says, because it says IOS's sentence on every device, but
  the exact NX-OS spacing was not measured from a text layer.
