'use strict';
/**
 * lag.ts -- LACP / LAG (link aggregation) model.
 *
 * Covers the three things a topology editor and the CLI need:
 *   1. normalising a LAG definition (mode, hash policy, members, min links)
 *   2. hashing a frame into [0,1) and picking a bundle member from it
 *   3. validating a bundle against the physical ports it claims
 *
 * Everything here is pure data + pure functions. No dependency on Device,
 * Topology or the simulator, so it is safe to require from the engine, the
 * server, the CLI or the tests. Hashes are deterministic (FNV-1a over the
 * selected tuple) -- never Math.random -- so a given frame always lands on the
 * same member, which is what makes flows stable across calls and across runs.
 *
 * TypeScript (docs/TYPESCRIPT.md), and the module the conversion order page names as row three: it is
 * the one file a converted file already required (`engine/segment.ts` said `require('./lag')`, which
 * worked only while this file was JavaScript). That require names `./lag.ts` now.
 *
 * Everything that crosses this module's boundary is either a value the caller passes in as data - a
 * saved lab's LAG block, a frame to hash, a member list - or a value a still-JavaScript class hands
 * over (a channel group from `Device.lagFor()`). The first kind is `unknown` and is narrowed by the
 * guards that were already here (`normalizeLag()`, `memberList()`, `isObject()`); the second is
 * narrowed by `groupMode()`. No `as`, and nothing is asserted into existence: a value this module
 * cannot read is treated the way the function already treated it, not refused with a new error.
 */

// A `.ts` file with no top-level import is a *script* in the type system: its top-level names land
// in one global scope shared with every other such file. This empty, type-only import is erased by
// the strip-types runtime and is what marks the file as a module.
import type {} from 'fs';

/** The shape a LAG definition is normalised into, and what every function below is handed afterwards. */
interface LagConfig {
  readonly id: string;
  readonly mode: string;
  readonly hashPolicy: string;
  readonly members: readonly string[];
  readonly minLinks: number;
}

/** One finding: the code a caller matches on, and the sentence it prints. */
interface LagProblem {
  readonly code: string;
  readonly message: string;
}

/** What `validateLag()` answers with. `ok` is `errors.length === 0`, stated rather than inferred. */
interface LagVerdict {
  readonly ok: boolean;
  readonly errors: readonly LagProblem[];
  readonly warnings: readonly LagProblem[];
}

/**
 * One physical port as a *caller* describes it: `{ name, speedMbps, duplex, vlanCompatible, enabled }`.
 * Every field but the name is optional and `unknown`, because this is a document shape - the API door,
 * a saved lab and a test fixture all hand one in - and `validateLag()` is the function whose job is to
 * say what is wrong with it, not a place that trusts it.
 */
interface MemberPort {
  readonly name?: unknown;
  readonly speedMbps?: unknown;
  readonly duplex?: unknown;
  readonly vlanCompatible?: unknown;
  readonly enabled?: unknown;
}

/** A member that has a port record, paired with the name it was listed under. */
interface KnownMember {
  readonly name: string;
  readonly port: MemberPort;
}

/** The far end of a member's cable, exactly as `Interface.peer` records it. */
interface PortPeer {
  readonly deviceId: string;
  readonly iface: string;
}

/** The port fields this module reads: its cable's far end, and whether it is administratively up. */
interface MemberIface {
  readonly peer?: PortPeer | null;
  readonly enabled?: boolean;
}

/**
 * The device surface `memberSuspension()` reads (engine/device.js `Device`). `lagFor` answers `unknown`
 * on purpose: the class that implements it is still JavaScript, so what comes back is narrowed by
 * `groupMode()` below rather than declared here as a shape nothing checks.
 */
interface LagDevice {
  readonly interfaces?: { get(name: string): MemberIface | undefined } | null;
  lagFor?(ifaceName: string): unknown;
}

/** The topology surface `memberSuspension()` reads (engine/topology.js `Topology`). */
interface LagTopology {
  getDevice(id: string): LagDevice | null;
}

/**
 * Why a channel member is not in its bundle. `why` is a string here rather than `string | null`
 * because `negotiationVerdict()` is a discriminated union: every path that produces a suspension has
 * a sentence for it, and the type says so instead of leaving the caller to check.
 */
interface MemberSuspension {
  readonly why: string;
  readonly mode: string;
  readonly peerMode: string | null;
  readonly peer: PortPeer;
}

/**
 * The answer to "do these two modes negotiate?", as a union rather than a boolean plus a maybe-string:
 * a bundled pair has no reason to give, and a pair that does not bundle always has one.
 */
type NegotiationVerdict =
  | { readonly bundled: true; readonly why: null }
  | { readonly bundled: false; readonly why: string };

/** What decides whether a member is operationally usable right now. */
type CanCarry = (name: string) => boolean;

/** The options `selectMember()` takes fourth. */
interface SelectOptions {
  readonly canCarry?: CanCarry | null;
}

// Port order, not string order: an active link is chosen by port number, and `Fa0/10` is not before `Fa0/2`.
const ifaceName: { comparePortNames(a: string, b: string): number } = require('./iface-name');

/**
 * An object as a bag of `unknown`s: the guard that lets a document-shaped value be read without an
 * assertion. Everything below narrows a field with `typeof` before using it.
 */
function isObject(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null;
}

/** A member list, or an empty one. The annotation is what stops `Array.isArray` widening it to anything. */
function memberList(members: unknown): readonly unknown[] {
  return Array.isArray(members) ? members : [];
}

/**
 * The mode a channel group reports.
 *
 * `Device.lagFor()` is JavaScript, so the value is `unknown`; this reads its `mode` and stringifies it
 * the way `canonicalMode()` always did, so a group with no mode behaves exactly as it did before
 * (empty -> the default), instead of becoming a new refusal this module has no business inventing.
 */
function groupMode(group: unknown): string {
  if (!isObject(group)) return '';
  const mode: unknown = group.mode;
  return (mode === null || mode === undefined) ? '' : String(mode);
}

const LAG_MODES: readonly string[] = ['lacp-active', 'lacp-passive', 'static'];

// Two vocabularies for one fact. The console says `channel-group 1 mode active|passive|on`, the way IOS does;
// the model says `lacp-active|lacp-passive|static`, the way the rest of the engine reads it. They were never
// translated, so every correct `channel-group` line stored the console's word and then validated it against
// the model's list:
//
//   Interface Fa0/1 added to channel group 1 (mode active)
//   % Warning: LAG lag1: unknown mode "active" (expected one of lacp-active, lacp-passive, static).
//
// - a warning on every correct command, and the mode left as a string nothing downstream recognised.
// One table, both directions, so the two cannot drift apart again.
const MODE_ALIASES: Readonly<Record<string, string>> = {
  active: 'lacp-active',
  'lacp-active': 'lacp-active',
  passive: 'lacp-passive',
  'lacp-passive': 'lacp-passive',
  on: 'static',
  static: 'static'
};

// What the operator typed (or a saved lab holds) -> what the model stores.
function canonicalMode(mode: unknown): string {
  const raw = String(mode == null ? '' : mode).trim().toLowerCase();
  if (!raw) return DEFAULT_MODE;
  return MODE_ALIASES[raw] || raw;    // unknown words survive, so validation can name them
}

// What the model stores -> what the console prints.
function cliMode(mode: unknown): string {
  const canonical = canonicalMode(mode);
  if (canonical === 'lacp-active') return 'active';
  if (canonical === 'lacp-passive') return 'passive';
  if (canonical === 'static') return 'on';
  return canonical;
}

// The name a box prints for a bundle, in every view that names one: `Po1` in the Port-channel cell of
// `show etherchannel summary` and in the `Ports` column of `show mac address-table`. One function, so a table
// and a summary cannot call the same bundle two different things.
function portChannelName(id: string | number): string {
  return 'Po' + id;
}

// The same bundle spelled out, for the views where the interface name is the subject of the row rather than a
// cell in a table - `show ip interface brief` prints `Port-channel1` where the MAC table prints `Po1`. Both name
// one object, and one library names it, so the long and the short form cannot disagree about which bundle it is.
function portChannelIfaceName(id: string | number): string {
  return 'Port-channel' + id;
}

// The line a box prints on the command that *builds* the bundle - `Creating a port-channel interface
// Port-channel 1` - and on no other command.
//
// The vendor inserts a space between the type and the number here, and nowhere else: the interface this line
// names is spelled `Port-channel1` in `show ip interface brief`, in a syslog line and in `show running-config`.
// So the sentence is not `portChannelIfaceName()` with a prefix in front of it, and it is built here rather
// than in the console, so the one place that knows how a bundle is named also knows the one sentence whose
// spacing disagrees with it (research/channel-group-creating-receipt.md).
function createReceipt(id: string | number): string {
  return 'Creating a port-channel interface Port-channel ' + id;
}

// The inverse of the two above: a bundle's id, read back from a name an operator typed.
//
// A box accepts every spelling of its own interface name - `show interfaces port-channel 1`, and the short
// form its own tables print (`Po1`) - so the console has to recognise them before it can decide whether it
// has anything to say about one. Returns null for anything that is not a bundle name, so a caller can tell
// "not a bundle" from bundle 1.
function bundleIdFromName(typed: unknown): number | null {
  const m = /^(?:po|port-?channel)\s*(\d+)$/i.exec(String(typed == null ? '' : typed).trim());
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const HASH_POLICIES: readonly string[] = ['l2', 'l3', 'l3l4'];

const DEFAULT_LAG_ID: string = 'lag1';
const DEFAULT_MODE: string = 'lacp-active';
const DEFAULT_HASH_POLICY: string = 'l3l4';
const DEFAULT_MIN_LINKS: number = 2;

// How many links one bundle can carry, and how many members a group can hold.
//
// One number, stated the same way by every Catalyst chapter that documents EtherChannels: "Each EtherChannel
// can consist of up to eight compatibly configured Ethernet ports ... For a PAgP EtherChannel, you can
// configure up to eight ports of the same type and speed for the same group. For a LACP EtherChannel, you can
// configure up to 16 Ethernet ports of the same type. Up to eight ports can be active, and up to eight ports
// can be in standby mode" (Cisco, *Configuring EtherChannels*, Catalyst 2960-X 15.2E).
//
// The console modelled neither: a bundle took as many members as the operator typed, every one of them was
// `(P)`, and the data plane hashed frames across all of them, so a ten-member "bundle" carried ten links'
// worth of traffic - a switch no vendor sells. The `H - Hot-standby (LACP only)` line in the key above
// `show etherchannel summary` was unreachable for the same reason (research/etherchannel-member-limit.md).
const MAX_ACTIVE_LINKS: number = 8;
const MAX_MEMBERS_LACP: number = 16;
const MAX_MEMBERS_STATIC: number = 8;

// The member cap depends on whether the bundle negotiates: LACP may hold 16 members because 8 of them can sit
// in hot-standby; a non-negotiating (`on`) group has nowhere to park a ninth, so it takes eight.
function maxMembers(mode: unknown): number {
  const canonical = canonicalMode(mode);
  return canonical.indexOf('lacp') === 0 ? MAX_MEMBERS_LACP : MAX_MEMBERS_STATIC;
}

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

// Normalise a (possibly partial) LAG config into the canonical shape.
//
// `mode` and `hashPolicy` keep the caller's raw string when it is not a known
// value, so validateLag() can report E_LAG_BAD_MODE instead of silently
// "fixing" a typo. `members` keeps duplicates on purpose for the same reason;
// de-duplication is a validation error, not a normalisation step.
function normalizeLag(cfg: unknown): LagConfig {
  const c: Readonly<Record<string, unknown>> = isObject(cfg) ? cfg : {};

  const rawId: unknown = c.id;
  const id: string = (typeof rawId === 'string' && rawId.trim()) ? rawId.trim() : DEFAULT_LAG_ID;

  // Canonicalised on the way in, so a lab saved by an older build (holding "active") normalises to the same
  // state as one configured today.
  const mode: string = canonicalMode(c.mode);

  const rawPolicy: unknown = c.hashPolicy;
  const hashPolicy: string = (typeof rawPolicy === 'string' && rawPolicy.trim())
    ? rawPolicy.trim().toLowerCase()
    : DEFAULT_HASH_POLICY;

  const members: string[] = [];
  const rawMembers: readonly unknown[] = memberList(c.members);
  for (const m of rawMembers) {
    let name: string = '';
    if (typeof m === 'string') name = m.trim();
    else if (isObject(m) && typeof m.name === 'string') name = m.name.trim();
    if (name) members.push(name);
  }

  let minLinks: number = Number(c.minLinks);
  if (!Number.isFinite(minLinks) || minLinks < 1) minLinks = DEFAULT_MIN_LINKS;
  minLinks = Math.floor(minLinks);

  return { id: id, mode: mode, hashPolicy: hashPolicy, members: members, minLinks: minLinks };
}

// ---------------------------------------------------------------------------
// tuple normalisation (format-insensitive, so "AA-BB-.." == "aabb.ccdd.eeff")
// ---------------------------------------------------------------------------

// MAC -> lowercase hex only (aa:bb:cc:dd:ee:ff, aabb.ccdd.eeff and
// AABBCCDDEEFF all collapse to the same string).
function normalizeMac(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).toLowerCase().replace(/[^0-9a-f]/g, '');
}

// IP -> lowercase hex digits only. This keeps every digit of an IPv4 address
// and, additionally, the hex letters of an IPv6 address.
function normalizeIp(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).toLowerCase().replace(/[^0-9a-f]/g, '');
}

// L4 port -> canonical decimal string (so 80, '80' and ' 080 ' agree).
function normalizePort(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const m = String(v).match(/[0-9]+/);
  if (m) return String(parseInt(m[0], 10));
  return String(v).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// hashing
// ---------------------------------------------------------------------------

// FNV-1a, 32 bit, over the UTF-16 code units of the tuple string.
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Build the exact byte tuple a policy hashes over.
//   l2    -> srcMac + dstMac
//   l3    -> srcIp  + dstIp
//   l3l4  -> srcIp  + dstIp + srcPort + dstPort
// Missing fields hash as the empty string, which is deliberate: a frame with
// no L3 header still has to land somewhere.
function hashTuple(frame: unknown, policy: string): string {
  const f: Readonly<Record<string, unknown>> = isObject(frame) ? frame : {};
  switch (policy) {
    case 'l2':
      return ['l2', normalizeMac(f.srcMac), normalizeMac(f.dstMac)].join('\u0001');
    case 'l3':
      return ['l3', normalizeIp(f.srcIp), normalizeIp(f.dstIp)].join('\u0001');
    case 'l3l4':
    default:
      return [
        'l3l4',
        normalizeIp(f.srcIp),
        normalizeIp(f.dstIp),
        normalizePort(f.srcPort),
        normalizePort(f.dstPort)
      ].join('\u0001');
  }
}

// Hash a frame to a float in [0, 1). Deterministic for a given frame+policy.
function hashFrame(frame: unknown, policy: unknown): number {
  let p: string = (typeof policy === 'string' && policy.trim()) ? policy.trim().toLowerCase() : DEFAULT_HASH_POLICY;
  if (HASH_POLICIES.indexOf(p) === -1) p = DEFAULT_HASH_POLICY;
  const h = fnv1a(hashTuple(frame, p));
  // 2^32 = 4294967296; h <= 4294967295 so the result is strictly < 1.
  return h / 4294967296;
}

// ---------------------------------------------------------------------------
// member selection
// ---------------------------------------------------------------------------

// A member may be a bare name or a { name, enabled } record.
function memberName(m: unknown): string {
  if (typeof m === 'string') return m.trim();
  if (isObject(m) && typeof m.name === 'string') return m.name.trim();
  return '';
}

function memberEnabled(m: unknown): boolean {
  if (isObject(m) && m.enabled === false) return false;
  return true;
}

// Pick the bundle member that carries a frame.
//
// Only enabled members are eligible, they are sorted by name first (so the
// result does not depend on the order the config happened to list them in),
// and the index is floor(hash * n). Returns null when nothing is eligible.
//
// `opts.canCarry` decides whether a member is *operationally* usable - its cable is in, its link is up, the
// far port is up. It is a predicate rather than a flag so this module stays free of topology: the caller
// already knows how to answer, and every caller must get the same answer. Without it a bundle whose member
// had been unplugged still hashed a share of the traffic onto that dead member and dropped it, while a
// perfectly good member sat idle (#1263).
function selectMember(members: unknown, frame: unknown, policy: unknown, opts?: SelectOptions | null): string | null {
  const o: SelectOptions = opts || {};
  const canCarry: CanCarry | null = (typeof o.canCarry === 'function') ? o.canCarry : null;
  const eligible = eligibleMembers(members, canCarry);
  if (eligible.length === 0) return null;

  const h = hashFrame(frame, policy);
  let idx = Math.floor(h * eligible.length);
  if (idx < 0) idx = 0;
  if (idx >= eligible.length) idx = eligible.length - 1;
  return eligible[idx];
}

// Every member that could carry a frame right now, in PORT order.
//
// Port order, not string order, because that is the tie-break the hardware uses to decide which links are in
// the bundle: "If you configure more than eight links for an EtherChannel group, the software automatically
// decides which of the hot-standby ports to make active based on the LACP priority ... The hot-standby ports
// that have lower port numbers become active in the channel first" (Cisco, Configuring EtherChannels). With
// one system priority and the default port priority on every port, that reduces to port number.
function carryingMembers(members: unknown, canCarry?: CanCarry | null): string[] {
  const list: readonly unknown[] = memberList(members);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of list) {
    if (!memberEnabled(m)) continue;
    const name = memberName(m);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (canCarry && !canCarry(name)) continue;
    out.push(name);
  }
  return out.sort(ifaceName.comparePortNames);
}

// The members that are IN the channel: at most eight, the lowest-numbered ones that can carry.
function activeMembers(members: unknown, canCarry?: CanCarry | null): string[] {
  return carryingMembers(members, canCarry).slice(0, MAX_ACTIVE_LINKS);
}

// The members that can carry but are not in the channel because eight already are - LACP's hot-standby list.
function standbyMembers(members: unknown, canCarry?: CanCarry | null): string[] {
  return carryingMembers(members, canCarry).slice(MAX_ACTIVE_LINKS);
}

// Which members of a bundle could carry a frame right now, in the order the selection rule uses.
// Exported so the CLI's `show etherchannel` and the data plane cannot hold two opinions about a bundle.
//
// The order here is the hash's, not the panel's (it sorts by name, so it is stable whatever order the config
// listed the members in); the SET is the active eight, so a frame can never be hashed onto a hot-standby link.
function eligibleMembers(members: unknown, canCarry?: CanCarry | null): string[] {
  const list: readonly unknown[] = memberList(members);
  const active = new Set<string>(activeMembers(list, canCarry));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of list) {
    if (!memberEnabled(m)) continue;
    const name = memberName(m);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (!active.has(name)) continue;
    out.push(name);
  }
  return out.sort(function (a, b) { return a < b ? -1 : (a > b ? 1 : 0); });
}

// Does this member's mode negotiate with the mode at the far end of its cable?
//
// One rule, because it is the one the vendor states in as many words: "A port in the passive mode cannot form
// an EtherChannel with another port that is also in the passive mode because neither port starts LACP
// negotiation" (Cisco, Configuring EtherChannels, LACP modes). A passive port answers LACP and never starts
// it, so two passive ends wait for a partner neither of them sends:
//
//   active  + active   -> bundle
//   active  + passive  -> bundle
//   passive + passive  -> no bundle
//   on      + on       -> bundle (no protocol at all)
//
// `on` against a negotiating end is deliberately NOT decided here: the real pair is asymmetric - the `on` side
// shows a bundle while the LACP side suspends, and the two ends disagree about the same cable - and this model
// has one opinion per member, not one per end. research/lacp-passive-both-ends.md names that as unresolved.
function negotiationVerdict(myMode: unknown, peerMode: unknown): NegotiationVerdict {
  const mine = canonicalMode(myMode);
  const theirs = canonicalMode(peerMode);
  if (mine === 'lacp-passive' && theirs === 'lacp-passive') {
    return { bundled: false, why: 'both ends are passive: neither starts LACP' };
  }
  return { bundled: true, why: null };
}

// A member that never negotiated is not in the bundle - but it is not dead either. The vendor's own sentence:
// "Incompatible ports are put into an independent state and continue to carry data traffic as would any other
// single link. The port configuration does not change, but the port does not participate in the EtherChannel"
// (Cisco, Configuring EtherChannels). So the port leaves the bundle without dying: it forwards as itself, and
// `show etherchannel summary` marks it `(I)` stand-alone - the letter the key printed above the table gives to
// a port that is "operating independently", and not `(s)`, which the key gives to a suspended one.
//
// Three ways to lose the negotiation, all one outcome:
//
//   1. both ends passive          - neither starts LACP (negotiationVerdict);
//   2. a far port in no group     - nothing at the far end answers LACP at all;
//   3. a far port that cannot     - a PC, a router port, anything with no channel group to answer with.
//
// (2) and (3) are the same fact from this side of the cable: an LACP speaker needs an LACP partner, and a port
// that never configured a channel group never sends or answers an LACPDU. The vendor states the pair rule -
// "you must configure both ends in the same mode ... the other end must also be configured in the on mode;
// otherwise, packet loss can occur" - and the 2960 chapter states what a port does when the negotiation comes
// back empty: since 12.2(35)SE it is put into an independent state and goes on carrying traffic as any other
// single link (research/lacp-one-sided-group.md). Before this, a group configured at one end alone came up as a
// bundle and hashed frames across members that, on the wire, were two unrelated single links.
//
// `on` is deliberately NOT covered: it negotiates nothing, so there is no response to wait for and the vendor
// says the switch *forces* the bundle up (`show etherchannel summary` on that side really does read SU/P) while
// the far end treats its port as a plain access port - the asymmetry research/lacp-passive-both-ends.md names.
function memberSuspension(
  dev: LagDevice | null | undefined,
  ifaceName: string,
  topo: LagTopology | null | undefined
): MemberSuspension | null {
  if (!dev || !topo || typeof dev.lagFor !== 'function') return null;
  const iface: MemberIface | null | undefined = dev.interfaces ? dev.interfaces.get(ifaceName) : null;
  if (!iface || !iface.peer) return null;
  const mine: unknown = dev.lagFor(ifaceName);
  if (!mine) return null;
  const peerDev: LagDevice | null = typeof topo.getDevice === 'function' ? topo.getDevice(iface.peer.deviceId) : null;
  const theirs: unknown = (peerDev && typeof peerDev.lagFor === 'function') ? peerDev.lagFor(iface.peer.iface) : null;
  // The mode of each end, read off a value this module cannot type (a `Device` is still JavaScript). A group
  // with no mode reads as empty, which is what `canonicalMode()` already made of it: the default, not a refusal.
  const mineMode: string = groupMode(mine);
  if (!theirs) {
    // No channel group on the far port: nothing over there speaks LACP, whatever this end says. A static
    // (`on`) member is left alone - it never asked a question, so it cannot go unanswered.
    const canonical = canonicalMode(mineMode);
    if (canonical !== 'lacp-active' && canonical !== 'lacp-passive') return null;
    return { why: 'the far end is in no channel group: nothing there answers LACP',
      mode: mineMode, peerMode: null, peer: iface.peer };
  }
  const peerMode: string = groupMode(theirs);
  const verdict = negotiationVerdict(mineMode, peerMode);
  if (verdict.bundled) return null;
  return { why: verdict.why, mode: mineMode, peerMode: peerMode, peer: iface.peer };
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function splitMemberPorts(memberPorts: unknown): Map<string, MemberPort> {
  const byName = new Map<string, MemberPort>();
  const list: readonly unknown[] = memberList(memberPorts);
  for (const p of list) {
    if (isObject(p) && typeof p.name === 'string' && p.name.trim()) byName.set(p.name.trim(), p);
  }
  return byName;
}

function uniqueMembers(members: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

// Validate a LAG definition against the physical ports it bundles.
//   memberPorts = [{ name, speedMbps, duplex, vlanCompatible, enabled }]
// Returns { ok, errors: [{code,message}], warnings: [{code,message}] }.
function validateLag(lag: unknown, memberPorts: unknown): LagVerdict {
  const cfg: LagConfig = normalizeLag(lag);
  const ports: Map<string, MemberPort> = splitMemberPorts(memberPorts);
  const errors: LagProblem[] = [];
  const warnings: LagProblem[] = [];

  function err(code: string, message: string): void { errors.push({ code: code, message: message }); }
  function warn(code: string, message: string): void { warnings.push({ code: code, message: message }); }

  // --- mode ---------------------------------------------------------------
  if (LAG_MODES.indexOf(cfg.mode) === -1) {
    err('E_LAG_BAD_MODE',
      'LAG ' + cfg.id + ': unknown mode "' + cfg.mode + '" (expected one of ' +
      LAG_MODES.join(', ') + ').');
  }

  // --- member count -------------------------------------------------------
  if (cfg.members.length < 2) {
    err('E_LAG_TOO_FEW',
      'LAG ' + cfg.id + ': needs at least 2 member ports, has ' + cfg.members.length + '.');
  }

  // --- duplicates ---------------------------------------------------------
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const m of cfg.members) {
    if (seen.has(m)) {
      if (dupes.indexOf(m) === -1) dupes.push(m);
    } else {
      seen.add(m);
    }
  }
  for (const m of dupes) {
    err('E_LAG_DUPLICATE_MEMBER', 'LAG ' + cfg.id + ': member port ' + m + ' is listed more than once.');
  }

  // --- per-port properties (only for members we have a port record for) ----
  const names: string[] = uniqueMembers(cfg.members);
  const known: KnownMember[] = [];
  for (const name of names) {
    const p: MemberPort | undefined = ports.get(name);
    if (p) known.push({ name: name, port: p });
  }

  const speeds: number[] = [];
  for (const k of known) {
    const s = Number(k.port.speedMbps);
    if (Number.isFinite(s) && s > 0 && speeds.indexOf(s) === -1) speeds.push(s);
  }
  if (speeds.length > 1) {
    speeds.sort(function (a, b) { return a - b; });
    err('E_LAG_SPEED_MISMATCH',
      'LAG ' + cfg.id + ': member speeds differ (' + speeds.join('/') + ' Mbps); ' +
      'all members must run at the same link speed.');
  }

  const duplexes: string[] = [];
  for (const k of known) {
    const d = k.port.duplex;
    if (typeof d === 'string' && d.trim() && duplexes.indexOf(d.trim().toLowerCase()) === -1) {
      duplexes.push(d.trim().toLowerCase());
    }
  }
  if (duplexes.length > 1) {
    // Sorted like the rates above: one bundle must not be described two ways depending on which member was
    // typed first.
    duplexes.sort();
    err('E_LAG_DUPLEX_MISMATCH',
      'LAG ' + cfg.id + ': member duplex settings differ (' + duplexes.join('/') + '); ' +
      'all members must agree on duplex.');
  }

  const vlanBad: string[] = [];
  for (const k of known) {
    if (k.port.vlanCompatible === false) vlanBad.push(k.name);
  }
  if (vlanBad.length) {
    err('E_LAG_VLAN_MISMATCH',
      'LAG ' + cfg.id + ': member(s) ' + vlanBad.join(', ') +
      ' are not VLAN-compatible; every member must be in the same VLAN set.');
  }

  for (const k of known) {
    if (k.port.enabled === false) {
      warn('W_LAG_DISABLED_MEMBER',
        'LAG ' + cfg.id + ': member ' + k.name + ' is administratively down and carries no traffic.');
    }
  }

  return { ok: errors.length === 0, errors: errors, warnings: warnings };
}

// The shapes, as types a converted caller can annotate its `require()` with rather than restating them. A
// type-only export is erased by the strip-types runtime, so nothing is added to `module.exports` below - the
// value this module has is still that one object, exactly as it was when the file was JavaScript.
export type {
  LagConfig,
  LagProblem,
  LagVerdict,
  MemberPort,
  PortPeer,
  LagDevice,
  LagTopology,
  MemberSuspension,
  NegotiationVerdict,
  CanCarry,
  SelectOptions
};

module.exports = {
  MAX_ACTIVE_LINKS,
  MAX_MEMBERS_LACP,
  MAX_MEMBERS_STATIC,
  maxMembers,
  LAG_MODES,
  MODE_ALIASES,
  canonicalMode,
  cliMode,
  portChannelName,
  portChannelIfaceName,
  createReceipt,
  bundleIdFromName,
  HASH_POLICIES,
  normalizeLag,
  hashFrame,
  selectMember,
  carryingMembers,
  activeMembers,
  standbyMembers,
  eligibleMembers,
  negotiationVerdict,
  memberSuspension,
  validateLag
};
