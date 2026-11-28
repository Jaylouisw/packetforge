'use strict';
// A router runs one BGP process, and its local AS is fixed when that process is created.
// Re-typing `router bgp <other-as>` on a box already running BGP does not renumber it: the box prints
//   BGP is already running; AS is 34
// and keeps AS 34. This console read the line as a redefinition, so a typo silently moved a live process -
// neighbours kept their `remote-as`, `show ip bgp summary` began reporting a new local AS and
// `show running-config` printed a process nobody created.
//
// Evidence and the two details asserted below (no leading `%`, no full stop) are in
// research/bgp-second-router-as.md. Retyping the SAME AS also creates nothing; a box says nothing there and
// re-enters its router sub-mode, which this console does not have (docs/BGP-POLICY.md section 9.2), so the
// receipt is this console's own "nothing was done" sentence - the shape `vlan 20` on an existing VLAN uses.
const path = require('path');
const { Topology, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const spec = catalog.find(function (x) { return x.vendor === 'generic' && x.model === 'generic-router'; });

function box() {
  const t = new Topology();
  const d = t.addDevice(spec, 'r1');
  d.name = 'R1';
  function cli(cmds, exec) {
    const pre = exec ? ['enable'] : ['enable', 'configure terminal'];
    // `runCommands` echoes each prompt and the command after it; the answers are the lines that are
    // neither an echo nor the configuration banner.
    return runCommands(d, t, null, pre.concat(cmds)).lines.map(String).filter(function (l) {
      return !/^Router-r1[>#]/.test(l) && !/^Router-r1\(/.test(l) && !/^Enter configuration commands/.test(l);
    });
  }
  return { t: t, d: d, cli: cli };
}

console.log('A fresh box: the first `router bgp` creates the process');
{
  const b = box();
  const out = b.cli(['router bgp 65001']);
  ok(out.length === 1 && out[0] === 'BGP enabled, local AS 65001',
    'the creation receipt is unchanged', JSON.stringify(out));
  ok(b.d.config.bgp && b.d.config.bgp.as === 65001, 'local AS 65001 is stored');
}

console.log('\nThe same AS, typed again: nothing is created');
{
  const b = box();
  b.cli(['router bgp 65001']);
  const out = b.cli(['router bgp 65001']);
  ok(out.length === 1 && /^BGP is already running as 65001, so there was nothing to enable$/.test(out[0]),
    'it says the process is already there instead of announcing a second creation', JSON.stringify(out));
  ok(!/BGP enabled/.test(out.join(' ')), 'the word `enabled` is gone from a line that enabled nothing');
  ok(b.d.config.bgp.as === 65001, 'and the AS is untouched');
}

console.log('\nA different AS: refused, in the box\'s own words');
{
  const b = box();
  b.cli(['router bgp 65001']);
  const out = b.cli(['router bgp 65002']);
  ok(out.length === 1 && out[0] === 'BGP is already running; AS is 65001',
    'the line is the vendor\'s, with the running AS in it', JSON.stringify(out));
  ok(out[0].indexOf('%') === -1, 'no leading `%`: the box prints this warning unprefixed');
  ok(!/\.$/.test(out[0]), 'and no full stop after the AS');
  ok(b.d.config.bgp.as === 65001, 'the local AS did not move');
}

console.log('\nWhat the box keeps: neighbours, the summary and the saved config');
{
  const b = box();
  b.cli(['router bgp 65001', 'neighbor 10.0.12.2 remote-as 65002']);
  const out = b.cli(['router bgp 65002', 'router bgp 65002', 'router bgp 65003']);
  ok(out.filter(function (l) { return l === 'BGP is already running; AS is 65001'; }).length === 3,
    'every attempt answers with the same AS, however many times it is retyped', JSON.stringify(out));
  ok(b.d.config.bgp.as === 65001, 'still 65001 in the config');
  ok(b.d.config.bgp.neighbors.length === 1 && b.d.config.bgp.neighbors[0].remoteAs === 65002,
    'the neighbour and its remote-as survived the attempt');

  const summary = b.cli(['show ip bgp summary'], true);
  ok(/local AS number 65001/.test(summary.join(' ')), '`show ip bgp summary` still reports 65001',
    JSON.stringify(summary));

  const run = b.cli(['show running-config'], true);
  ok(run.indexOf('router bgp 65001') !== -1, 'the saved config prints `router bgp 65001`');
  ok(run.indexOf('router bgp 65002') === -1 && run.indexOf('router bgp 65003') === -1,
    'and never the AS that was refused');
}

console.log('\nRemoving the process is what frees the AS');
{
  const b = box();
  b.cli(['router bgp 65001']);
  const out = b.cli(['no router bgp 65001', 'router bgp 65002']);
  ok(out[out.length - 1] === 'BGP enabled, local AS 65002',
    'after `no router bgp`, a new AS is accepted and says it was created', JSON.stringify(out));
  ok(b.d.config.bgp.as === 65002, 'and it is the one stored');
}

console.log('\nThe old refusals are untouched');
{
  const b = box();
  const out = b.cli(['router bgp 0']);
  ok(out[0] === '% Invalid AS number "0"', 'an out-of-range AS is still refused by value', JSON.stringify(out));
  ok(!b.d.config.bgp, 'and no process is created by it');
  const out2 = b.cli(['router bgp 65001', 'router bgp 70000']);
  ok(out2.join(' ') === 'BGP enabled, local AS 65001 BGP is already running; AS is 65001',
    'a valid different AS is the only new refusal, and it is not an `% Invalid AS number` one', JSON.stringify(out2));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
