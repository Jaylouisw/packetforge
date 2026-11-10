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
 */

// The VLAN a frame leaving this port would be tagged with, as one comparable key.
function vlanKey(iface) {
  const v = iface && iface.vlan;
  if (!v) return 'default';
  if (v.mode === 'trunk') {
    const allowed = String(v.allowedVlans === undefined ? 'all' : v.allowedVlans).trim();
    return 'trunk:' + allowed;
  }
  return 'access:' + (v.accessVlan === undefined || v.accessVlan === null ? 1 : v.accessVlan);
}

// Two ports are in the same broadcast domain if an untagged frame on one could appear on the other
// as far as this model is concerned. Trunks match trunks with the same allowed list, and an access
// port matches a trunk that allows its VLAN.
function sameDomain(a, b) {
  const ka = vlanKey(a), kb = vlanKey(b);
  if (ka === kb) return true;
  function allows(trunkKey, accessKey) {
    if (trunkKey.indexOf('trunk:') !== 0 || accessKey.indexOf('access:') !== 0) return false;
    const list = trunkKey.slice('trunk:'.length);
    const vid = Number(accessKey.slice('access:'.length));
    if (list === 'all') return true;
    return list.split(',').some(function (part) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
      if (!m) return false;
      const lo = Number(m[1]), hi = m[2] === undefined ? lo : Number(m[2]);
      return vid >= lo && vid <= hi;
    });
  }
  return allows(ka, kb) || allows(kb, ka);
}

// Is this port passing traffic right now?
function portLive(dev, iface, topo) {
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
    const logical = (dev.lagFor && dev.lagFor(iface.name)) ? ('lag-' + dev.lagFor(iface.name).id) : iface.name;
    const st = dev.stp.states[logical];
    if (st && st !== 'forwarding') return false;      // Listening/Learning drop everything
  }
  return true;
}

/**
 * segmentOf(topo, dev, ifaceName) -> [{ device, iface, via }]
 *
 * Every L3 endpoint reachable from (dev, iface) without crossing a router. The starting device is
 * included, so a client that is its own server (a lab misconfiguration worth being able to see) is
 * visible to the caller.
 */
// Does this switch port carry a frame tagged with this VLAN id? An access port does not: a tagged
// frame arriving on one is not delivered, which is the same rule `sameDomain` applies to untagged
// frames from the other side.
function portCarriesTag(iface, vid) {
  const v = iface && iface.vlan;
  if (!v || v.mode !== 'trunk') return false;
  const allowed = String(v.allowedVlans === undefined ? 'all' : v.allowedVlans).trim();
  if (allowed === 'all' || allowed === '') return true;
  return allowed.split(',').some(function (part) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) return false;
    const lo = Number(m[1]), hi = m[2] === undefined ? lo : Number(m[2]);
    return vid >= lo && vid <= hi;
  });
}

function segmentOf(topo, dev, ifaceName, opts) {
  const start = dev.interfaces.get(ifaceName);
  if (!start) return [];
  // A port that is administratively down sends nothing, and neither does a subinterface whose parent
  // is down - the walk used to start from it anyway, which is how a shut port still produced an
  // adjacency from the far end.
  if (start.enabled === false) return [];
  // `opts.vid` walks for a *tagged* frame - the one a router subinterface sends - instead of an
  // untagged one. Without it a subinterface had no segment at all: it has no peer of its own, only a
  // parent, so `segmentOf` returned nothing and two router-on-a-stick speakers never became
  // neighbours however well the trunks were configured.
  const vid = (opts && opts.vid !== undefined && opts.vid !== null) ? Number(opts.vid) : null;
  const crosses = function (a, b) {
    if (vid === null) return sameDomain(a, b);
    // A tagged frame crosses when every switch port it touches carries the tag. A port with no VLAN
    // config is an L3 endpoint (a router's own port, a host's NIC) and is the destination, not a
    // check.
    for (const port of [a, b]) {
      if (!port || !port.vlan) continue;
      if (!portCarriesTag(port, vid)) return false;
    }
    return true;
  };
  const seen = new Set();
  const endpoints = [];
  const queue = [{ device: dev, iface: start }];
  seen.add(dev.id + '/' + ifaceName);

  while (queue.length) {
    const at = queue.shift();
    const next = at.iface.peer;
    if (!next) continue;
    const peerDev = topo.getDevice(next.deviceId);
    if (!peerDev) continue;
    const peerIface = peerDev.interfaces.get(next.iface);
    if (!peerIface || peerIface.enabled === false) continue;
    if (!crosses(at.iface, peerIface)) continue;

    const id = peerDev.id + '/' + peerIface.name;
    if (seen.has(id)) continue;
    seen.add(id);

    // The link being crossed has to be up.
    let crossedUp = true;
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
        if (!crosses(peerIface, out)) continue;
        if (!portLive(peerDev, out, topo)) continue;
        queue.push({ device: peerDev, iface: out });
      }
    }
  }

  return endpoints;
}

module.exports = { segmentOf: segmentOf, sameDomain: sameDomain, portLive: portLive,
  vlanKey: vlanKey, portCarriesTag: portCarriesTag };
