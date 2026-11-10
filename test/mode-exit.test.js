'use strict';
// mode-exit.test.js — where `exit` and `end` actually leave you.
//
// Found while building another test: `exit` from `(config)#` landed in **user** exec (`>`), not
// privileged exec (`#`). The session kept its configuration but lost its privilege, so the very
// next `show` or `ping` answered:
//
//     R1(config)#exit
//     R1>show ip interface brief
//     % Invalid exec command: show ip interface brief
//
// Nothing said "you are no longer enabled" - the prompt did, quietly, and only if you looked at it.
// It is also why a stray `exit` used to make the next block of configuration disappear into
// refusals: the lines were being typed at `>` where no config command exists.
//
// The fix remembers the mode `configure terminal` was entered from and returns there. Privilege is
// not granted by leaving configuration: a session that never enabled still comes back to `>`.
//
// The second half of this file pins the fall-through note. A global command typed inside an
// interface block is applied at global scope and leaves the block - necessary so a pasted
// `show running-config` runs start to finish, but silent enough that `ospf area 0` in a port block
// reads as "this port is in area 0" when it actually configured the process.
const path = require('path');
const { Topology, Simulator, runCommands } = require('../engine');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg + (actual === expected ? '' : ' (got ' + JSON.stringify(actual) +
    ', want ' + JSON.stringify(expected) + ')'));
}
function match(re, text, msg) {
  ok(re.test(text), msg + (re.test(text) ? '' : ' (no match in ' + JSON.stringify(text) + ')'));
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices'));
const router = () => catalog.find((x) => x.model === 'generic-router');

let seq = 0;
function newLab() {
  const t = new Topology();
  const d = t.addDevice(router());
  d.name = 'R' + (++seq);
  return { t: t, d: d, sim: new Simulator(t) };
}
// Prompts only: everything that came back with a `#` or `>` before it.
function prompts(lab, cmds) {
  const out = runCommands(lab.d, lab.t, lab.sim, cmds).lines;
  return out.filter(function (l) { return /^[A-Za-z0-9_.() -]+[>#]/.test(l); })
    .map(function (l) { return l.slice(l.lastIndexOf(':') + 1); });
}
function all(lab, cmds) { return runCommands(lab.d, lab.t, lab.sim, cmds).lines; }

console.log('Leaving configuration returns to privileged exec:');
{
  const lab = newLab();
  const out = all(lab, ['enable', 'configure terminal', 'exit', 'show ip interface brief']);
  const last = out[out.length - 1];
  ok(!/^% /.test(last), 'after enable -> configure -> exit, a show command works (' + JSON.stringify(last).slice(0, 40) + ')');
  const prompt = out.filter(function (l) { return /^[A-Za-z0-9_.() -]+[>#]/.test(l); }).pop();
  match(/\[#\]$|#show ip interface brief$/, prompt, 'because the session is at `#`: ' + prompt);
}

console.log('\n`end` returns there from any configuration mode:');
{
  const lab = newLab();
  const out = all(lab, ['enable', 'configure terminal', 'interface Gi0/0', 'end', 'show ip interface brief']);
  const prompt = out.filter(function (l) { return /^[A-Za-z0-9_.() -]+[>#]/.test(l); }).pop();
  match(/#show ip interface brief$/, prompt, 'end from (config-if) lands at `#`, not back in the block');
  ok(!/^% /.test(out[out.length - 1]), 'and the next command runs');
}
{
  const lab = newLab();
  const out = all(lab, ['enable', 'configure terminal', 'ip dhcp pool TEST', 'end', 'show ip dhcp pool']);
  const prompt = out.filter(function (l) { return /^[A-Za-z0-9_.() -]+[>#]/.test(l); }).pop();
  match(/#show ip dhcp pool$/, prompt, 'and so does end from a DHCP pool block');
}

console.log('\n`exit` still steps back one level at a time:');
{
  const lab = newLab();
  const out = all(lab, ['enable', 'configure terminal', 'interface Gi0/0', 'exit',
    'router bgp 65001', 'exit']);
  ok(out.some(function (l) { return /\(config\)#/.test(l); }),
    'exit from (config-if) goes back to (config), not past it');
  ok(!/^% /.test(out[out.length - 1]), 'and the global command after it is accepted');
}

console.log('\nPrivilege is not granted by leaving configuration:');
{
  const lab = newLab();
  const out = all(lab, ['configure terminal', 'exit', 'show version']);
  // The prompt printed with the *next* command is the one `exit` left behind.
  const prompt = out.filter(function (l) { return /^[A-Za-z0-9_.() -]+[>#]/.test(l); }).pop();
  match(/>show version$/, prompt, 'a session that never enabled comes back to `>`, not `#`');
}

console.log('\nA global command inside a port block says what it did:');
{
  const lab = newLab();
  const out = all(lab, ['enable', 'configure terminal', 'interface Gi0/0', 'ospf area 0']);
  const note = out.filter(function (l) { return /^  note:/.test(l); })[0];
  ok(!!note, 'the fall-through is announced rather than silent');
  match(/is a global command/, note, 'the note says the line was global');
  match(/applied at global scope/, note, 'and that it applied there');
  match(/the per-port form is "ip ospf \.\.\."/, note, 'and points at the per-port spelling');
  ok(/^OSPF area 0$/m.test(out.join('\n')), 'while the global command did take effect');
}

console.log('\nA per-port command does not trigger the note:');
{
  const lab = newLab();
  const out = all(lab, ['enable', 'configure terminal', 'ospf router-id 1.1.1.1',
    'interface Gi0/0', 'ip ospf area 0']);
  ok(!out.some(function (l) { return /^  note:/.test(l); }), 'the per-port form stays in the port');
  match(/OSPF area 0 on Gi0\/0|area set/i, out.join('\n'), 'and it is reported as an interface setting');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
