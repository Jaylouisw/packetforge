'use strict';
// `show ip <view>` - the spellings IOS taught, on a console that has the views under other names (#1447).
//
// Thirty years of IOS put `show ip arp`, `show ip interface`, `show ip access-lists` and `show ip vrrp` in operators'
// fingers. Every one of them answered `% Invalid show command: ip arp` on this console, which has `show arp` printing
// the same rows from the same table. A refusal that says only "invalid" tells a reader nothing except that they guessed
// the wrong word.
//
// So: a spelling whose view exists under another name is *rewritten* to that view - an alias, not a second
// implementation, so the two spellings cannot drift apart - and a spelling whose view does not exist names the command
// that does answer the question. `show ip` alone lists what there is.
//
// The danger this test is mostly about: `show ip interface brief` is a view of its own, and the obvious way to write the
// alias (map `interface` to `interfaces` whenever it appears) swallows it into `show interfaces brief`, which is not a
// view at all. Only the bare `show ip interface` is aliased.
const path = require('path');
const fs = require('fs');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const eq = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };

const ROOT = path.join(__dirname, '..');
const catalog = loadCatalog(path.join(ROOT, 'devices')).filter(function (s) { return !s.error; });
function spec(model) { return catalog.filter(function (s) { return s.model === model; })[0]; }
const SWITCH = spec('generic-switch'), PC = spec('generic-pc'), ROUTER = spec('ISR 4331');

// A switch with two hosts that have talked, so `show arp` has a row and "answers" is distinguishable from "empty".
function lab(model) {
  const t = new Topology();
  const kind = model === 'switch' ? SWITCH : ROUTER;
  t.addDevice(kind, 'x1');
  const sessions = {};
  const cli = function (id) {
    if (!sessions[id]) sessions[id] = new CliSession(t.getDevice(id), t, sim);
    return sessions[id];
  };
  const sim = new Simulator(t);
  let talked = false;
  if (model === 'switch') {
    t.addDevice(PC, 'a'); t.addDevice(PC, 'b');
    t.connect('a', 'eth0', 'x1', 'Fa0/1');
    t.connect('b', 'eth0', 'x1', 'Fa0/2');
    [['a', '10.7.0.1'], ['b', '10.7.0.2']].forEach(function (pair) {
      cli(pair[0]).run('configure terminal'); cli(pair[0]).run('interface eth0');
      cli(pair[0]).run('ip address ' + pair[1] + ' 255.255.255.0'); cli(pair[0]).run('end');
    });
    talked = sim.ping('a', '10.7.0.2', { count: 2 }).replies.every(function (r) { return r.success; });
  } else {
    const port = [...t.getDevice('x1').interfaces.keys()][0];
    t.addDevice(PC, 'a');
    t.connect('x1', port, 'a', 'eth0');
    cli('x1').run('configure terminal'); cli('x1').run('interface ' + port);
    cli('x1').run('ip address 10.8.0.1 255.255.255.0'); cli('x1').run('no shutdown'); cli('x1').run('end');
    cli('a').run('configure terminal'); cli('a').run('interface eth0');
    cli('a').run('ip address 10.8.0.5 255.255.255.0'); cli('a').run('end');
    talked = sim.ping('a', '10.8.0.1', { count: 2 }).replies.every(function (r) { return r.success; });
  }
  return { t: t, sim: sim, cli: cli, talked: talked };
}

const sw = lab('switch');
const rt = lab('router');
const run = function (L, cmd) { return L.cli('x1').run(cmd).output; };
const isInvalid = function (lines) { return lines.some(function (l) { return /Invalid show command/.test(l); }); };

// The tables, read from the source, so a new alias cannot be added without this test noticing.
const SRC = fs.readFileSync(path.join(ROOT, 'engine', 'cli.js'), 'utf8');
const aliasBlock = SRC.slice(SRC.indexOf('const SHOW_IP_ALIASES'), SRC.indexOf('const SHOW_IP_BARE_ALIASES'));
const ALIASES = [...aliasBlock.matchAll(/^\s+'?([a-z-]+)'?:/gm)].map(function (m) { return m[1]; });
const ALIAS_VALUES = [...aliasBlock.matchAll(/:\s+'([a-z-]+)'/g)].map(function (m) { return m[1]; });
const bareBlock = SRC.slice(SRC.indexOf('const SHOW_IP_BARE_ALIASES'), SRC.indexOf('function showIpUsage'));
const BARE = [...bareBlock.matchAll(/([a-z-]+):/g)].map(function (m) { return m[1]; });

console.log('');
console.log('The lab behind these checks actually resolved its neighbours:');
ok(sw.talked, 'the switch lab pinged, so `show arp` has a row to print');
ok(rt.talked, 'the router lab pinged too');

console.log('');
console.log('A spelling whose view exists is the same view, not a near copy:');
{
  ALIASES.forEach(function (word) {
    const aliased = run(sw, 'show ip ' + word);
    const real = run(sw, 'show ' + ALIAS_VALUES[ALIASES.indexOf(word)]);
    ok(!isInvalid(aliased), '`show ip ' + word + '` is answered', aliased.join(' | '));
    ok(eq(aliased, real), 'and prints exactly what `show ' + ALIAS_VALUES[ALIASES.indexOf(word)] + '` prints',
      JSON.stringify(aliased) + ' vs ' + JSON.stringify(real));
  });
  // An L2 switch has no IP interface, so its own cache is empty and the rows live on the hosts: the router is the box
  // where a non-empty `show arp` can be asked for, and where "the alias read the table" is testable.
  ok(run(rt, 'show ip arp').length > 1, '`show ip arp` on a router has the resolved neighbour in it',
    JSON.stringify(run(rt, 'show ip arp')));
  ok(eq(run(rt, 'show ip arp'), run(rt, 'show arp')), 'and reads exactly the rows `show arp` reads');
}

console.log('');
console.log('An argument is carried through, so the reader gets the useful refusal:');
{
  ok(eq(run(sw, 'show ip arp 10.7.0.2'), run(sw, 'show arp 10.7.0.2')), '`show ip arp <address>` answers as `show arp <address>`');
  const why = run(sw, 'show ip arp 10.7.0.2').join(' ');
  ok(/whole cache is listed/.test(why), 'and that answer is the sentence that says where the neighbour is', why);
}

console.log('');
console.log('The two-token form is the only one rewritten:');
{
  ok(eq(run(sw, 'show ip interface'), run(sw, 'show interfaces')), '`show ip interface` prints the per-port detail');
  const brief = run(sw, 'show ip interface brief');
  ok(!isInvalid(brief), '`show ip interface brief` still works', brief.join(' | '));
  ok(!eq(brief, run(sw, 'show interfaces')) && brief.length > 1,
    'and is still the one-line-per-port view, not the detail view');
  ok(/^Interface\s+IP-Address/.test(brief[0]), 'with its own header', brief[0]);
  ['show ip interface brief', 'show ip ospf neighbor', 'show ip bgp summary', 'show ip nat translations',
    'show ip dhcp binding', 'show ip dhcp pool', 'show ip dns', 'show ip route'].forEach(function (cmd) {
    ok(!isInvalid(run(sw, cmd)), '`' + cmd + '` keeps its own door', run(sw, cmd).join(' | '));
  });
}

console.log('');
console.log('A spelling with no view names the command that answers the question, and it runs:');
{
  ['protocols', 'traffic'].forEach(function (word) {
    const out = run(rt, 'show ip ' + word);
    ok(isInvalid(out) || /%/.test(out[0]), '`show ip ' + word + '` is refused', out.join(' | '));
    const named = [...out.join('\n').matchAll(/`([^`]+)`/g)].map(function (m) { return m[1]; });
    ok(named.length > 0, 'and the refusal names at least one command', out[0]);
    named.forEach(function (cmd) {
      const answer = run(rt, cmd.replace('<port>', [...rt.t.getDevice('x1').interfaces.keys()][0]));
      ok(!isInvalid(answer), 'the command it names (`' + cmd + '`) answers', answer.join(' | '));
    });
    ok(/not a view here/.test(out[0]), 'and says plainly that the spelling is not a view here', out[0]);
  });
}

console.log('');
console.log('`show ip` alone lists what there is, and every word it lists works:');
{
  ['show ip', 'show ip ?'].forEach(function (cmd) {
    const out = run(sw, cmd);
    ok(!isInvalid(out), '`' + cmd + '` is not "invalid"', out.join(' | '));
    ok(/needs a view/.test(out.join(' ')), 'it asks for a view instead', out.join(' | '));
    const text = out.join(' ');
    ALIASES.concat(BARE).forEach(function (word) {
      ok(text.indexOf(word) !== -1, 'the usage names `' + word + '`', text);
    });
    ok(/help/.test(text), 'and points at `help` for the rest', text.slice(0, 120));
  });
  // The words the usage promises under their own names are the ones `show <word>` really has.
  ALIAS_VALUES.concat(['interfaces']).forEach(function (view) {
    ok(!isInvalid(run(sw, 'show ' + view)), '`show ' + view + '` is a command the usage is right to promise',
      run(sw, 'show ' + view).join(' | '));
  });
}

console.log('');
console.log('`show interfaces brief` is a view too, and points at the view that has it:');
{
  const out = run(sw, 'show interfaces brief');
  ok(/is a view, not a port/.test(out[0]), 'it says it is a view', out[0]);
  ok(/show ip interface brief/.test(out[0]), 'and names the command that holds it', out[0]);
  const named = [...out[0].matchAll(/`([^`]+)`/g)].map(function (m) { return m[1]; });
  named.forEach(function (cmd) {
    ok(!isInvalid(run(sw, cmd)), 'the command it names (`' + cmd + '`) answers', run(sw, cmd).join(' | '));
  });
}

console.log('');
console.log('The redirect happens before any other `show` branch sees the tokens:');
{
  const showAt = SRC.indexOf('  _show(tokens) {');
  const body = SRC.slice(showAt, SRC.indexOf('\n  }', showAt + 200));
  const redirectAt = body.indexOf('_showIpRedirect(tokens)');
  const firstBranchAt = body.indexOf('if (what ===');
  ok(redirectAt !== -1, '`_show` asks the redirect');
  ok(redirectAt < firstBranchAt, 'before the first branch', 'redirect@' + redirectAt + ' branch@' + firstBranchAt);
  ok(/let what|const what/.test(body.slice(redirectAt)), 'and the branch reads the tokens the redirect settled on');
  ok(/rewrite/.test(SRC) && /lines/.test(SRC), 'the redirect distinguishes a rewrite from an answer');
}

console.log('');
console.log('Nothing else about `show arp` changed:');
{
  const plain = run(rt, 'show arp');
  ok(/^Protocol\s+Address/.test(plain[0]), 'the header is the same', plain[0]);
  ok(plain.length > 1, 'and the row is still there', JSON.stringify(plain));
  ok(/^%/.test(run(rt, 'show arp nonsense extra')[0]), 'an argument `show arp` refuses is still refused',
    run(rt, 'show arp nonsense extra')[0]);
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
