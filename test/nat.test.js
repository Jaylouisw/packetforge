'use strict';
// nat.test.js -- unit tests for engine/nat.js.
// Plain assertions, no framework. Tables and packets are hand-built plain
// objects so the module is exercised in isolation: no simulator, no device,
// no topology.

const nat = require('../engine/nat');

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); } else { failed++; console.error('  \u2717 ' + msg); }
}

function codes(list) {
  return (list || []).map(function (e) { return e.code; });
}

function hasCode(list, code) {
  return codes(list).indexOf(code) !== -1;
}

function pkt(spec) {
  return Object.assign({
    srcIp: '192.168.1.10',
    dstIp: '203.0.113.9',
    srcPort: 52000,
    dstPort: 443,
    protocol: 'tcp'
  }, spec);
}

function patRule(extra) {
  return Object.assign({
    type: 'pat',
    insideLocal: '192.168.1.0/24',
    insideGlobal: '203.0.113.5',
    protocol: 'tcp'
  }, extra || {});
}

function tableWith() {
  const t = nat.createNatTable();
  for (const rule of Array.prototype.slice.call(arguments)) t.rules.push(nat.normalizeRule(rule));
  return t;
}

// ---------------------------------------------------------------------------
// 1. constants
// ---------------------------------------------------------------------------

ok(nat.NAT_TYPES.STATIC === 'static', 'NAT_TYPES.STATIC is the string "static"');
ok(nat.NAT_TYPES.DYNAMIC === 'dynamic', 'NAT_TYPES.DYNAMIC is the string "dynamic"');
ok(nat.NAT_TYPES.PAT === 'pat', 'NAT_TYPES.PAT is the string "pat"');
ok(Object.keys(nat.NAT_TYPES).length === 3, 'NAT_TYPES exposes exactly three flavours');

// ---------------------------------------------------------------------------
// 2. normalizeRule
// ---------------------------------------------------------------------------

const n1 = nat.normalizeRule({ insideLocal: '192.168.1.10', insideGlobal: '203.0.113.5' });
ok(n1.type === 'static', 'normalizeRule infers static from host-to-host');
ok(n1.protocol === 'any', 'normalizeRule defaults protocol to any');
ok(n1.port === null && n1.acl === null, 'normalizeRule defaults port and acl to null');
ok(n1.insideLocal === '192.168.1.10' && n1.insideGlobal === '203.0.113.5',
  'normalizeRule keeps both addresses');

const n2 = nat.normalizeRule({ type: 'PAT', insideLocal: '192.168.1.0/24', insideGlobal: '203.0.113.5' });
ok(n2.type === 'pat', 'normalizeRule lowercases a type given as "PAT"');
ok(nat.normalizeRule({ insideLocal: '192.168.1.0/24', insideGlobal: '203.0.113.5' }).type === 'pat',
  'normalizeRule infers pat when insideLocal is a subnet');
ok(nat.normalizeRule({ type: 'pat', insideGlobal: '203.0.113.5' }).insideLocal === 'any',
  'normalizeRule fills insideLocal "any" for an overload rule');
ok(nat.normalizeRule({ type: 'pat', insideGlobal: '203.0.113.5', protocol: 6 }).protocol === 'tcp',
  'normalizeRule maps the protocol number 6 to tcp');
ok(nat.normalizeRule({ type: 'pat', insideGlobal: '203.0.113.5', protocol: 'UDP ' }).protocol === 'udp',
  'normalizeRule trims and lowercases a protocol name');
ok(nat.normalizeRule({ type: 'pat', insideGlobal: '203.0.113.5', port: '8080' }).port === 8080,
  'normalizeRule coerces a numeric port string to a number');
ok(nat.normalizeRule({ type: 'pat', insideGlobal: ' 203.0.113.5 ' }).insideGlobal === '203.0.113.5',
  'normalizeRule trims surrounding whitespace on insideGlobal');
ok(nat.normalizeRule({ type: 'pat', insideGlobal: '203.0.113.5', acl: ' ACL_IN ' }).acl === 'ACL_IN',
  'normalizeRule trims an acl name');
const nAcl = nat.normalizeRule({ type: 'pat', insideGlobal: '203.0.113.5', acl: ['10.0.0.0/8', ' ', '10.9.9.9'] });
ok(Array.isArray(nAcl.acl) && nAcl.acl.length === 2, 'normalizeRule drops blank entries from an acl list');
ok(nat.normalizeRule({ type: 'pat', insideGlobal: '203.0.113.5', acl: [] }).acl === null,
  'normalizeRule collapses an empty acl list to null');
ok(nat.normalizeRule(null).type === 'pat', 'normalizeRule is total: null normalises without throwing');

// ---------------------------------------------------------------------------
// 3. validateRule
// ---------------------------------------------------------------------------

const vStatic = nat.validateRule({ type: 'static', insideLocal: '192.168.1.10', insideGlobal: '203.0.113.5' });
ok(vStatic.ok === true, 'validateRule accepts a static host-to-host rule');
ok(Array.isArray(vStatic.errors) && vStatic.errors.length === 0,
  'a valid rule reports an empty errors array');
ok(nat.validateRule(patRule()).ok === true, 'validateRule accepts a pat overload rule');
ok(nat.validateRule({ type: 'dynamic', insideLocal: '192.168.1.0/24', insideGlobal: '203.0.113.10-203.0.113.12' }).ok === true,
  'validateRule accepts a dynamic rule with an address pool');

const vBad = nat.validateRule({ type: 'nat44', insideLocal: '192.168.1.10', insideGlobal: '203.0.113.5' });
ok(vBad.ok === false && hasCode(vBad.errors, 'E_RULE_TYPE'), 'validateRule rejects an unknown type with E_RULE_TYPE');
ok(nat.validateRule('static').errors[0].code === 'E_RULE_INVALID',
  'validateRule rejects a non-object with E_RULE_INVALID');
ok(hasCode(nat.validateRule({ type: 'static', insideLocal: '192.168.1.0/24', insideGlobal: '203.0.113.5' }).errors,
  'E_LOCAL_NOT_HOST'), 'validateRule rejects a static rule whose insideLocal is a subnet');
ok(hasCode(nat.validateRule({ type: 'static', insideLocal: '192.168.1.10', insideGlobal: '999.1.1.1' }).errors,
  'E_GLOBAL_SPEC'), 'validateRule rejects a malformed insideGlobal');
ok(hasCode(nat.validateRule({ type: 'static', insideLocal: '192.168.1.10', insideGlobal: '192.168.1.10' }).errors,
  'E_SAME_ADDRESS'), 'validateRule rejects a rule that translates an address onto itself');
ok(hasCode(nat.validateRule({ type: 'pat', insideLocal: '192.168.1.0/24', insideGlobal: '203.0.113.5', port: 70000 }).errors,
  'E_PORT_RANGE'), 'validateRule rejects an out-of-range port');
ok(hasCode(nat.validateRule({ type: 'static', insideLocal: '192.168.1.10', insideGlobal: '203.0.113.5', protocol: 'icmp', port: 8080 }).errors,
  'E_PORT_PROTOCOL'), 'validateRule rejects a port on an icmp rule');
ok(hasCode(nat.validateRule({ type: 'pat', insideLocal: '192.168.1.0/24', insideGlobal: '203.0.113.5', protocol: 'sctpish' }).errors,
  'E_PROTOCOL'), 'validateRule rejects an unknown protocol');
ok(hasCode(nat.validateRule({ type: 'pat', insideLocal: '192.168.1.0/24', insideGlobal: '203.0.113.5', acl: { name: 'x' } }).errors,
  'E_ACL'), 'validateRule rejects a non-string acl');
ok(hasCode(nat.validateRule({ type: 'static', insideLocal: '192.168.1.10', insideGlobal: '203.0.113.10-203.0.113.12' }).errors,
  'E_GLOBAL_NOT_HOST'), 'validateRule rejects a static rule given a pool');
ok(hasCode(nat.validateRule({ type: 'pat', insideLocal: '192.168.1.0/24', insideGlobal: '203.0.113.10-203.0.113.12' }).errors,
  'E_GLOBAL_NOT_HOST'), 'validateRule rejects a pat rule given a pool');
const vMsg = nat.validateRule({ type: 'bogus' });
ok(typeof vMsg.errors[0].code === 'string' && typeof vMsg.errors[0].message === 'string' &&
  vMsg.errors[0].message.length > 10, 'validation errors carry a code and a human message');
ok(hasCode(nat.validateRule({ type: 'static', insideLocal: '192.168.1.10' }).errors, 'E_GLOBAL_SPEC'),
  'validateRule requires an insideGlobal');

// ---------------------------------------------------------------------------
// 4. static NAT, both directions
// ---------------------------------------------------------------------------

// 4a. one-to-one, no port pinning
{
  const t = tableWith({ type: 'static', insideLocal: '192.168.1.10', insideGlobal: '203.0.113.5' });
  const input = pkt({ srcIp: '192.168.1.10', srcPort: 52000 });
  const out = nat.translateOutbound(t, input, 1);

  ok(out.action === 'translate', 'static outbound action is translate');
  ok(out.pkt.srcIp === '203.0.113.5', 'static outbound rewrites srcIp to the inside global');
  ok(out.pkt.dstIp === '203.0.113.9' && out.pkt.dstPort === 443,
    'static outbound leaves the destination untouched');
  ok(out.pkt.srcPort === 52000, 'static outbound preserves the source port');
  ok(out.entry && out.entry.type === 'static', 'static outbound returns a static translation entry');
  ok(out.entry.insideLocal === '192.168.1.10' && out.entry.insideGlobal === '203.0.113.5',
    'the static entry maps insideLocal <-> insideGlobal');
  ok(t.translations.length === 1, 'the static translation is recorded once');

  const back = pkt({ srcIp: '203.0.113.9', dstIp: '203.0.113.5', srcPort: 443, dstPort: 52000 });
  const inb = nat.translateInbound(t, back, 2);
  ok(inb.action === 'translate', 'static inbound action is translate');
  ok(inb.pkt.dstIp === '192.168.1.10', 'static inbound rewrites dstIp back to the inside local');
  ok(inb.pkt.dstPort === 52000, 'static inbound leaves the destination port alone');
  ok(inb.pkt.srcIp === '203.0.113.9', 'static inbound leaves the source address alone');

  // The same static rule reuses its single entry rather than piling up.
  nat.translateOutbound(t, pkt({ srcIp: '192.168.1.10' }), 3);
  ok(t.translations.length === 1, 'a static rule reuses its translation entry');
}

// 4b. static port forwarding
{
  const t = tableWith({
    type: 'static', insideLocal: '192.168.1.20', insideGlobal: '203.0.113.6',
    protocol: 'tcp', port: 8080
  });
  const inb = nat.translateInbound(t, pkt({ dstIp: '203.0.113.6', dstPort: 8080 }), 5);
  ok(inb.action === 'translate' && inb.pkt.dstIp === '192.168.1.20',
    'a static port rule forwards inbound to the inside local');
  ok(inb.pkt.dstPort === 8080, 'a static port rule keeps the forwarded port');

  const out = nat.translateOutbound(t, pkt({ srcIp: '192.168.1.20', srcPort: 8080 }), 6);
  ok(out.pkt.srcIp === '203.0.113.6' && out.pkt.srcPort === 8080,
    'a static port rule pins the translated source port');
}

// 4c. static rule that does not cover the sender
{
  const t = tableWith({ type: 'static', insideLocal: '192.168.1.10', insideGlobal: '203.0.113.5' });
  const out = nat.translateOutbound(t, pkt({ srcIp: '192.168.1.99' }), 1);
  ok(out.action === 'pass', 'a static rule that does not match the sender passes the packet');
  ok(out.entry === null, 'a pass-through carries no translation entry');
}

// ---------------------------------------------------------------------------
// 5. PAT (overload): allocation, reuse, reverse lookup
// ---------------------------------------------------------------------------

{
  const t = tableWith(patRule());
  const a = nat.translateOutbound(t, pkt({ srcIp: '192.168.1.10', srcPort: 52000 }), 10);

  ok(a.action === 'translate', 'pat outbound action is translate');
  ok(a.pkt.srcIp === '203.0.113.5', 'pat outbound rewrites srcIp to the shared global');
  ok(a.pkt.srcPort === 1024, 'pat allocates the first free port, 1024');
  ok(t.nextPort === 1025, 'pat advances table.nextPort past the allocated port');
  ok(a.entry.type === 'pat' && a.entry.globalPort === 1024,
    'the pat entry records the allocated global port');
  ok(a.entry.localPort === 52000 && a.entry.insideLocal === '192.168.1.10',
    'the pat entry remembers the original inside local and port');

  // same flow again -> same port, no new entry
  const aAgain = nat.translateOutbound(t, pkt({ srcIp: '192.168.1.10', srcPort: 52000 }), 11);
  ok(aAgain.pkt.srcPort === 1024, 'pat reuses the port for the same flow');
  ok(t.translations.length === 1, 'pat does not create a second entry for the same flow');
  ok(aAgain.entry === a.entry, 'the reused flow returns the original entry object');

  // a second inside host -> next port
  const b = nat.translateOutbound(t, pkt({ srcIp: '192.168.1.11', srcPort: 52000 }), 12);
  ok(b.pkt.srcPort === 1025, 'a second inside host gets the next free port');
  ok(t.translations.length === 2, 'a second inside host adds a translation');

  // same host, different destination -> its own port
  const c = nat.translateOutbound(t, pkt({ srcIp: '192.168.1.10', dstIp: '198.51.100.20', dstPort: 80 }), 13);
  ok(c.pkt.srcPort === 1026, 'a new destination tuple takes a new port');
  ok(t.translations.length === 3, 'a new destination tuple adds a translation');

  // reverse lookup: (globalIp, globalPort, protocol) -> inside local
  const hit = nat.lookupTranslation(t, { globalIp: '203.0.113.5', globalPort: 1025, protocol: 'tcp' });
  ok(hit && hit.insideLocal === '192.168.1.11', 'lookupTranslation finds a pat entry by port');
  ok(nat.lookupTranslation(t, { globalIp: '203.0.113.5', globalPort: 40000, protocol: 'tcp' }) === null,
    'lookupTranslation returns null for an unallocated port');
  ok(nat.lookupTranslation(t, { globalIp: '203.0.113.77', globalPort: 1024, protocol: 'tcp' }) === null,
    'lookupTranslation returns null for an unknown global address');

  const reply = nat.translateInbound(t, pkt({
    srcIp: '203.0.113.9', dstIp: '203.0.113.5', srcPort: 443, dstPort: 1024
  }), 14);
  ok(reply.action === 'translate', 'pat inbound action is translate');
  ok(reply.pkt.dstIp === '192.168.1.10', 'pat inbound rewrites the destination to the inside local');
  ok(reply.pkt.dstPort === 52000, 'pat inbound restores the original inside port');
  ok(reply.pkt.srcIp === '203.0.113.9', 'pat inbound leaves the remote source untouched');

  const wrongProto = nat.translateInbound(t, pkt({
    srcIp: '203.0.113.9', dstIp: '203.0.113.5', srcPort: 443, dstPort: 1024, protocol: 'udp'
  }), 15);
  ok(wrongProto.action === 'pass', 'pat inbound does not match a different protocol');
  ok(wrongProto.pkt.dstIp === '203.0.113.5', 'a non-matching inbound packet keeps its address');
}

// 5b. PAT across a wider inside range, gated by an acl allow-list
{
  const t = tableWith(patRule({ insideLocal: '10.0.0.0/8', acl: '10.1.0.0/16' }));
  const denied = nat.translateOutbound(t, pkt({ srcIp: '10.2.2.2' }), 1);
  ok(denied.action === 'pass', 'an acl allow-list outside the sender range passes the packet');
  ok(t.translations.length === 0, 'a denied sender leaves no translation behind');
  const allowed = nat.translateOutbound(t, pkt({ srcIp: '10.1.2.3' }), 2);
  ok(allowed.action === 'translate' && allowed.pkt.srcIp === '203.0.113.5',
    'an acl allow-list inside the sender range translates the packet');
}

// ---------------------------------------------------------------------------
// 6. dynamic NAT: pool allocation and exhaustion
// ---------------------------------------------------------------------------

{
  const t = tableWith({
    type: 'dynamic', insideLocal: '192.168.1.0/24',
    insideGlobal: '203.0.113.10-203.0.113.11'
  });

  const one = nat.translateOutbound(t, pkt({ srcIp: '192.168.1.10' }), 20);
  ok(one.action === 'translate' && one.pkt.srcIp === '203.0.113.10',
    'dynamic nat hands out the first pool address');
  ok(one.pkt.srcPort === 52000, 'dynamic nat leaves the source port alone');
  ok(one.entry.type === 'dynamic' && one.entry.globalPort === null,
    'a dynamic entry has no port translation');

  const two = nat.translateOutbound(t, pkt({ srcIp: '192.168.1.11' }), 21);
  ok(two.pkt.srcIp === '203.0.113.11', 'dynamic nat hands out the next pool address');

  const three = nat.translateOutbound(t, pkt({ srcIp: '192.168.1.12' }), 22);
  ok(three.action === 'drop', 'dynamic nat drops a packet when the pool is exhausted');
  ok(three.reason === 'E_NAT_POOL_EXHAUSTED', 'pool exhaustion reports E_NAT_POOL_EXHAUSTED');
  ok(three.entry === null && three.pkt.srcIp === '192.168.1.12',
    'a dropped packet keeps its original addressing');

  const inb = nat.translateInbound(t, pkt({ srcIp: '203.0.113.9', dstIp: '203.0.113.11', srcPort: 443, dstPort: 52000 }), 23);
  ok(inb.action === 'translate' && inb.pkt.dstIp === '192.168.1.11',
    'dynamic inbound maps a pool address back to its inside host');
}

// ---------------------------------------------------------------------------
// 7. no matching rule -> pass
// ---------------------------------------------------------------------------

{
  const t = nat.createNatTable();
  const input = pkt();
  const out = nat.translateOutbound(t, input, 1);
  ok(out.action === 'pass', 'an empty rule table passes an outbound packet');
  ok(JSON.stringify(out.pkt) === JSON.stringify(input), 'a passed packet is unchanged');
  ok(out.pkt !== input, 'a passed packet is still a new object');

  const inb = nat.translateInbound(t, pkt({ srcIp: '203.0.113.9', dstIp: '192.168.1.10' }), 2);
  ok(inb.action === 'pass', 'an unknown inbound packet passes through');

  const udpTable = tableWith(patRule({ protocol: 'tcp' }));
  const udpOut = nat.translateOutbound(udpTable, pkt({ protocol: 'udp' }), 3);
  ok(udpOut.action === 'pass', 'a tcp-only rule passes a udp packet');
}

// ---------------------------------------------------------------------------
// 8. immutability
// ---------------------------------------------------------------------------

{
  const t = tableWith(patRule());
  const input = pkt({ srcIp: '192.168.1.10', srcPort: 52000 });
  const snapshot = JSON.stringify(input);
  const out = nat.translateOutbound(t, input, 1);
  ok(JSON.stringify(input) === snapshot, 'translateOutbound never mutates the input packet');
  ok(out.pkt !== input, 'translateOutbound returns a distinct packet object');
  ok(out.pkt.srcIp === '203.0.113.5' && input.srcIp === '192.168.1.10',
    'only the returned packet carries the translated address');

  const reply = pkt({ srcIp: '203.0.113.9', dstIp: '203.0.113.5', srcPort: 443, dstPort: 1024 });
  const replySnapshot = JSON.stringify(reply);
  const inb = nat.translateInbound(t, reply, 2);
  ok(JSON.stringify(reply) === replySnapshot, 'translateInbound never mutates the input packet');
  ok(inb.pkt !== reply, 'translateInbound returns a distinct packet object');
  ok(reply.dstPort === 1024 && inb.pkt.dstPort === 52000,
    'the original inbound packet keeps its global port');
}

// ---------------------------------------------------------------------------
// 9. table shape + `show ip nat translations`
// ---------------------------------------------------------------------------

{
  const t = nat.createNatTable();
  ok(Array.isArray(t.rules) && t.rules.length === 0, 'createNatTable starts with no rules');
  ok(Array.isArray(t.translations) && t.translations.length === 0,
    'createNatTable starts with no translations');
  ok(t.nextPort === 1024, 'createNatTable starts allocating at port 1024');
  ok(nat.formatTable(t).length === 0, 'formatTable renders an empty table as no lines');
}

{
  const t = tableWith(
    patRule(),
    { type: 'static', insideLocal: '192.168.1.50', insideGlobal: '203.0.113.7' }
  );
  nat.translateOutbound(t, pkt({ srcIp: '192.168.1.10', srcPort: 52000 }), 30);
  nat.translateOutbound(t, pkt({ srcIp: '192.168.1.50', srcPort: 41000 }), 31);

  const lines = nat.formatTable(t);
  ok(Array.isArray(lines) && lines.length === t.translations.length,
    'formatTable emits one line per translation');
  ok(lines.every(function (l) { return typeof l === 'string'; }), 'formatTable lines are strings');

  const patLine = lines.filter(function (l) { return /:1024\b/.test(l); })[0] || '';
  ok(patLine.indexOf('203.0.113.5:1024') !== -1, 'the pat line shows the global address and port');
  ok(patLine.indexOf('192.168.1.10:52000') !== -1, 'the pat line shows the inside local and port');
  ok(/\bpat\s*$/.test(patLine), 'the pat line ends with its translation type');

  const staticLine = lines.filter(function (l) { return l.indexOf('203.0.113.7') !== -1; })[0] || '';
  ok(staticLine.indexOf('192.168.1.50') !== -1, 'the static line shows the inside local address');
  ok(/\bstatic\s*$/.test(staticLine), 'the static line ends with its translation type');
  ok(nat.formatTable(t).join('\n') === lines.join('\n'), 'formatTable output is stable across calls');
  ok(typeof nat.TABLE_HEADER === 'string' && nat.TABLE_HEADER.indexOf('Inside global') !== -1,
    'TABLE_HEADER documents the columns for the CLI');
  ok(nat.formatTable(null).length === 0, 'formatTable tolerates a missing table');
}

// ---------------------------------------------------------------------------
// 10. translation expiry
// ---------------------------------------------------------------------------

{
  const t = tableWith(patRule(), { type: 'static', insideLocal: '192.168.1.50', insideGlobal: '203.0.113.7' });
  nat.translateOutbound(t, pkt({ srcIp: '192.168.1.10' }), 10);
  nat.translateOutbound(t, pkt({ srcIp: '192.168.1.50' }), 10);
  ok(t.translations.length === 2, 'the table holds one pat and one static translation');

  ok(nat.expireTranslations(t, { tcp: 60 }, 69) === 0, 'nothing expires before the tcp timeout');
  ok(t.translations.length === 2, 'both translations survive an early sweep');

  ok(nat.expireTranslations(t, { tcp: 60 }, 70) === 1, 'the pat translation expires at the tcp timeout');
  ok(t.translations.length === 1, 'only the expired translation is removed');
  ok(t.translations[0].type === 'static', 'a static translation never expires');
  ok(nat.lookupTranslation(t, { globalIp: '203.0.113.5', globalPort: 1024, protocol: 'tcp' }) === null,
    'an expired translation is no longer looked up');

  const reply = nat.translateInbound(t, pkt({ srcIp: '203.0.113.9', dstIp: '203.0.113.5', srcPort: 443, dstPort: 1024 }), 71);
  ok(reply.action === 'pass', 'a reply for an expired translation passes untranslated');

  ok(nat.expireTranslations(t, { default: 5 }, 1000) === 0,
    'a static translation still survives a default-timeout sweep');
  ok(nat.expireTranslations(nat.createNatTable(), {}, 10) === 0, 'expiring an empty table removes nothing');
}

{
  // A live flow keeps refreshing, so a busy translation never ages out.
  const t = tableWith(patRule());
  nat.translateOutbound(t, pkt({ srcIp: '192.168.1.10' }), 0);
  nat.translateOutbound(t, pkt({ srcIp: '192.168.1.10' }), 50);
  ok(nat.expireTranslations(t, { tcp: 60 }, 90) === 0, 'a refreshed translation does not expire');
  ok(nat.expireTranslations(t, { tcp: 60 }, 110) === 1, 'the translation expires once the flow goes idle');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
