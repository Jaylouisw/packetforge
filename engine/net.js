'use strict';
// net.js — pure IPv4 / MAC / subnet helpers. Zero dependencies.

const BROADCAST_MAC = 'ff:ff:ff:ff:ff:ff';
const ZERO_MAC = '00:00:00:00:00:00';

function ipToInt(ip) {
  const parts = String(ip).trim().split('.');
  if (parts.length !== 4) throw new Error('Invalid IPv4 address: ' + ip);
  let n = 0;
  for (const o of parts) {
    const v = parseInt(o, 10);
    if (isNaN(v) || v < 0 || v > 255) throw new Error('Invalid IPv4 address: ' + ip);
    n = (n * 256) + v;
  }
  return n >>> 0;
}

function intToIp(n) {
  n = n >>> 0;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function maskToInt(mask) {
  const s = String(mask).trim();
  if (/^\d{1,2}$/.test(s)) {
    const p = parseInt(s, 10);
    if (p < 0 || p > 32) throw new Error('Invalid prefix length: ' + mask);
    return p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
  }
  return ipToInt(s);
}

function prefixOf(mask) {
  const m = maskToInt(mask) >>> 0;
  let ones = 0;
  for (let i = 31; i >= 0; i--) {
    if (m & (1 << i)) ones++; else break;
  }
  return ones;
}

// The same question for a mask that is already an integer. Callers that work with mask ints (the DHCP
// pool validator, the OSPF interface cost) used to carry their own copy of this loop (#1249).
function prefixOfInt(m) {
  const v = (m >>> 0);
  let ones = 0;
  for (let i = 31; i >= 0; i--) {
    if (v & (1 << i)) ones++; else break;
  }
  return ones;
}

// A netmask has to be a run of ones followed by zeros. 255.0.255.0 is a valid IPv4 *address* and not a
// netmask: it has no prefix length, and every rule stated in terms of a prefix length (routing, DHCP
// ranges, OSPF areas) would be describing something other than what the device does. One predicate for
// that, because three modules used to answer it in three different ways (#1249).
function isContiguousMask(mask) {
  let m;
  if (typeof mask === 'number' && Number.isInteger(mask)) {
    // A bare integer is a prefix length when it can be one (0..32), and a mask int otherwise - callers
    // hold both, and a mask int like 4294967040 cannot be read as a dotted string.
    if (mask >= 0 && mask <= 32) return true;
    if (mask < 0 || mask > 0xffffffff) return false;
    m = mask >>> 0;
  } else {
    try { m = maskToInt(mask) >>> 0; } catch (e) { return false; }
  }
  const inv = (~m) >>> 0;
  return (((inv + 1) >>> 0) & inv) === 0;
}

// A prefix length as a dotted mask, so state has one spelling. Without this a port configured with
// `ip address 10.0.0.1 24` kept the string "24", and the front panel - which reads a dotted mask -
// showed /2 for it.
function maskFromPrefix(bits) {
  const p = Number(bits);
  if (!Number.isInteger(p) || p < 0 || p > 32) throw new Error('Invalid prefix length: ' + bits);
  return intToIp(p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0);
}

function networkOf(ip, mask) { return (ipToInt(ip) & maskToInt(mask)) >>> 0; }
function broadcastOf(ip, mask) { return (networkOf(ip, mask) | (~maskToInt(mask) >>> 0)) >>> 0; }
function sameSubnet(a, b, mask) { return networkOf(a, mask) === networkOf(b, mask); }
function ipInSubnet(ip, net, mask) { return networkOf(ip, mask) === networkOf(net, mask); }

// Is this an IPv4 address? Not "does it look like one" (#1411).
//
// This was a shape check - four dotted groups of one to three digits - so `300.1.1.1`, `10.0.0.999` and
// `1.2.3.9999` were addresses as far as every caller was concerned. `ipToInt()` has always asked the real
// question (it throws on an octet above 255), and the console's `ping` learned this the hard way in #1379 and
// brought its own private strict helper rather than fix the predicate. Eight doors then accepted an address that
// cannot exist and stored it: `ip name-server`, `ip route` (destination and next hop), `ip default-gateway`, the
// DHCP pool's `dns-server`/`default-router`/`network`, the NAT pool ranges, a BGP neighbour and an OSPF router-id.
//
// One predicate, asked properly.
function isIp(s) {
  if (typeof s !== 'string' && typeof s !== 'number') return false;
  try { ipToInt(String(s).trim()); return true; } catch (e) { return false; }
}

function macToInt(mac) {
  const hex = String(mac).replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) throw new Error('Invalid MAC address: ' + mac);
  return parseInt(hex, 16); // 48-bit value is exact in an IEEE-754 double (<= 2^53)
}

function intToMac(n) {
  n = Math.floor(n);
  const out = [];
  for (let i = 5; i >= 0; i--) {
    const b = Math.floor(n / Math.pow(256, i)) % 256;
    out.push((b < 16 ? '0' : '') + b.toString(16));
  }
  return out.join(':');
}

function isBroadcastMac(mac) { return String(mac).toLowerCase() === BROADCAST_MAC; }
function isMulticastMac(mac) {
  const firstByte = Math.floor(macToInt(mac) / Math.pow(256, 5)) % 256;
  return (firstByte & 0x01) === 1;
}

function normalizeMac(mac) { return intToMac(macToInt(mac)); }

// --- Ethernet / IP / ICMP constants ---
const ETH_ARP = 'arp';
const ETH_IPV4 = 'ipv4';
const ETH_IPV6 = 'ipv6';
const ETH_ND = 'nd';          // ICMPv6 neighbour solicitation / advertisement
const ICMP_ECHO_REQUEST = 8;
// Error types. Until these existed the engine dropped an expired packet silently, so a
// traceroute could only ever show timeouts: the hop that killed the packet never said so.
const ICMP_DEST_UNREACH = 3;
const ICMP_TIME_EXCEEDED = 11;
const ICMP_ECHO_REPLY = 0;

module.exports = {
  BROADCAST_MAC, ZERO_MAC,
  ipToInt, intToIp, maskToInt, prefixOf, prefixOfInt, isContiguousMask, maskFromPrefix,
  networkOf, broadcastOf,
  sameSubnet, ipInSubnet, isIp,
  macToInt, intToMac, isBroadcastMac, isMulticastMac, normalizeMac,
  ETH_ARP, ETH_IPV4, ETH_IPV6, ETH_ND, ICMP_ECHO_REQUEST, ICMP_ECHO_REPLY,
  ICMP_DEST_UNREACH, ICMP_TIME_EXCEEDED
};
