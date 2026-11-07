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

function networkOf(ip, mask) { return (ipToInt(ip) & maskToInt(mask)) >>> 0; }
function broadcastOf(ip, mask) { return (networkOf(ip, mask) | (~maskToInt(mask) >>> 0)) >>> 0; }
function sameSubnet(a, b, mask) { return networkOf(a, mask) === networkOf(b, mask); }
function ipInSubnet(ip, net, mask) { return networkOf(ip, mask) === networkOf(net, mask); }

function isIp(s) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(String(s).trim());
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
const ICMP_ECHO_REQUEST = 8;
const ICMP_ECHO_REPLY = 0;

module.exports = {
  BROADCAST_MAC, ZERO_MAC,
  ipToInt, intToIp, maskToInt, prefixOf, networkOf, broadcastOf,
  sameSubnet, ipInSubnet, isIp,
  macToInt, intToMac, isBroadcastMac, isMulticastMac, normalizeMac,
  ETH_ARP, ETH_IPV4, ICMP_ECHO_REQUEST, ICMP_ECHO_REPLY
};
