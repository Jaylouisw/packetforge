'use strict';
// `show running-config` has to be a config you can paste back (#1230).
//
// It was not. The printer wrote `interface <name>` blocks back to back with no `exit`, so a reader
// never left interface mode: every line after the first block was parsed as an interface command, and
// the paste *silently applied the config to the wrong port* - an address meant for Gi0/0/0 and a
// shutdown meant for Gi0/0/1 both landed on the first interface. On top of that the printer's own
// first line, `! PacketForge running-config`, was rejected as an unrecognised command.
//
// The properties asserted here:
//   * a config pasted from `show running-config` reproduces itself, on the same ports;
//   * a config copied out BEFORE the fix (no `exit` between blocks) still replays;
//   * comment lines are comments, in every mode;
//   * `interface <name>` inside interface mode switches interface, as every CLI does;
//   * across the catalogue, no model's own running-config is rejected when read back.
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

function configureRouting(s) {
  s.run([
    'enable', 'configure terminal',
    'hostname EDGE-1',
    'ip route 0.0.0.0 0.0.0.0 10.1.2.1',
    'interface Gi0/0/0', 'ip address 10.1.2.3 255.255.255.0', 'exit',
    'interface Gi0/0/1', 'shutdown', 'exit',
    'end'
  ]);
}

function runningConfig(s) { return s.run(['show running-config']); }
function rejections(lines) { return lines.filter(function (l) { return /^%/.test(l); }); }

console.log('');
console.log('A running-config pasted back reproduces itself:');
{
  const a = session(spec(/ASR 1001-X/));
  configureRouting(a);
  const rc = runningConfig(a);

  ok(rc.some(function (l) { return l === 'exit'; }), 'the printer closes each interface block with exit');
  ok(!/undefined/.test(rc.join('\n')), 'and never prints undefined');

  const b = session(spec(/ASR 1001-X/));
  // The whole output, header comment included - which is what "copy the config" means.
  const replayOut = b.run(['enable', 'configure terminal'].concat(rc).concat(['end']));
  ok(rejections(replayOut).length === 0, 'no line is rejected on the way back in',
    JSON.stringify(rejections(replayOut).slice(0, 3)));

  const rc2 = runningConfig(b);
  ok(rc.join('\n') === rc2.join('\n'), 'and the running-config is byte-identical afterwards');

  // The failure this was written for: config landing on the wrong interface.
  ok(b.dev.interfaces.get('Gi0/0/0').ip === '10.1.2.3',
    'the address is on the interface it was configured on',
    String(b.dev.interfaces.get('Gi0/0/0').ip));
  const down = [...b.dev.interfaces.values()].filter(function (i) { return !i.enabled; }).map(function (i) { return i.name; });
  ok(down.length === 1 && down[0] === 'Gi0/0/1', 'and the shutdown is on the interface it was configured on', down.join(','));
  ok(b.dev.config.routes.length === 1, 'the static route survived', String(b.dev.config.routes.length));
  ok(!a.dev.interfaces.get('Gi0').ip, 'nothing was applied to the parent interface instead');
}

console.log('');
console.log('A config copied out before the fix still replays:');
{
  // Every config a user copied before #1230 is block-after-block with no `exit`. If the parser only
  // accepted the corrected shape, this fix would invalidate the very backups people already have.
  const a = session(spec(/ASR 1001-X/));
  configureRouting(a);
  const oldShape = runningConfig(a).filter(function (l) { return l !== 'exit'; });
  ok(oldShape.some(function (l) { return /^interface /.test(l); }), 'the old shape still has interface blocks');

  const b = session(spec(/ASR 1001-X/));
  const replayOut = b.run(['enable', 'configure terminal'].concat(oldShape).concat(['end']));
  ok(rejections(replayOut).length === 0, 'it is accepted without a single complaint',
    JSON.stringify(rejections(replayOut).slice(0, 3)));
  ok(b.dev.interfaces.get('Gi0/0/0').ip === '10.1.2.3', 'with the address on the right interface');
  const down = [...b.dev.interfaces.values()].filter(function (i) { return !i.enabled; }).map(function (i) { return i.name; });
  ok(down.length === 1 && down[0] === 'Gi0/0/1', 'and the shutdown on the right interface', down.join(','));
  ok(b.dev.config.routes.length === 1, 'and the global section after the last block was applied');
}

console.log('');
console.log('Comments are comments, and interface mode switches:');
{
  const s = session(spec(/ASR 1001-X/));
  ok(s.run(['! a comment']).length === 0, 'a comment at the exec prompt prints nothing');
  s.run(['enable', 'configure terminal']);
  ok(s.run(['! PacketForge running-config']).length === 0, 'a comment in config mode prints nothing');
  s.run(['interface Gi0/0/0']);
  ok(s.run(['# hash comment too']).length === 0, 'a hash comment in interface mode prints nothing');

  const switched = s.run(['interface Gi0/0/1']);
  ok(rejections(switched).length === 0, 'a new interface line inside interface mode is not an error',
    JSON.stringify(switched));
  s.run(['shutdown', 'exit', 'end']);
  ok(!s.dev.interfaces.get('Gi0/0/1').enabled, 'and the following command applies to the new interface');
  ok(s.dev.interfaces.get('Gi0/0/0').enabled, 'leaving the previous one alone');

  const bogus = s.run(['enable', 'configure terminal', 'interface nosuchport']);
  ok(rejections(bogus).length === 1, 'an interface that does not exist is still refused', JSON.stringify(bogus));
}

console.log('');
console.log('No model in the catalogue rejects its own running-config:');
{
  // Seed the same shape directly - an address on one port, a route, a description - then print and
  // read back. This is the sweep that found the bug, kept as a guard so it cannot come back.
  const problems = [];
  let checked = 0;
  for (const s of catalog) {
    let dev;
    try { dev = new Device('d1', s); } catch (e) { continue; }
    const ports = [...dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet' && !i.parent; });
    if (!ports.length) continue;
    ports[0].ip = '10.9.8.7';
    ports[0].mask = '255.255.255.0';
    ports[0].description = 'seeded by the round-trip test';
    dev.config = dev.config || {};
    dev.config.routes = [{ dest: '0.0.0.0', mask: '0.0.0.0', gw: '10.9.8.1', iface: null }];
    if (ports[1]) ports[1].enabled = false;

    const a = new CliSession(dev, null, null);
    const rc = (a.run('show running-config').output || []).map(String).filter(function (l) { return !/^!/.test(l); });
    if (!rc.length) continue;
    checked++;

    let fresh;
    try { fresh = new Device('d2', s); } catch (e) { problems.push(s.vendor + '/' + s.model + ': fresh device threw'); continue; }
    const b = new CliSession(fresh, null, null);
    const out = [];
    for (const c of ['enable', 'configure terminal'].concat(rc).concat(['end'])) {
      const r = b.run(c);
      for (const l of ((r && r.output) || [])) out.push(String(l));
    }
    const bad = rejections(out);
    if (bad.length) { problems.push(s.vendor + '/' + s.model + ': ' + bad[0]); continue; }
    const rc2 = (b.run('show running-config').output || []).map(String).filter(function (l) { return !/^!/.test(l); });
    if (rc.join('\n') !== rc2.join('\n')) {
      let i = 0;
      while (i < rc.length && i < rc2.length && rc[i] === rc2[i]) i++;
      problems.push(s.vendor + '/' + s.model + ': differs at ' + i + ' (' + JSON.stringify(rc[i]) + ' vs ' + JSON.stringify(rc2[i]) + ')');
    }
  }
  ok(checked > 1000, 'the sweep covered the catalogue (' + checked + ' models)');
  ok(problems.length === 0, 'every model accepts its own running-config back',
    problems.slice(0, 4).join(' | '));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
