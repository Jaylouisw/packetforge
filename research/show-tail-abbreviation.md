# A shortened keyword at the end of a `show` line: `show vlan br`, `show ether summ`, `sh lldp nei`

**Question (one, narrow).** This console resolves the first word after `show` by unique prefix
(`sh ver`, `sh int`, `sh sp` - `research/command-word-abbreviation.md`), and compared every word after it with
`===`. So the spellings operators actually type - `sh vlan br`, `sh ether summ`, `sh lldp nei`, `sh ip int br` -
were answered as if the words did not exist:

```
sw1#show vlan br        -> % show vlan does not take "br": every VLAN is listed ...
sw1#show ether sum      -> % show ether does not take "sum": the whole summary is printed ...
sw1#show lldp nei       -> % show lldp does not take "nei": the status view takes no word ...
sw1#show ip int br      -> % Invalid show command: ip int br
```

Does a real IOS-like box accept a shortened keyword in that position, refuse it as ambiguous, or call it invalid
input - and where can this console apply the answer without claiming something another image contradicts?

**Verdict: a box accepts it; the boundary is the keyword set of the image, not the position; and the console now
applies the rule at the four slots where the vendor's own syntax leaves no rival - `brief` after `show vlan` and
after `show ip interface`, `summary` among `show etherchannel`'s views, and `neighbors` after `show lldp`.** The two
everyday spellings that need a *rival set* to answer honestly - `show mac add` and `show ip int br` - are left
refused, and this note says exactly why and what would settle them.

## What is known

**1. The vendor's rule is written for keywords, not for the first word of a line.** The sentence is the same in
every CLI chapter, in the "Understanding Abbreviated Commands" section:

> You need to enter only enough characters for the switch to recognize the command as unique.

* Catalyst 2960 12.2(46)SE Software Configuration Guide, *Using the Command-Line Interface* -
  http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960/software/release/12-2_46_se/configuration/guide/scg1/swcli.pdf
* Catalyst 2960-X 15.2(2)E Routing Configuration Guide, *Understanding Abbreviated Commands*, whose worked example
  is `Switch# show conf` for `show configuration` -
  http://cisco.com/c/en/us/td/docs/switches/lan/catalyst2960x/software/15-2_2_e/routing/configuration_guide/b_rt_1522e_2960x_cg.pdf

No wording in those chapters limits the rule to the command word, and the error table beside it defines the one
refusal a shortened keyword can draw:

> `% Ambiguous command: "show con"` - "You did not enter enough characters for your switch to recognize the command."

**2. Captures show shortened tails accepted, at four different positions.** These are pasted sessions, not
tutorials - the output follows the prompt in the same post:

| typed | words shortened | source |
| --- | --- | --- |
| `sh ip int br` | `int` = `interface`, `br` = `brief` | community attachment "ports.txt" (a stack that answers `sh int status` beside it) - https://community.cisco.com/kxiwq67737/attachments/kxiwq67737/5486-discussions-optical-networking/9844/1/ports.txt |
| `CoreSW1#sh ip int br \| ex un` | same, with a filter | https://community.cisco.com/t5/routing/please-help-me-to-configure-below-network-topology/td-p/4054592 |
| `Router>sh ip int br`, `Router#sh ip int br` | same, on a 2900 ISR | https://community.cisco.com/t5/routing/cisco-2900-series-hwic-serial-1t-amp-2t-down-down/td-p/4560503 |
| `SW1#sh vlan  br`, `3548-EX1#show vlan br` | `br` = `brief` | https://community.cisco.com/t5/switching/cant-access-my-management-vlan-address-of-my-switch/td-p/3712129 and https://community.cisco.com/t5/other-network-architecture-subjects/vlan-deleted-but-active/td-p/502762 |
| `CORE#sh etherc summ`, `4500#sh etherc summ`, `6500#sh etherc summ` | `etherc` = `etherchannel`, `summ` = `summary` | https://community.cisco.com/t5/routing-and-sd-wan/ospf-neighborship-keeps-dropping-and-reforming/td-p/4402814 |
| `SW1#sh etherchannel sum`, `SW1#sh ether summ`, `SJCAT3650#sh ether summ` | `sum` / `summ` = `summary` | https://community.cisco.com/t5/switching/few-questions-about-etherchannel/m-p/1056635 and https://community.cisco.com/t5/switching/unable-to-ping-hsrp-interface-ip-vlan/td-p/4102335 |
| `R1#sh lldp nei` | `nei` = `neighbors` | https://learningnetwork.cisco.com/s/question/0D53i00000Kt0IKCAZ/speed-mismatch-magic |

**3. The same spelling can be refused on another image, and the refusal is `% Ambiguous command`.** A CCNA lab
text prints:

```
SW1# sh mac add
% Ambiguous command: "sh mac add"        ("add" matches address and address-table)
```

and its quiz answer states the rule outright: "add could match more than one keyword (address, address-table), so
the command is ambiguous" - https://www.hsmpress.ca/ccna-v11/4.php. Yet the same spelling is *accepted* elsewhere:
`SW2-3750#sh mac add` (https://learningnetwork.cisco.com/s/question/0D53i00000Kt0piCAB/static-mac-address-type-when-portsecurity-enabled),
`Switch#sh mac add` on a 3750 (https://community.cisco.com/t5/other-security-subjects/802-1x-and-spanning-tree/m-p/4191156),
and `6509#sh mac add add ecf4.bb48.3ed0`, where the first `add` completes `address-table` and the second completes
the `address` keyword under it (https://community.cisco.com/t5/switching/show-mac-table-output-query-cisco-6509/m-p/3079176).

So the minimum length is a property of the image's keyword set at that position: an image holding both
`show mac address` and `show mac address-table` calls `add` ambiguous, one holding only `address-table` accepts it.
No source read here shows a box answering `% Invalid input detected` for a shortened *known* keyword - the refusal
class is always ambiguity.

## What PacketForge did about it

`engine/cli.js` gained `shortenedKeyword(typed, word)`: the whole word when the typed token is a strict prefix of
it, `null` otherwise. It is called at four slots, and only these:

| slot | completion | why this slot has no rival |
| --- | --- | --- |
| `show vlan <x>` | `brief` | syntax is `show vlan {brief \| id vlan-id \| name vlan-name \| mtu vlan-id}`; none of the others begins with `b` |
| `show lldp <x>` | `neighbors` / `neighbours` | `show lldp {entry \| errors \| interface \| neighbors \| traffic}`; `n` is unique, and the British spelling keeps its own completion |
| `show etherchannel [n] <x>` | `summary` (and `brief`) | the six views are `detail, port, port-channel, protocol, summary`; `s` and `b` are unique, `p` is not and is left as typed |
| `show ip interface <x>` | `brief` | `show ip interface [type number] [brief]` lists one keyword |

The `show ip interface` one is resolved *before* `_showIpRedirect()`, because that helper rewrites the bare alias
`interface` to `interfaces`, after which the tail was read as a port name and `show ip interface br` answered
`% No interface br on ...` - a socket nobody had named.

`test/show-tail-abbreviation.test.js` pins 47 assertions: each shortening prints the whole spelling's answer byte
for byte (including `show   vlan   br` with doubled spaces, and `do show vlan br` from config mode), the port form
`show ip interface Gi0/0` is untouched, and every position left refused below is asserted as still refused.

## What is inferred, and where the rule deliberately stops

* **`show ip int br` is still refused, and that is a gap, not a principle.** `int` collides with none of the box's
  rivals under `show ip` (`inspect`, `igmp`, `input`), and `br` collides with nothing under `show ip interface`, so
  that spelling is safe on every image read here - it is also the most-typed form in the captures above. What is
  missing is a rival list for the `show ip` position: resolving a prefix there against *this console's* table alone
  would accept `show ip i` and `show ip in`, which a router image answers `% Ambiguous command`. Splitting the
  table (the console's words plus the box words it does not model) is a design change, and
  `test/command-word-abbreviation.test.js` currently pins `show ip int br` as refused, so flipping it belongs in the
  run that adds the rival list and asserts the ambiguous half too.
* **`show mac add` is left refused because two images disagree.** Accepting it would be right on a 3750 and a 6509
  and wrong on the image in the CCNA lab; answering `% Ambiguous command` would be right there and wrong on the
  other two. The console keeps its old sentence rather than pick an image silently. It is still the wrong *class*
  of answer - a box never calls a shortened known keyword invalid - and that is recorded here rather than fixed by
  guessing.
* **`show vlan i` is not resolved to `id`.** `id` is unique in this console's table, but 3560/3750-class images
  also carry `show vlan ifindex` (and `internal`), so `i` is a prefix with rivals the console does not model. The
  same reasoning keeps `show ether p` (port / port-channel / protocol) and `show lldp e` (entry / errors) refused.

## What is unresolved

1. **The `show ip` rival set.** What would settle `show ip int br` and `show ip i` in one change: a pasted
   `show ip ?` from a router image and from a LAN-switch image, which enumerates the words that make a prefix
   ambiguous (`inspect`, `igmp`, `input`, `rpf`, `admission`, ...). One capture of each would be enough.
2. **Whether `sh mac add` is ambiguous on the 2960 line itself.** The 2960-X 15.2(7)E page read here lists only
   `show mac address-table` and no `show mac address` form, which suggests `add` is unique there - but no 2960
   capture of `sh mac add` was found either way, and the one lab that shows the refusal does not name its model. A
   `show mac ?` from a 2960 and from a 9200 would decide which image this console should imitate, and then the
   position could be resolved (or refused as ambiguous) on evidence instead of left alone.
3. **The wording of the ambiguity itself.** A box prints `% Ambiguous command: "show con"`; this console has used
   `% Ambiguous command "c": configure | converge (type more characters)` since #1661. If a shortened tail is ever
   resolved, that second style is the sentence to use - the same fact in one house sentence - but it is a
   message-text question of its own (`research/show-incomplete-view-word.md` records the same open item).

## Sources

* Abbreviation rule and the error table: 2960 12.2(46)SE `swcli.pdf`; 2960-X 15.2(2)E routing guide
  ("Understanding Abbreviated Commands"); 2960-X 15.2(7)E Consolidated Platform Command Reference, Table 3.
* `show ip interface [type number] [brief]`:
  https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/interface/command/ir-cr-book/ir-s5.html
* `show vlan` syntax: Catalyst 2960-X 15.2(7)E command reference, "show vlan".
* `show etherchannel` six views: `research/etherchannel-summary-layout.md` (same reference set).
* Field captures: the eight community / learning-network links in the tables above, and the CCNA lab page for the
  ambiguous `sh mac add`.
