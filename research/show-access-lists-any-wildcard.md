# `show access-lists`: is `0.0.0.0 255.255.255.255` printed as `any`?

**Question (one, narrow).** A standard ACL entry is typed in the spelled-out form of *any* —
`access-list 10 permit 0.0.0.0 255.255.255.255`. When the operator reads it back with `show access-lists`, does the box
print the address and wildcard as typed, or does it print the entry the way it prints `permit any`?

This note closes the second bullet under *What remains unresolved* in
[show-access-lists-standard-address-form.md](show-access-lists-standard-address-form.md), which recorded the fold as
unproven and told the renderer not to assume it.

**Verdict: settled — a box prints `any`, because `any` is what it stored.** The address/wildcard pair is turned into an
access-control entry when the line is parsed, and `0.0.0.0 255.255.255.255` is the expansion of the keyword, not a
different entry. Both views (`show access-lists`, `show running-config`) print the entry, so both print `any`. The
console kept `any` as a flag that was only set when the word was typed, and printed every other entry in the
`<address>, wildcard bits <wildcard>` form — so an operator who typed the long form read back a rule no box prints.

## The captures

### A typed `0.0.0.0 255.255.255.255` comes back as `any` — extended list

Cisco Community, *Basic ACL config question* (solved thread). The asker wants the difference between
`access-list 100 permit ip 0.0.0.0 255.255.255.255 any` and `access-list 100 permit ip any any`; the reply is a
transcript from a live router:

```
Router(config)# do show access-lists

Router(config)# access-list 100 permit ip 0.0.0.0 255.255.255.255  any
Router(config)#
Router(config)# do show access-lists
Extended IP access list 100
    10 permit ip any any
Router(config)# do show run | i access-list
access-list 100 permit ip any any
```

> The word **any** is simply a shorthand for **0.0.0.0 255.255.255.255** and in fact, whenever you enter
> **0.0.0.0 255.255.255.255** in your ACL, IOS will automatically replace it with **any**

<https://community.cisco.com/t5/switching/basic-acl-config-question/td-p/2961057>

Two things this settles beyond the single line: the *display* is generated from the stored entry (not from the typed
text), and `show running-config` regenerates the same entry — so this is one rule about the ACE, not two rules about two
commands. The sequence number `10` also shows the body being rendered, not echoed: the typed line carried none.

### The same fold on a standard list

A CCNA course page working through the Cisco document *Configure IP Access Lists* (doc 23602) types both spellings of
*any* into list 1 and then reads the list back:

> We tried configuring that ACL, let's check it out. For both the deny and permit entries we entered the whole IP
> address and wildcard mask. Notice that the router automatically converted DENY 1.1.1.1 0.0.0.0 to just DENY 1.1.1.1.
> The router does this when you use a /32 mask. The router also converted PERMIT 0.0.0.0 255.255.255.255 to PERMIT ANY.

<https://dti-techs.gitbook.io/practical-foundations-in-cybersecurity/4.-networking-fundamentals/how-to-configure-standard-acls-on-cisco-routers>

The page is a course page, not a vendor document, and the two output screenshots are images so their exact columns are
not in the text — which is why the pair of facts it states in one breath matters: the `/32` fold (`DENY 1.1.1.1 0.0.0.0`
→ `DENY 1.1.1.1`) is one this console already implements from its own captures, and the *any* fold is stated in the
same sentence about the same output. A page inventing one would have to invent the other, and the other is confirmed
elsewhere.

### The vendor says the two spellings are one object

* *Configure IP Access Lists* (doc 23602): "A source/source-wildcard setting of 0.0.0.0/255.255.255.255 can be
  specified as **any**", and in the mask table "The source/wildcard of 0.0.0.0/255.255.255.255 means any" —
  <https://www.cisco.com/c/en/us/support/docs/security/ios-firewall/23602-confaccesslists.html>
* Cisco IOS Security Command Reference, `show access-lists`: the sample output for a compiled list is
  `Standard IP access list 1 (Compiled)` / `deny any`, and list 2 prints `deny 192.168.0.0, wildcard bits 0.0.0.255` /
  `permit any` — the canonical form of an entry, with no address anywhere on the *any* line —
  <https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/security/s1/sec-s1-cr-book/sec-cr-s2.html>
* A real `sh ip access-lists` from another Cisco Community thread prints the same shape with a counter attached:
  `Standard IP access list 21` / `10 permit 10.8.39.33 (7648 matches)` / … / `60 deny any (4 matches)` —
  <https://community.cisco.com/t5/network-access-control/dacl-to-switch/td-p/2096170>

## What was wrong here, measured

`engine/acl.js`, one entry built from the numeric form, before and after:

```
before: permit 0.0.0.0, wildcard bits 255.255.255.255
after : permit any
```

The entry was parsed correctly all along (`{ ip: '0.0.0.0', wildcard: '255.255.255.255', any: false }`), so the rule
matched traffic exactly as `any` would; only the rendering disagreed with the box. That is the worst kind of
fidelity bug for a lab exercise, because the operator checking their work is told their rule is not the rule they meant.

## What was changed

`engine/acl.js` grew `isAnySpec(spec)`: an entry is *any* when the keyword was typed **or** when the address parses to
`0.0.0.0` and the wildcard to `255.255.255.255`. `displayBody()` uses it in place of the `spec.any` flag, so a standard
entry typed in either spelling prints `permit any` / `deny any`, keeps a trailing ` log`, and keeps its sequence number
and count. `test/show-access-lists-standard-address-form.test.js` grew five checks (the numeric form, the numeric form
with `log`, an all-ones wildcard over a real address, `host 0.0.0.0`, and the renderer called directly): 22 checks pass.
`test/acl-data.test.js` and the wider suite are unchanged by this.

Nothing else moved: the counter is still keyed by the typed line, `show running-config` still echoes what was typed
(the note above deliberately left that alone), and extended entries still print their typed text.

## What is inferred

* **That a standard list behaves like the extended one.** The transcript is an extended list and the course page is a
  standard list; both fold. The fold happens where an address and wildcard become an entry, which is shared code on a
  box, and the vendor's "can be specified as **any**" is a statement about the operand, not the list kind.
* **That the count is still printed against a folded line.** No capture pairs `log` with a counter, and none pairs a
  folded *any* with a counter; the counter is a property of the entry, so it travels with whatever body is printed.

## What remains unresolved

* **Whether an all-ones wildcard over a *non-zero* address is also folded.** `10.0.0.1 255.255.255.255` matches every
  address just as *any* does, and a box that stores a wildcard-and-address pair could well print `any` for it too. No
  capture in hand typed that, so this console prints it in the `wildcard bits` form rather than inventing the fold.
  A capture of `access-list 10 permit 10.0.0.1 255.255.255.255` read back would settle it.
* **Extended lines, which are still echoed as typed.** The capture above shows an extended line folded as well
  (`permit ip any any`), so the rule is known; this console has no extended renderer to apply it in — it prints the
  typed text for every extended entry — and building one is a separate question about the whole extended grammar
  (ports, `established`, `log-input`), not about *any*.
* **`show running-config`.** A box prints the folded form there too (both captures show it). This console echoes the
  typed line in its configuration, which is the choice recorded in
  [show-access-lists-standard-address-form.md](show-access-lists-standard-address-form.md); making the two views agree
  is a separate increment with its own round-trip consequences.
* **The action column's padding** (`20 deny   any log`) is still recorded as unresolved in
  [show-access-lists-numbering.md](show-access-lists-numbering.md) and is untouched here.
