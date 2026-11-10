'use strict';
// iface-capability.test.js - interface mode had the same defect as config mode, one prompt deeper.
//
// Probing `?` inside an interface block found rows a device could not use, and two commands the
// parser accepted on it:
//
//   PC1(config-if)#channel-group 1 mode active
//   Interface eth0 added to channel group 1 (LACP active)     <- a LAG on a one-port host
//
//   R1(config-if)#channel-group 1 mode active
//   Interface Gi0/0 added to channel group 1 (LACP active)    <- a LAG of routed interfaces
//
// `show etherchannel` had just been taught to refuse a device that does not switch, so the command
// and the view disagreed about the same hardware. The page also offered `no switchport
// port-security` to a PC - the removal of a setting whose positive form was already filtered out -
// and `ip ospf cost 10` answered "% OSPF is not enabled" on a switch, which describes a missing
// configuration where the truth is a missing capability.
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession, } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function match(re, haystack, msg) {
  const text = (haystack && haystack.output) ? haystack.output.join('\n') : String(haystack);
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text.slice(0, 700)) + ')'));
}
const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const model = function (m) { return catalog.filter(function (x) { return x.model === m; })[0]; };

function iface(m) {
  const t = new Topology();
  const d = t.addDevice(model(m)); d.name = 'D';
  const s = new CliSession(d, t, new Simulator(t)); s.run('enable');
  const port = Array.from(d.interfaces.keys())[0];
  s.run('configure terminal'); s.run('interface ' + port);
  return {
    d: d, s: s, port: port,
    rows: function () {
      return s.run('?').output.filter(function (l) { return /^ {2}\S/.test(l); })
        .map(function (l) { return l.trim().split(/\s{2,}/)[0]; });
    }
  };
}

console.log('\nThe harness can see the page at all (a row filter that matches nothing makes every');
console.log('"is not offered" assertion pass for the wrong reason - which happened while writing this):');
{
  for (const kind of ['generic-switch', 'generic-l3-switch', 'generic-router', 'generic-pc']) {
    const n = iface(kind).rows().length;
    ok(n > 20, kind + ' renders a usable page (' + n + ' rows)');
  }
}

console.log('\nA LAG is a bundle of switch ports, and only a switch has them:');
{
  for (const kind of ['generic-pc', 'generic-router', 'generic-server']) {
    const env = iface(kind);
    const out = env.s.run('channel-group 1 mode active');
    match(/does not switch, so it has no switch ports to bundle/, out,
      kind + ' is refused a channel-group by name');
    ok(!env.d.config.lags || !Object.keys(env.d.config.lags).length,
      kind + ' is left with no LAG configured');
    ok(!env.rows().some(function (r) { return /channel-group/.test(r); }),
      kind + ' is not offered channel-group');
  }
  const sw = iface('generic-switch');
  match(/channel group 1/, sw.s.run('channel-group 1 mode active'), 'a switch still gets its LAG');
  ok(sw.rows().some(function (r) { return /channel-group/.test(r); }), 'and is offered it');
}

console.log('\nThe OSPF verbs name the capability, not missing configuration:');
{
  for (const kind of ['generic-pc', 'generic-switch']) {
    const env = iface(kind);
    match(/is not a router: no routing protocol runs on its interfaces/, env.s.run('ip ospf cost 10'),
      kind + ' is told it is not a router');
    ok(!env.rows().some(function (r) { return /ip ospf/.test(r); }), kind + ' is not offered ip ospf verbs');
  }
  // A router that simply has not started OSPF keeps the configuration answer, which is correct there.
  const rt = iface('generic-router');
  match(/OSPF is not enabled/, rt.s.run('ip ospf cost 10'),
    'a router without OSPF still hears about the missing configuration');
  ok(rt.rows().some(function (r) { return /ip ospf/.test(r); }), 'and is offered the verbs');
}

console.log('\nPoE verbs need a port that sources power:');
{
  const pc = iface('generic-pc');
  match(/does not source PoE|sources PoE/, pc.s.run('power inline never'), 'a PC is refused power inline');
  ok(!pc.rows().some(function (r) { return /power inline/.test(r); }), 'and is not offered either form');
  const sw = iface('generic-switch');
  ok(!sw.rows().some(function (r) { return /power inline/.test(r); }),
    'a switch with no PoE ports is not offered it either');
  // A device with PoE-out ports is: built from the port template so the ports really source power.
  const catalogSwitch = model('generic-switch');
  const spec = Object.assign({}, catalogSwitch, {
    poeBudget: 60,
    portTemplate: Object.assign({}, catalogSwitch.portTemplate, { count: 4, poeOut: 15.4 })
  });
  const t = new Topology();
  const d = t.addDevice(spec); d.name = 'PSE';
  const s = new CliSession(d, t, new Simulator(t)); s.run('enable');
  const port = Array.from(d.interfaces.keys())[0];
  s.run('configure terminal'); s.run('interface ' + port);
  const rows = s.run('?').output.filter(function (l) { return /^ {2}\S/.test(l); })
    .map(function (l) { return l.trim().split(/\s{2,}/)[0]; });
  ok(rows.some(function (r) { return /power inline/.test(r); }), 'a PSE is offered power inline');
  match(/Power inline on .* set to never/i, s.run('power inline never'), 'and it takes the verb');
}

console.log('\nNo removal is offered for a setting the device cannot have:');
{
  const pc = iface('generic-pc');
  const rows = pc.rows();
  ok(!rows.some(function (r) { return /switchport/.test(r); }),
    'a PC is offered no switchport row at all, positive or removal');
  const sw = iface('generic-switch');
  const swRows = sw.rows();
  ok(swRows.some(function (r) { return /^switchport port-security\b/.test(r); }),
    'a switch is offered the positive form');
  // Every `no X` row a device is shown has its positive row too, or the page is describing a
  // removal of something it never offered.
  for (const kind of ['generic-switch', 'generic-l3-switch', 'generic-router', 'generic-pc']) {
    const env = iface(kind);
    const list = env.rows();
    const orphans = [];
    for (const r of list) {
      // Ordinary control flow, not an exemption: every row is visited, and this only selects the
      // removal forms to compare against the rest of the same list.
      if (!/^no /.test(r)) continue;
      const positive = r.replace(/^no /, '').replace(/\s*\\[[^\\]]*\\]/g, '').trim();
      const head = positive.split(' ').slice(0, 2).join(' ');
      if (!list.some(function (x) { return x.indexOf(head) === 0; }) &&
        !list.some(function (x) { return x.indexOf(positive.split(' ')[0]) === 0; })) {
        // `no ip address [dhcp]` pairs with `ip address dhcp`, and `no mtu` with `mtu`: compare heads.
        orphans.push(r);
      }
    }
    ok(orphans.length === 0, kind + ': every removal has its positive form' +
      (orphans.length ? ' (orphans: ' + orphans.slice(0, 4).join(' | ') + ')' : ''));
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
