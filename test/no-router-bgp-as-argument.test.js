'use strict';
// `no router bgp` is `no router bgp autonomous-system-number`: the argument is required by the vendor syntax
// (Cisco IOS / IOS XE command reference; IOS XR writes it bracketed, which is how the family shows IOS requires
// it), and a line that is missing a required value is answered `% Incomplete command.` without running.
//
// This branch read the three words `no router bgp` and nothing else, so a line that named no process deleted
// the one that was running: `router bgp 65001` + `neighbor 10.0.12.2 remote-as 65002`, then `no router bgp`
// answered `BGP disabled` and the process, its neighbour and its `router bgp` stanza were gone before the
// operator had named the AS. The console's own `no`-form catalogue already prints the syntax as
// `no router bgp <as>` (NO_FORMS, cli.js), so the page promised an argument the line never asked for.
// research/no-router-bgp-argument.md records the vendor two-part answer (missing value -> `% Incomplete
// command.`; a value that is not an AS -> the create path's `% Invalid AS number "<x>"`).
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

// A box running AS 65001 with one neighbour: the state a `no router bgp` with no AS used to delete.
function running() {
  const b = box();
  b.cli(['router bgp 65001', 'neighbor 10.0.12.2 remote-as 65002']);
  return b;
}

console.log('A running process: `no router bgp` with no AS is incomplete, and names the AS to type');
{
  const b = running();
  const out = b.cli(['no router bgp']);
  ok(out.length === 1, 'the line answers with one line', JSON.stringify(out));
  ok(out[0] === '% Incomplete command: no router bgp 65001',
    'it is the incomplete-command refusal, with the running AS where the argument goes', JSON.stringify(out));
  ok(b.d.config.bgp && b.d.config.bgp.as === 65001, 'the local AS is untouched', JSON.stringify(b.d.config.bgp));
  ok(((b.d.config.bgp || {}).neighbors || []).length === 1,
    'the neighbour is untouched', JSON.stringify((b.d.config.bgp || {}).neighbors));
}

console.log('\nThe same box, read back: nothing was deleted');
{
  const b = running();
  b.cli(['no router bgp']);
  const rc = b.cli(['show running-config'], true).join('\n');
  ok(rc.indexOf('router bgp 65001') !== -1, '`show running-config` still prints the stanza',
    rc.split('\n').slice(0, 6).join(' | '));
  ok(rc.indexOf('neighbor 10.0.12.2 remote-as 65002') !== -1, 'and the neighbour line under it');
  const summary = b.cli(['show ip bgp summary'], true).join('\n');
  ok(summary.indexOf('% BGP not active') === -1, '`show ip bgp summary` still answers for the live process',
    summary.split('\n')[0]);
  ok(/local AS number 65001/.test(summary), 'with its local AS unchanged', summary.split('\n')[0]);
}

console.log('\nA third word that is not an AS: the create path\'s own sentence, and nothing deleted');
{
  // `65001.5` is left out on purpose: asdot notation is real IOS syntax and this console models neither
  // form nor refusal of it, so the test does not pin a spelling the box may hold (research records the gap).
  const cases = ['eigrp', 'abc', '0', '4294967296'];
  for (const word of cases) {
    const b = running();
    const out = b.cli(['no router bgp ' + word]);
    ok(out.length === 1 && out[0] === '% Invalid AS number "' + word + '"',
      '`no router bgp ' + word + '` is refused as an AS', JSON.stringify(out));
    ok(b.d.config.bgp && b.d.config.bgp.as === 65001, 'and the process survives `' + word + '`',
      JSON.stringify(b.d.config.bgp && b.d.config.bgp.as));
  }
}

console.log('\nThe two paths agree word for word on what an AS is');
{
  const words = ['eigrp', 'abc', '0', '4294967296'];
  for (const word of words) {
    const create = box();
    const made = create.cli(['router bgp ' + word]);
    const b = running();
    const removed = b.cli(['no router bgp ' + word]);
    ok(made.length === 1 && made[0] === removed[0],
      '`router bgp ' + word + '` and `no router bgp ' + word + '` print the same sentence',
      JSON.stringify([made, removed]));
  }
}

console.log('\nNo process at all: still incomplete, and no claim that something was disabled');
{
  const b = box();
  const out = b.cli(['no router bgp']);
  ok(out.length === 1 && out[0] === '% Incomplete command: no router bgp <as>',
    'there is no AS to name, so the syntax is printed with its placeholder', JSON.stringify(out));
  ok(out.join(' ').indexOf('BGP disabled') === -1,
    'the word `disabled` is gone from a box with nothing to disable');
  ok(b.d.config.bgp === null || b.d.config.bgp === undefined, 'and nothing was created by the refusal',
    JSON.stringify(b.d.config.bgp));
}

console.log('\nThe syntax the catalogue prints still runs');
{
  const b = running();
  const out = b.cli(['no router bgp 65001']);
  ok(out.length === 1 && out[0] === 'BGP disabled', '`no router bgp <as>` still disables the process',
    JSON.stringify(out));
  ok(b.d.config.bgp === null, 'the config is cleared');
  ok((b.d.bgpRoutes || []).length === 0, 'and the learned routes are dropped');
  const again = b.cli(['router bgp 65002']);
  ok(again.length === 1 && again[0] === 'BGP enabled, local AS 65002',
    'the AS is free, so a new process can be created', JSON.stringify(again));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
