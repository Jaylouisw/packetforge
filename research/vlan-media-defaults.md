# The other four default VLANs: can 1002-1005 be deleted, and what may the refusal claim?

**Question (one, narrow).** A switch is born holding VLAN 1 and 1002-1005, and `show vlan` prints all five.
`no vlan 1` was already refused by name. Asked to remove one of the other four, this console answered

```
sw1(config)#no vlan 1002
% VLAN 1002 does not exist
```

— about a row the same session had just printed. Is the refusal right, is the claim true, and what does the
vendor say the four ids are?

**Verdict: the refusal was right and the claim was false, and the reason the console gave for refusing to
create one was attributed to the wrong authority.** Both are fixed: `no vlan 1002` now names the row it will
not remove, and `vlan 1002` / `switchport access vlan 1002` say what the ids are instead of calling them an
IEEE reservation. Nothing about the table changed — the VLANs were never deletable, only badly described.

## What is known

The vendor states the rule in a table, in nearly every Catalyst software configuration guide, and the row is
word for word identical across them:

| VLANs | Range | Usage |
|-------|-------|-------|
| 0, 4095 | Reserved | For system use only. You cannot see or use these VLANs. |
| 1 | Normal | Cisco default. You can use this VLAN but you cannot delete it. |
| 2-1001 | Normal | For Ethernet VLANs; you can create, use, and delete these VLANs. |
| **1002-1005** | **Normal** | **Cisco defaults for FDDI and Token Ring. You cannot delete VLANs 1002-1005.** |
| 1006-4094 | Extended | For Ethernet VLANs only. |

* Catalyst 6500, *VLANs*, 15.4SY (Table 26-1) —
  https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst6500/ios/15-4SY/config_guide/sup6T/15_3_sy_swcg_6T/vlans.html
* Catalyst 3560, *Configuring VLANs*, 12.2(25)SEA (Table 17-1) —
  http://www.cisco.com/en/US/docs/general/Test/dwerblo/broken_guide/vlans.html
* Catalyst 2960-CX / 3560-CX, *Configuring VLANs*, 15.2(4)E —
  http://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst2960cx_3650cx/software/release/15-2_4_e/configurationguide/b_1524e_consolidated_3560cx_2960cx_cg/b_1524e_consolidated_3560cx_2960cx_cg_chapter_01001101.pdf

Two further sentences, repeated in the same chapters, say the same thing in prose:

> (VLAN IDs 1 and 1002 to 1005 are automatically created and cannot be removed.)
>
> You cannot delete the default VLANs for the different media types: Ethernet VLAN 1 and FDDI or Token Ring
> VLANs 1002 to 1005.

* Catalyst 3850, *Configuring VLANs*, 3.2.0SE —
  https://www.cisco.com/en/US/docs/switches/lan/catalyst3850/software/release/3.2_0_se/multibook/configuration_guide/b_consolidated_config_guide_3850_chapter_0100001.html
* Cisco IE3500, *Configuring VLANs*, IOS XE 17.18.x —
  http://www.cisco.com/c/en/us/td/docs/IIOT/switches/ie35xx/sw-config-guide/17-18/b_ie3500_1718-cg/configuring_vlans.html

Two facts follow, and they are separate:

1. **The removal is defined as an error, not as a no-op.** "You cannot delete" is stated for these ids, so a
   console that answers `% VLAN 1002 does not exist` is not merely unhelpful — it denies a fact it has already
   printed, and an operator reading it would go looking for the VLAN that is right there.
2. **They are not reserved by IEEE 802.1Q.** The same table has a Reserved row, and it holds exactly two ids:
   0 and 4095, "for system use only". 1002-1005 sits below it, under **Normal**, and its usage column
   attributes it to *Cisco defaults for FDDI and Token Ring*. The standard reserves the two ids that cannot be
   put in a tag field at all; these four are a vendor's media defaults that the vendor chose not to let you
   remove.

## What was wrong here, measured

One Catalyst-2960-class switch, no configuration, one session:

```
sw1#show vlan brief
VLAN Name                             Status    Ports
---- -------------------------------- --------- -------------------------------
1    default                          active    Fa0/1, Fa0/2, ... Fa0/24
1002 fddi-default                     act/unsup
1003 token-ring-default               act/unsup
1004 fddinet-default                  act/unsup
1005 trnet-default                    act/unsup

sw1(config)#no vlan 1002
% VLAN 1002 does not exist        <-- printed about the row above
sw1(config)#vlan 1002
% VLAN id 1002 is reserved by IEEE 802.1Q (1002-1005)
sw1(config-if)#switchport access vlan 1002
% access VLAN 1002 is reserved by IEEE 802.1Q (1002-1005)
```

The creation refusal was not written for this run: it comes from `validatePortConfig()`, the same function that
guards a port, which is why one wrong attribution reached three doors at once. One message generated once and
printed everywhere is a good property; the string in it still has to be true.

## What changed

* `engine/cli.js` — the `no vlan` branch checks `RESERVED_VLANS` before it asks whether the VLAN is in the
  config, and answers:

  ```
  % VLAN 1002 is the fddi-default VLAN: it is one of the four FDDI and Token Ring defaults (1002-1005),
    created at boot, and cannot be deleted
  ```

  Shaped like the VLAN 1 sentence beside it (name the row, then the rule), and reading the ids from the same
  frozen list `show vlan` prints its rows from, so the refusal and the table cannot name different ids.
* `engine/vlan.js` — the `E_VLAN_RESERVED` message became `is reserved: it is one of the four FDDI and Token
  Ring defaults (1002-1005)` in both the range parser (`switchport trunk allowed vlan 1002`) and the port
  validator (`switchport access|native|voice vlan 1002`). The word "reserved" stays — it is how the docs
  already describe the block — but the attribution to IEEE 802.1Q is gone, and so are the four comments that
  called it the "IEEE block".
* `test/vlan-media-defaults.test.js` — 42 assertions: each of the four ids refused without claiming absence,
  the table and the running-config unchanged afterwards, `no vlan 1006` still answered as absent, an ordinary
  VLAN still removable, `no vlan 1` unchanged, all three creation doors refusing with the media words and no
  IEEE, and a router (no VLAN database) getting the same rule.
* `docs/CLI.md` — the VLAN 1 paragraph, which already carried the "1 and 1002 to 1005 … cannot be removed"
  sentence, now records the other four and the corrected reason; the printed refusal under "A VLAN id is a
  number" is updated to what the console says.

## What remains unresolved

* **The exact words a real box prints for `no vlan 1002`.** *Settled since this note was written*, by four
  transcripts: a live 2960X answers `%Default VLAN 1002 may not be deleted.`, the same sentence VLAN 1 gets
  with the number substituted, and a range prints it once per default VLAN. The console now prints that
  sentence verbatim instead of the paraphrase recorded under "What changed" above; sources and the open
  VTP-client case are in `research/default-vlan-refusal-wording.md`.
* **Whether `vlan 1002` should be accepted.** The range table says user configuration lives in 2-1001, and the
  VLAN chapters say only that these four "cannot be removed" — not that they cannot be modified. A real switch
  may well enter `(config-vlan)#` for 1002 and let `name` rename fddi-default. This console refuses outright,
  which is defensible for a box that cannot carry FDDI here, but it is a choice, not a citation. Evidence: a
  capture of `vlan 1002`, `name test`, `end`, `show vlan brief`.
* **Whether a port may be assigned to one.** `switchport access vlan 1002` is refused here by the same
  validator, and that refusal is this model's choice, not a citation: `show vlan` prints the four rows
  `act/unsup`, but the vendor never defines that status word, and the command's own documented range
  (1-4094) includes these ids. No transcript in hand shows the attempt. Sources, the one vendor sentence
  that gives a reason (they are not Ethernet VLANs) and the capture that would settle it are in
  [media-default-vlan-as-access-vlan.md](media-default-vlan-as-access-vlan.md).
* **VTP.** On a box in VTP server mode the removal is refused for the whole domain, and in transparent mode
  only locally. This model has no VTP, so the refusal here is the local case only.
