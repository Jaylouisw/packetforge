'use strict';
// ping-and-trace-report.test.js - the report reads top to bottom.
//
//   R1#ping 10.9.0.50
//   !!!!
//   Success rate is 100 percent (4/4)
//   Reply from 10.9.0.50: bytes=100 time=0.103 ms
//   Reply from 10.9.0.50: bytes=100 time=0.103 ms
//
// The summary sat in the middle of the replies it summarises, and carried no round-trip figures. And a
// failed trace printed `*` beside a time with no legend, because the legend was emitted only on a trace
// that arrived - the case where the reader has least to go on.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function text(out) { return out && out.output ? out.output.join('\n') : String(out); }
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const find = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

function lab() {
  const t = new Topology();
  const r1 = t.addDevice(find('generic-router')); r1.name = 'R1';
  const r2 = t.addDevice(find('generic-router')); r2.name = 'R2';
  const pc = t.addDevice(find('generic-pc')); pc.name = 'PC1';
  t.connect(r1.id, 'Gi0/0', r2.id, 'Gi0/0');
  t.connect(r2.id, 'Gi0/1', pc.id, Array.from(pc.interfaces.values())[0].name);
  const sim = new Simulator(t);
  const s1 = new CliSession(r1, t, sim);
  s1.run('enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface Gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown',
    'ipv6 address 2001:db8::1/64', 'exit',
    'ip route 10.9.0.0 255.255.255.0 10.0.0.2', 'ipv6 route 2001:db8:9::/64 2001:db8::2', 'end');
  const s2 = new CliSession(r2, t, sim);
  s2.run('enable', 'configure terminal',
    'interface Gi0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown',
    'ipv6 address 2001:db8::2/64', 'exit',
    'interface Gi0/1', 'ip address 10.9.0.1 255.255.255.0', 'no shutdown',
    'ipv6 address 2001:db8:9::1/64', 'exit',
    'ipv6 unicast-routing', 'end');
  const sp = new CliSession(pc, t, sim);
  sp.run('enable', 'configure terminal', 'interface eth0', 'ip address 10.9.0.50 255.255.255.0',
    'ip default-gateway 10.9.0.1', 'ipv6 address 2001:db8:9::50/64', 'ipv6 gateway 2001:db8:9::1', 'end');
  return { t: t, sim: sim, r1: r1, r2: r2, pc: pc, s1: s1, s2: s2, sp: sp };
}

console.log('The ping report ends with its summary:');
{
  const env = lab();
  const lines = text(env.s1.run('ping 10.9.0.50')).split('\n').filter(function (l) { return l.trim(); });
  const at = lines.findIndex(function (l) { return /^Success rate is/.test(l); });
  ok(at !== -1, 'the summary is there');
  ok(at === lines.length - 1, 'and it is the last line ("' + lines[lines.length - 1].slice(0, 40) + '")');
  ok(/round-trip min\/avg\/max = [\d.]+\/[\d.]+\/[\d.]+ ms/.test(lines[at]),
    'and carries the round-trip figures IOS prints');
  ok(lines.filter(function (l) { return /^Reply from/.test(l); }).length === 4,
    'with the four replies above it');
  ok(/^!!!!$/.test(lines[2]), 'and the marks where they belong, under the header');
}

console.log('\nThe IPv6 report has the same shape:');
{
  const env = lab();
  const lines = text(env.s1.run('ping 2001:db8:9::50')).split('\n').filter(function (l) { return l.trim(); });
  const at = lines.findIndex(function (l) { return /^Success rate is/.test(l); });
  ok(at !== -1, 'the IPv6 summary is there');
  ok(at === lines.length - 1, 'and it is the last line too');
  ok(/round-trip min\/avg\/max/.test(lines[at]), 'with the same round-trip figures');
}

console.log('\nEvery mark a trace prints is explained:');
{
  const env = lab();
  const good = text(env.s1.run('traceroute 10.9.0.50'));
  ok(/Path: R1 -> R2 -> PC1/.test(good), 'a working trace names the path');
  ok(/\* \d+ links? had no cable length or line rate/.test(good), 'and explains the asterisk beside a time');
  const bad = text(env.s1.run('traceroute 172.16.0.1'));
  ok(/no reply/.test(bad), 'a trace that stops says so');
  ok(/no route to 172\.16\.0\.1/.test(bad), 'and gives the reason');
  ok(!/\d+ us\*|\d+\.\d+ us\*/.test(bad.split('\n').slice(0, 6).join('\n')) ||
    /\* \d+ links? had no cable length/.test(bad),
    'and a time marked with * in a failed trace is explained as well');
}

console.log('\nA trace that stops says where it stopped:');
{
  const env = lab();
  // R2 loses its route back, so the trace dies one hop past R1 with an answer already given.
  env.s1.run('configure terminal', 'no ip route 10.9.0.0 255.255.255.0 10.0.0.2', 'end');
  const body = text(env.s1.run('traceroute 10.9.0.50'));
  ok(/no route/i.test(body), 'the reason names the missing route');
  ok(!/Path:/.test(body), 'and no path is claimed');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
