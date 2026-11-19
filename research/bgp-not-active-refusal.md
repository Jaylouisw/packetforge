# `show ip bgp` with no BGP process: which words does the box refuse with?

**Question (one, narrow).** On a Cisco IOS / IOS XE box with no `router bgp` configured, what exactly does
`show ip bgp` print - and is the line the same for the narrowed forms (`show ip bgp summary`,
`show ip bgp regexp ...`)?

**Verdict: `% BGP not active`, the same five words for every sub-view captured.** This console printed
`% BGP is not enabled` - a correct description of the same fact in words no box uses, with a different
grammar (`is`, `enabled`) and the word order reversed. Changed, with a regression test.

## What PacketForge printed

One door, `_showBgp()` (`engine/cli.js`), serves `show ip bgp`, `show ip bgp summary`, `show ip bgp
neighbors` and any other tail; with no `config.bgp.as` it answered all of them with:

```
% BGP is not enabled
```

Measured on a 2811 and on a Catalyst 2960X (the same string on both, because the guard is on the config
object and not on the platform):

```
r1# show ip bgp
% BGP is not enabled
r1# show ip bgp summary
% BGP is not enabled
```

A reader who knows the box therefore sees a line the box does not print in the one place that means
"nothing is wrong with the command, there is no process".

## Evidence

| Source | Says |
| --- | --- |
| [Cisco Community, "BGP Synchronization and MPLS"](https://community.cisco.com/t5/routing-and-sd-wan/bgp-synchronization-and-mpls/td-p/2904090) (posted 2016, edited 2019) | One lab, one image: `R11#sh ip bgp` and `R13#sh ip bgp` print full BGP tables on the same page, and the router in the middle without a process prints `R12#sh ip bgp` / `% BGP not active`. The contrast is the point - this is not a box that cannot run BGP. |
| [Cisco Community, 9800 WLC AP-filter thread](https://community.cisco.com/t5/wireless/automatically-apply-tag-policy-tag-rf-tag-site-on-cisco-9800-wlc/td-p/4906039) | An operator wishing the WLC had a regex tester types `#sh ip bgp regexp ^abc` and gets `% BGP not active`. IOS XE, a different platform family, the narrowed form, the same words. |
| [pinglabz, MPLS L3VPN walkthrough](https://www.pinglabz.com/mpls-l3vpn-configuration-step-by-step/) (IOS XE five-router lab; "every command and every line of output comes from" the lab) | `P ip bgp summary` / `% BGP not active`, in the section about the P router being BGP-free. |
| [oznetnerd, Ansible tags post](https://oznetnerd.com/2017/04/14/use-ansible-tags-organise-plays-tasks/) | Not a hand-typed transcript but the registered output of `ios_command: show ip bgp` on two routers: `"show_out.stdout_lines": [["% BGP not active", ""]]`. Machine output, so the spelling cannot be a rewrite. |
| [Arista, Security Advisory 0207](https://www.arista.com/ko/support/advisories-notices/security-advisory/25029-security-advisory-0207) (2026-11-10) | The rival spelling: "the output will look like `switch>show ip bgp summary` / `% BGP is not active`". One word different (`is`), which is what makes this a vendor's line rather than a law of nature. Quoted from the page's own not-affected example; the advisory body is JS-rendered and the block did not survive the text extract, so this one is second-hand. |
| Cisco [IOS](https://www.cisco.com/c/en/us/td/docs/ios/iproute_bgp/command/reference/irg_book/irg_bgp5.html) and [IOS XE](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/iproute_bgp/command/iproute_bgp-xe-3se-3850-cr-book/iproute_bgp-xe-3se-3850-cr-book_chapter_0100.pdf) BGP command references | Document the populated views field by field and print no off-case example. The refusal is attested only by captures, not by a vendor sentence - normal for a message string, and worth stating. |

## What is known

1. The string is `% BGP not active`: one space after the `%`, no `is`, no trailing full stop.
2. It does not vary with the sub-view in any capture: `show ip bgp`, `show ip bgp summary` and
   `show ip bgp regexp ...` all print the identical line (three platforms, three forms).
3. It is a statement about the *process*, not the platform: the R11/R12/R13 thread has routers that print a
   table and one that prints the refusal, same lab, same features.
4. Arista words the same fact differently (`% BGP is not active`). A console that models Cisco should print
   Cisco's.

## What is inferred

* **`show ip bgp neighbors` takes the same line.** No capture of that exact form in hand; it is inferred
  because every BGP show verb on IOS funnels through the same "is the process running" guard, and because
  the two forms that *were* captured differ as much as summary and regexp. The test asserts it, so the
  inference is visible rather than silent.
* **A box refuses in user EXEC (`>`) the same way.** All four captures are privileged (`#`); the guard does
  not live in the privileged path on IOS in any way a reader could name, but this is an inference.

## What is unresolved

* **The config-mode refusals.** This console answers `bgp router-id <ip>`, `bgp always-compare-med` and
  `neighbor <ip> remote-as <as>` in *global* config with `% BGP is not enabled (use "router bgp <as>")`.
  A box has no global `bgp router-id` at all - it lives under `router bgp` - so its answer would be
  `% Invalid input detected at '^' marker.`, and this console's sentence is a signpost for a grammar it
  deliberately accepts in one flat config mode. That half is not a wording question about an existing
  view; it is a question about the config model, and it is left exactly as it was.
* **NX-OS and IOS XR.** No capture of their off-case line; NX-OS requires `feature bgp` and IOS XR has a
  different command set, so neither is evidence about IOS and neither is modelled here.
* **A configured-but-inactive process.** Whether IOS has a state where `router bgp` is present and the
  process is nonetheless not active - the state in which the guard would have to read more than the stored
  AS - was not found. This model has no such state below `no router bgp`, so the guard is "no
  `config.bgp.as`" and the note records that it is only as fine as the model behind it.

## What changed

* `engine/cli.js`, `_showBgp()`: the refusal is `% BGP not active`. One string; the comment above it carries
  the captures so the next reader does not have to re-derive it.
* `test/bgp-not-active.test.js`, 13 assertions: the exact line on four spellings (bare, `summary`,
  `neighbors`, `regexp`), no `is`, no full stop, the old sentence gone rather than appended; the view still
  answers with the router identifier and AS once `router bgp 65001` exists; the refusal returns after
  `no router bgp 65001`; and an L2 switch with no BGP capability answers the same line rather than an
  invented capability message.
* `docs/CLI.md`, "Reading `show ip bgp`": the refusal, its shape and the Arista divergence.

## What evidence would settle the rest

1. `show ip bgp` and `show ip bgp neighbors` at the `>` prompt on an IOS box with no BGP process - one
   paste settles both inferences.
2. `show ip bgp` on NX-OS 9000 (no `feature bgp`) and on IOS XR 7.x (no `router bgp`) - two lines, and the
   per-vendor table either grows a column or is honestly left Cisco-only.
3. A capture of `bgp router-id 1.1.1.1` typed at **global** config on IOS, which decides whether the
   config-mode signpost should ever be replaced by the caret line.
4. The raw text of Arista advisory 0207's not-affected block, to promote the rival spelling from second-hand
   to primary.
