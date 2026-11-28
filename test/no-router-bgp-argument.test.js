'use strict';
// `no router bgp` needs its AS. The vendor syntax is `no router bgp autonomous-system-number`, with the
// argument outside any brackets, so a box given the three words alone runs out of line and answers
//   % Incomplete command.
// before any handler sees it - it does not remove a process it was not told to remove.
//
// This console took the three words and cleared the process, so an operator who typed `no router bgp` and
// stopped to look the number up had already deleted the live configuration: process, neighbours and the
// `router bgp` stanza in `show running-config`. The branch now answers with the console's own incomplete-
// command sentence (the vendor's wording is a parser message, and this console spells incomplete commands
// in its own words - see `no vlan` above it in cli.js) and changes nothing.
//
// The evidence, and the two adjacent questions it does not settle (a mismatched AS, and a `no` with no
// process to remove), are in research/no-router-bgp-argument.md.
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
    return runCommands(d, t, null, pre.concat(cmds)).lines.map(String).filter(function (l) {
      return !/^Router-r1[>#]/.test(l) && !/^Router-r1\(/.test(l) && !/^Enter configuration commands/.test(l);
    });
  }
  return { t: t, d: d, cli: cli };
}

console.log('A bare `no router bgp`: incomplete, and nothing is removed');
{
  const b = box();
  b.cli(['router bgp 65001', 'neighbor 10.0.12.2 remote-as 65002']);
  const out = b.cli(['no router bgp']);
  ok(out.length === 1 && out[0] === '% Incomplete command: no router bgp <as> (BGP is still running as 65001)',
    'the refusal names the syntax and the AS that is still running', JSON.stringify(out));
  ok(b.d.config.bgp && b.d.config.bgp.as === 65001, 'the local AS is untouched');
  ok(b.d.config.bgp.neighbors.length === 1 && b.d.config.bgp.neighbors[0].remoteAs === 65002,
    'and so is the neighbour');
  const run = b.cli(['show running-config'], true);
  ok(run.indexOf('router bgp 65001') !== -1,
    '`show running-config` still prints the process the half-command did not delete', JSON.stringify(run.slice(0, 4)));
  const summary = b.cli(['show ip bgp summary'], true);
  ok(/local AS number 65001/.test(summary.join(' ')), '`show ip bgp summary` still reports 65001',
    JSON.stringify(summary.slice(0, 3)));
}

console.log('\nThe same half-command on a box with no process: still incomplete, still nothing');
{
  const b = box();
  const out = b.cli(['no router bgp']);
  ok(out.length === 1 && out[0] === '% Incomplete command: no router bgp <as> (there is no BGP process to remove)',
    'it says there is nothing to remove instead of claiming one was disabled', JSON.stringify(out));
  ok(!b.d.config.bgp, 'and no config object appears');
}

console.log('\nAn AS that is not an AS: refused by value, process intact');
{
  const b = box();
  b.cli(['router bgp 65001']);
  const out = b.cli(['no router bgp foo', 'no router bgp 0', 'no router bgp 4294967296', 'no router bgp -1']);
  ok(out.join(' ') === '% Invalid AS number "foo" % Invalid AS number "0" ' +
    '% Invalid AS number "4294967296" % Invalid AS number "-1"',
    'the same `% Invalid AS number` check the create path runs, for a word, a zero, one past the range and a negative',
    JSON.stringify(out));
  ok(b.d.config.bgp && b.d.config.bgp.as === 65001, 'the process survived all four');
  const created = b.cli(['no router bgp abc']);
  ok(created[0] === '% Invalid AS number "abc"' && b.d.config.bgp.as === 65001,
    'and the check precedes the delete, so nothing is cleared first', JSON.stringify(created));
}

console.log('\nA valid AS: the delete still happens, in the words it had');
{
  const b = box();
  b.cli(['router bgp 65001']);
  const out = b.cli(['no router bgp 65001']);
  ok(out.length === 1 && out[0] === 'BGP disabled', '`no router bgp 65001` is unchanged', JSON.stringify(out));
  ok(b.d.config.bgp === null, 'the process is gone');
  const again = b.cli(['no router bgp 65001']);
  ok(again[0] === 'BGP disabled', 'a second one still answers as before (the no-process case is not settled)',
    JSON.stringify(again));
}

console.log('\nA mismatched AS is left as it was: unresolved, and locked so a later change is visible');
{
  // No capture in hand shows what a box does with `no router bgp <other>` while running <as>; this console
  // treats the number as a name for the one process it has, which is the behaviour every lab in this repo
  // relies on. The test pins it so that changing it is a decision rather than a drift.
  const b = box();
  b.cli(['router bgp 65001']);
  const out = b.cli(['no router bgp 65002']);
  ok(out.length === 1 && out[0] === 'BGP disabled', 'the number is still a name for the one process', JSON.stringify(out));
  ok(b.d.config.bgp === null, 'and the process is removed');
  const next = b.cli(['router bgp 65002']);
  ok(next[0] === 'BGP enabled, local AS 65002', 'so the AS is free for the new process', JSON.stringify(next));
}

console.log('\nLeading zeros are the same number, as they are on the create path');
{
  const b = box();
  b.cli(['router bgp 65001']);
  const out = b.cli(['no router bgp 065001']);
  ok(out[0] === 'BGP disabled' && b.d.config.bgp === null, '`no router bgp 065001` removes AS 65001',
    JSON.stringify(out));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
