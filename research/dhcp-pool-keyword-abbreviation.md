# `(dhcp-config)#`: does the pool prompt shorten its keywords?

**Question (one, narrow).** At a Cisco-style DHCP pool prompt, does the box accept an abbreviation of the pool
keywords - `net 192.168.10.0 255.255.255.0`, `def 192.168.10.1`, `dns 8.8.8.8`, `lea inf`, `exi` - and which
shortenings are still unique?

**Verdict: settled, and adopted.** Cisco states the abbreviation rule for "commands and keywords" and puts no mode
in the sentence; the pool is a mode like any other, and operators write it shortened in published transcripts. This
console resolved command words at the prompt, after `show`, at the head of a config line and inside an interface
block, and refused every shortening inside a DHCP pool with `% Unrecognized DHCP pool command: net ...` - the
sentence a typo gets, about a line a box accepts. The mode now resolves the two positions where it holds a complete
table: the first word, and the word after `no`. The `infinite` value of `lease` shortens too, since it is a keyword
of the same grammar.

## Evidence

| Source | Says |
| --- | --- |
| [Cisco IOS XE 16 Fundamentals Configuration Guide, *Using the Cisco IOS Command-Line Interface*](https://cisco.com/c/en/us/td/docs/ios-xml/ios/fundamentals/configuration/xe-16/fundamentals-xe-16-book/cf-cli-basics.html) | The rule, with no mode in it: "You can abbreviate commands and keywords to the number of characters that allow a unique abbreviation", and the vendor's own worked example `config t` for `configure terminal`. |
| [DHCP lab transcript, `Router(dhcp-config)#`](https://www.scribd.com/document/503286513/02-JOBSHEET-DNSNAT-CISCO) | `Router(dhcp-config)#net 192.168.100.0 255.255.255.0`, then `#def 192.168.100.1`, then `#dns 192.168.100.1` - three short words with their values, in one session. |
| [CME router lab transcript](https://www.scribd.com/document/687806885/NET201Lesson6-UnderstandingtheCiscoIPPhoneConceptsandConfiguringVoiceVLAN) | `CME_RTR(dhcp-config)# net 192.168.10.0 255.255.255.0` / `# default-router 192.168.10.1` / `# option 150 ip 192.168.100.1` - shortened and whole spellings in the same pool, next to a pool keyword this console does not implement. |
| [Router/switch configuration transcript](https://es.scribd.com/document/380024270/Configuracion-de-Routers-y-Switches) | `R2(dhcp-config)#net 192.168.10.0 255.255.255.0`, `#exi` to leave the pool - the mode's *exit* shortened to three letters, not just its configuration words. |
| [Chinese lab write-up, config level and pool level](https://blog.csdn.net/weixin_57619594/article/details/147009200) | `Router(config)#ip dhcp p` (the command word itself shortened) and `Router(dhcp-config)#net 192.168.1.0 255.255.255.0`. |
| [Pool-mode `?` menu in a lab transcript](https://www.studocu.com/row/document/addis-ababa-institute-of-technology/reinforced-concrete-structures-i/dhcp-on-router-it-is-interesting-course/31400667) | `Router(dhcp-config)#?` lists the mode's vocabulary (`default-router  Default routers`, `dns-server  Set name server`, `no  Negate a command or set its defaults`, ...) - the closed set the resolver counts, which is what makes "unique" decidable in this mode. |

## What is known

1. The abbreviation rule is stated once, for commands *and keywords*, with no mode qualifier - the same sentence
   this console already cites for the prompt, `show`, config lines and the interface block
   ([research/command-word-abbreviation.md](command-word-abbreviation.md)).
2. Published sessions shorten pool keywords with their values attached, so the shortened form is *executable*, not
   merely completed by the `?`/Tab helpers: `net <network> <mask>`, `def <address>`, `dns <address>`.
3. The mode's vocabulary is finite and is printed by the mode's own `?` menu, so "the number of characters that
   allow a unique abbreviation" has a definite answer here: `n` is `network | no`, `e` is `excluded-address | exit |
   end`, `h` is `host | help`, while `ne`, `de`, `dn`, `lea`, `ho`, `exi`, `excl`, `en` are each unique.
4. `excluded-address` and `excluded address` are one door. The middle word in the two-word spelling is part of the
   name, not a value, so a resolver that rewrote the head would turn `excluded address 10.0.0.1` into a command
   taking the value `address`.

## What PacketForge did, measured

On `8bc5fbe5` (main), an `ISR 4331` at `(dhcp-config)#`, before the change:

```
r1(dhcp-config)#net 192.168.10.0 255.255.255.0
% Unrecognized DHCP pool command: net 192.168.10.0 255.255.255.0
r1(dhcp-config)#def 192.168.10.1
% Unrecognized DHCP pool command: def 192.168.10.1
r1(dhcp-config)#lea inf
% Unrecognized DHCP pool command: lea inf
r1(dhcp-config)#exi
% Unrecognized DHCP pool command: exi
```

Every one of those lines is a session an operator would type after a day on real gear, and each one was answered
with the sentence the console keeps for a word it has never heard of. The pool stayed empty, and nothing in the
output said the *word* was the problem rather than the command.

## What was changed

* `engine/cli.js` - two tables, `DHCP_POOL_WORDS` and `DHCP_POOL_NO_WORDS`, one entry per branch `_dhcpPoolMode()`
  already compares against, resolved through the existing `resolveCommandWord()` (the same unique-prefix resolver
  the prompt, `show`, config lines and `(config-if)#` use). An exact spelling always wins, so `no` stays the
  negation and is not a rival of `network`; an ambiguous shortening is refused and names the rivals; `excluded
  address` still takes its values from the third token because the second one is part of the name. The `infinite`
  value of `lease` resolves as a prefix of the word.
* `test/dhcp-pool-keyword-abbreviation.test.js` - 30 assertions: every shortened word sets the same field the whole
  word sets, the whole spellings still work as the control, the `excluded`/`excluded-address`/`excl` spellings and
  their `no` forms, `no net`/`no po`, the three ambiguous prefixes with their named rivals and no state change, an
  unknown word keeping its old sentence, `lease 0` and a non-numeric lease still refused, and `exi`/`en` leaving the
  mode.
* `docs/CLI.md` - the rule's scope sentence, five rows in the abbreviation table, the pool-mode ambiguity example,
  and the paragraph that lists which keyword positions are closed sets.

## What is inferred, not stated

* **That the pool's keyword set is closed at this console's eight words.** A real pool has more (`option`,
  `client-name`, `domain-name`, `netbios-name-server`, `class`, `import`, `bootfile`, ...), and this console has
  never implemented them. The resolver can only count the words the dispatcher actually has, so a shortening that a
  real box would resolve (say `opt 150 ip 10.0.0.1`) is still refused here - as an unknown command, which is the
  truth about this console. What the console must not do is claim the word is not a *command* when the reason is
  that the command is absent, and the existing sentence is unchanged for that case.
* **That a box's ambiguous-shortening sentence is not this one.** A box prints `% Ambiguous command: "e"` (older IOS
  prints no candidates at all); this console prints `% Ambiguous DHCP pool command "e": excluded-address | exit |
  end (type more characters)`, the shape `(config-if)#` already uses. The candidates are this console's help, which
  is deliberate - but it is not a vendor transcript, and no capture in hand shows a box's own sentence at this
  prompt.
* **`lease inf`.** `infinite` is a keyword of the `lease` grammar and the rule names keywords, so the prefix
  follows. No transcript in hand types it shortened; the inference is from the rule, not from a session.

## Unresolved

* **A capture of a real box's pool-mode refusal.** The four transcripts above are lab write-ups, and at least two
  are exercises typed at a Packet Tracer prompt, where abbreviation is accepted by the simulator as well as by IOS.
  They establish the operator's habit and the executable form; they do not establish the vendor's refusal sentence
  for an ambiguous prefix at `(dhcp-config)#`. A `show`-less capture of `e` at that prompt on hardware would settle
  it, and the resolver's candidates would then be checked against the box's.
* **The words this console does not implement.** `option`, `client-name`, `domain-name`, `netbios-name-server`,
  `class` and `import` are real pool commands and are still unrecognized here. That is a missing feature, not a
  fidelity question, so nothing was added for them.
