'use strict';
/**
 * Where a DHCP exchange happens, as a graph walk rather than a packet flood.
 *
 * A DISCOVER is a broadcast: it goes everywhere in its broadcast domain and stops at anything that
 * routes. That is exactly a walk over the L2 topology, which is why this lives here as a walk and
 * not as frames in the queue - a DHCP exchange happens at run start, before the first packet the
 * user asked for, and making it a real flood would mean a run whose first 40 events nobody asked to
 * see.
 *
 * What the walk honours:
 *   - bridges (isL2) pass the frame on; routers, hosts and other L3 endpoints receive it and stop it
 *   - a spanning-tree blocked port passes nothing
 *   - a disabled port, or a port with no link, passes nothing
 *   - an access port is in the VLAN it belongs to, and the walk does not cross a VLAN boundary
 *
 * What it does not model: DHCP relay (a DISCOVER does not cross a router to reach a server on the
 * other side), DHCP snooping, and Option 82.
 *
 * TypeScript (docs/TYPESCRIPT.md). The types below describe the *engine shapes this walk reads*,
 * not the classes that happen to carry them: `engine/device.js` and `engine/topology.js` are still
 * JavaScript, so nothing is imported from them and nothing is inferred from them. Every one of
 * these interfaces is the smallest surface a function here actually touches, which is why
 * `sameDomain` takes a `VlanPort` and not a whole device interface - it compares VLAN blocks and
 * has no business knowing a port's name.
 *
 * A caller still requires this file by its extension: `require('./segment.ts')`. CommonJS does not
 * invent a `.ts` from an extensionless relative require (trap 5 in docs/TYPESCRIPT.md).
 */

// A `.ts` file with no top-level import is a *script* in the type system: its top-level names land
// in one global scope shared with every other such file. This empty, type-only import is erased by
// the strip-types runtime and is what marks the file as a module.
import type {} from 'fs';

/**
 * The 802.1Q block every `Interface` carries (engine/device.js). `mode` is 'access' or 'trunk' as
 * the class writes it, but it is declared `string` here on purpose: the field is untyped JavaScript,
 * and a union the source cannot prove is a claim the typechecker would then hold callers to.
 * `allowedVlans` is 'all' or a list of VLAN ids, and a list is stringified into the key below.
 */
interface VlanConfig {
  readonly mode: string;
  readonly accessVlan?: number | null;
  readonly nativeVlan?: number;
  readonly allowedVlans?: string | readonly number[];
}

/** Anything carrying a VLAN block. `sameDomain` compares two of these and reads nothing else. */
interface VlanPort {
  readonly vlan?: VlanConfig | null;
}

/** The far end of a cabled port, exactly as `Interface.peer` records it. */
interface PortPeer {
  readonly deviceId: string;
  readonly iface: string;
}

/** The port fields the walk reads (engine/device.js `Interface`). */
interface SegmentIface extends VlanPort {
  readonly name: string;
  readonly enabled?: boolean;
  readonly peer?: PortPeer | null;
}

/** The spanning-tree state the walk reads (engine/device.js `Device.stp`). */
interface StpState {
  readonly blocked?: ReadonlySet<string> | null;
  readonly states?: Readonly<Record<string, string>> | null;
}

/** The channel group a port belongs to, as `Device.lagFor()` returns it. */
interface LagGroup {
  readonly id: string;
}

/** The device fields the walk reads (engine/device.js `Device`). */
interface SegmentDevice {
  readonly id: string;
  readonly interfaces: ReadonlyMap<string, SegmentIface>;
  readonly stp?: StpState | null;
  lagFor?(ifaceName: string): LagGroup | null;
  isL2?(): boolean;
}

/** The cable fields the walk reads (engine/link.js `Link`). */
interface SegmentLink {
  readonly id: string;
  endpoint(deviceId: string, iface: string): PortPeer | null;
  isUp(): boolean;
}

/** The topology surface the walk needs (engine/topology.js `Topology`). */
interface SegmentTopology {
  readonly links: ReadonlyMap<string, SegmentLink>;
  getDevice(id: string): SegmentDevice | null;
}

/** One L3 endpoint the walk reached, and the port on the device it was asked to start from. */
interface SegmentEndpoint {
  readonly device: SegmentDevice;
  readonly iface: SegmentIface;
  readonly via: string;
}

/**
 * Why a channel member is not in its bundle, or null when it is (engine/lag.js
 * `memberSuspension`). That module is still JavaScript, so the shape this file reads is written
 * here rather than inferred from it - the return value is only ever tested for truthiness.
 */
interface MemberSuspension {
  readonly why: string;
}

const lag: {
  memberSuspension(dev: SegmentDevice, ifaceName: string, topo: SegmentTopology | null): MemberSuspension | null;
} = require('./lag');

// The VLAN a frame leaving this port would be tagged with, as one comparable key.
function vlanKey(iface: VlanPort | null | undefined): string {
  const v = iface && iface.vlan;
  if (!v) return 'default';
  if (v.mode === 'trunk') {
    const allowed: string = String(v.allowedVlans === undefined ? 'all' : v.allowedVlans).trim();
    return 'trunk:' + allowed;
  }
  return 'access:' + (v.accessVlan === undefined || v.accessVlan === null ? 1 : v.accessVlan);
}

// Two ports are in the same broadcast domain if an untagged frame on one could appear on the other
// as far as this model is concerned. Trunks match trunks with the same allowed list, and an access
// port matches a trunk that allows its VLAN.
function sameDomain(a: VlanPort, b: VlanPort): boolean {
  const ka: string = vlanKey(a), kb: string = vlanKey(b);
  if (ka === kb) return true;
  function allows(trunkKey: string, accessKey: string): boolean {
    if (trunkKey.indexOf('trunk:') !== 0 || accessKey.indexOf('access:') !== 0) return false;
    const list: string = trunkKey.slice('trunk:'.length);
    const vid: number = Number(accessKey.slice('access:'.length));
    if (list === 'all') return true;
    return list.split(',').some(function (part: string): boolean {
      const m: RegExpExecArray | null = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
      if (!m) return false;
      const lo: number = Number(m[1]), hi: number = m[2] === undefined ? lo : Number(m[2]);
      return vid >= lo && vid <= hi;
    });
  }
  return allows(ka, kb) || allows(kb, ka);
}

// Is this port passing traffic right now?
function portLive(dev: SegmentDevice, iface: SegmentIface | null | undefined, topo: SegmentTopology | null): boolean {
  if (!iface) return false;
  if (iface.enabled === false) return false;
  if (!iface.peer) return false;                     // unplugged
  // A cable that is down passes nothing, whatever the port says about itself.
  if (topo) {
    for (const l of topo.links.values()) {
      if (l.endpoint(dev.id, iface.name) && !l.isUp()) return false;
    }
  }
  if (dev.stp && dev.stp.blocked && dev.stp.blocked.has(iface.name)) return false;
  if (dev.stp && dev.stp.states) {
    // The same logical port the spanning tree grouped this member under - and a member whose two ends never
    // negotiated was never in the bundle, so it is its own port (engine/simulator.js `_logicalPortName`).
    const lagFor: LagGroup | null = (dev.lagFor && dev.lagFor(iface.name)) || null;
    const suspended: MemberSuspension | null = lagFor ? lag.memberSuspension(dev, iface.name, topo) : null;
    const logical: string = (lagFor && !suspended) ? ('lag-' + lagFor.id) : iface.name;
    const st: string | undefined = dev.stp.states[logical];
    if (st && st !== 'forwarding') return false;      // Listening/Learning drop everything
  }
  return true;
}

/** A walk position: a device, and the port the frame is leaving by. */
interface Hop {
  readonly device: SegmentDevice;
  readonly iface: SegmentIface;
}

/**
 * segmentOf(topo, dev, ifaceName) -> [{ device, iface, via }]
 *
 * Every L3 endpoint reachable from (dev, iface) without crossing a router. The starting device is
 * included, so a client that is its own server (a lab misconfiguration worth being able to see) is
 * visible to the caller.
 */
function segmentOf(topo: SegmentTopology, dev: SegmentDevice, ifaceName: string): SegmentEndpoint[] {
  const start: SegmentIface | undefined = dev.interfaces.get(ifaceName);
  if (!start) return [];
  const seen: Set<string> = new Set();
  const endpoints: SegmentEndpoint[] = [];
  const queue: Hop[] = [{ device: dev, iface: start }];
  seen.add(dev.id + '/' + ifaceName);

  while (queue.length) {
    const at: Hop | undefined = queue.shift();
    if (!at) break;                       // the loop condition rules this out; the type system cannot say so
    const next: PortPeer | null | undefined = at.iface.peer;
    if (!next) continue;
    const peerDev: SegmentDevice | null = topo.getDevice(next.deviceId);
    if (!peerDev) continue;
    const peerIface: SegmentIface | undefined = peerDev.interfaces.get(next.iface);
    if (!peerIface || peerIface.enabled === false) continue;
    if (!sameDomain(at.iface, peerIface)) continue;

    const id: string = peerDev.id + '/' + peerIface.name;
    if (seen.has(id)) continue;
    seen.add(id);

    // The link being crossed has to be up.
    let crossedUp: boolean = true;
    for (const l of topo.links.values()) {
      if (l.endpoint(at.device.id, at.iface.name) && !l.isUp()) { crossedUp = false; break; }
    }
    if (!crossedUp) continue;

    endpoints.push({ device: peerDev, iface: peerIface, via: at.iface.name });

    // A bridge passes the frame on to its other ports. Anything else receives it and stops it.
    if (peerDev.isL2 && peerDev.isL2()) {
      for (const out of peerDev.interfaces.values()) {
        if (out.name === peerIface.name) continue;
        if (!out.peer) continue;
        if (!sameDomain(peerIface, out)) continue;
        if (!portLive(peerDev, out, topo)) continue;
        queue.push({ device: peerDev, iface: out });
      }
    }
  }

  return endpoints;
}

module.exports = { segmentOf: segmentOf, sameDomain: sameDomain, portLive: portLive, vlanKey: vlanKey };
