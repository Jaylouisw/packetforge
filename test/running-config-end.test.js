'use strict';
// What closes a Cisco configuration file, and what the closing line does when the file is pasted back.
//
// A real `show running-config` ends with `end` - the config file carries the exit from configuration mode.
// Two Cisco samples, a decade apart, agree on the last line and disagree on how many bare `!` lines sit above
// it (one in the IOS 11.2 command reference, two in the ISR 4400 guide), so only `end` is adopted here.
//
// PacketForge's printer stopped at the last configured value. The output was still replayable, but a pasted
// backup left the session at `(config)#` - the paste had finished and nothing said so - and the console
// answered `end` typed at privileged EXEC (the mode a paste usually starts from) with
// `% Unrecognized command: end`, an error out of the one line that is supposed to close the file.
//
// Evidence: research/running-config-end.md.
const path = require('path');
const { Device } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(re) { return catalog.filter(function (s) { return re.test(s.model || ''); })[0]; }
const ROUTER = spec(/ASR 1001-X/);

function session(deviceSpec) {
  const dev = new Device('d1', deviceSpec);
  const cli = new CliSession(dev, null, null);
  return {
    dev: dev,
    cli: cli,
    run: function (cmds) {
      const out = [];
      for (const c of cmds) {
        let r;
        try { r = cli.run(c); } catch (e) { out.push('% EXCEPTION: ' + e.message); continue; }
        for (const l of ((r && r.output) || [])) out.push(String(l));
      }
      return out;
    }
  };
}
function config(s) { return s.run(['show running-config']); }
function rejections(lines) { return lines.filter(function (l) { return /^%/.test(l); }); }

function configure(s) {
  s.run(['enable', 'configure terminal',
    'hostname EDGE-1',
    'ip route 0.0.0.0 0.0.0.0 10.1.2.1',
    'interface Gi0/0/0', 'ip address 10.1.2.3 255.255.255.0', 'exit',
    'interface Gi0/0/1', 'shutdown', 'exit',
    'end']);
}

console.log('');
console.log('A configuration file ends with `end`:');
{
  const router = session(ROUTER);
  const fresh = config(router);
  ok(fresh[fresh.length - 1] === 'end', 'an unconfigured router still ends its file with end',
    JSON.stringify(fresh[fresh.length - 1]));
  ok(fresh.filter(function (l) { return l === 'end'; }).length === 1,
    'and it appears once, not once per section');

  configure(router);
  const rc = config(router);
  ok(rc[rc.length - 1] === 'end', 'a configured router ends with end too', JSON.stringify(rc[rc.length - 1]));
  ok(rc.filter(function (l) { return l === 'end'; }).length === 1, 'exactly one end line',
    String(rc.filter(function (l) { return l === 'end'; }).length));
  ok(rc.indexOf('ip route 0.0.0.0 0.0.0.0 10.1.2.1') < rc.indexOf('end'),
    'and it comes after the last configured line');
  // The terminator is not state: printing the file twice is the same file twice.
  ok(rc.join('\n') === config(router).join('\n'), 'so the file is stable when it is printed again');
}

console.log('');
console.log('A paste of the file closes itself:');
{
  const a = session(ROUTER);
  configure(a);
  const rc = config(a);

  const b = session(ROUTER);
  // Exactly what "copy the config and paste it" is: the whole output, header comment included.
  const replay = b.run(['enable', 'configure terminal'].concat(rc));
  ok(rejections(replay).length === 0, 'no line of the file is rejected on the way back in',
    JSON.stringify(rejections(replay).slice(0, 3)));
  ok(b.cli.prompt() === 'EDGE-1#',
    'and the session is back at privileged EXEC when the file runs out, not stuck at (config)#',
    b.cli.prompt());
  ok(config(b).join('\n') === rc.join('\n'), 'the configuration it restores is the one it printed');

  // The mode a paste usually starts from is already privileged EXEC. On a box that is a no-op rather than
  // an error; here it used to be the only rejected line in the file.
  const typed = b.run(['end']);
  ok(typed.length === 0, 'end typed at privileged EXEC is accepted and silent', JSON.stringify(typed));
  ok(b.cli.prompt() === 'EDGE-1#', 'leaving the prompt where it was', b.cli.prompt());
}

console.log('');
console.log('When the last block in the file is an interface:');
{
  const r = session(ROUTER);
  r.run(['enable', 'configure terminal', 'hostname R2', 'interface Gi0/0/1',
    'ip address 10.9.9.1 255.255.255.0', 'shutdown', 'exit', 'end']);
  const rc = config(r);
  ok(rc[rc.length - 1] === 'end', 'the file still ends with end', JSON.stringify(rc[rc.length - 1]));
  ok(rc[rc.length - 2] === '!', 'directly under the `!` that closes the interface block',
    JSON.stringify(rc.slice(-4)));
  ok(/^interface /.test(rc[rc.length - 3]), 'and under the header of the last block, which `!` closes',
    JSON.stringify(rc.slice(-4)));
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
