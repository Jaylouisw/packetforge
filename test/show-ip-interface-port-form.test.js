'use strict';
// `show ip interface <port>` is the box's own syntax, and this console called it invalid (#fidelity).
//
// The vendor syntax is `show ip interface [type number] [brief]` (Cisco IOS Interface and Hardware Component
// Command Reference, `show ip interface`), and a 6500 capture prints `Router# show ip interface vlan 1` over
// `Vlan1 is up, line protocol is up` / `Internet address is 10.6.58.4/24`. This console aliased the bare
// `show ip interface` to its interface detail view but not the port form, so `show ip interface Gi0/0` answered
// `% Invalid show command: ip interface Gi0/0` - the sentence a misspelt view gets, about a view the console
// prints and a port it knows.
//
// The alias now answers the port form and a tail word; `brief` keeps its own door. research/
// show-ip-interface-port-form.md holds the captures and what is still open (the IP-characteristics block itself).
const path = require('path');
const { Topology, Simulator } = require('../engine');
const { CliSession } = require('../engine/cli');
const { loadCatalog } = require('../devices/registry');
const { displayName } = require('../engine/iface-name');

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}

const catalog = loadCatalog(path.join(__dirname, '..', 'devices')).filter(function (s) { return !s.error; });
function spec(re) {
  const s = catalog.filter(function (x) { return re.test(x.model); })[0];
  if (!s) throw new Error('spec not found: ' + re);
  return s;
}

function lab(specOf) {
  const t = new Topology();
  const d = t.addDevice(specOf, 'R1');
  const sim = new Simulator(t);
  const cli = new CliSession(d, t, sim);
  return { t: t, dev: d, sim: sim, cli: cli };
}

// A router with one addressed port.
const r = lab(spec(/ASR 1001-X/));
const eth = [...r.dev.interfaces.values()].filter(function (i) {
  return i.type === 'ethernet' && i.name.indexOf('/') !== -1;
})[0];
r.cli.run('configure terminal');
r.cli.run('hostname R1');
r.cli.run('interface ' + eth.name);
r.cli.run('ip address 10.0.0.1 255.255.255.0');
r.cli.run('end');

const portBlock = r.cli.run('show interfaces ' + eth.name).output;
const ipPortBlock = r.cli.run('show ip interface ' + eth.name).output;

ok(ipPortBlock.join('\n') === portBlock.join('\n'),
  'show ip interface <port> prints the same per-port block show interfaces <port> does',
  JSON.stringify(ipPortBlock.slice(0, 2)));
ok(ipPortBlock.some(function (l) { return l.indexOf('ip: 10.0.0.1/24') !== -1; }),
  'the block names the port\'s address');
ok(ipPortBlock[0].indexOf(eth.name) === 0,
  'the block opens with the port the operator named', ipPortBlock[0]);
ok(ipPortBlock.join('\n').indexOf('Invalid show command') === -1,
  'the port form is not called an invalid command any more');

// The spelled-out type word resolves to the same port.
const spelled = r.cli.run('show ip interface ' + displayName(eth.name)).output;
ok(spelled.join('\n') === portBlock.join('\n'),
  'the spelled-out type word (' + displayName(eth.name) + ') reaches the same port',
  JSON.stringify(spelled.slice(0, 1)));

// An unknown port gets the console's missing-port sentence, not the typo sentence.
const gone = r.cli.run('show ip interface Gi9/99').output.join('\n');
ok(/% No interface Gi9\/99 on /.test(gone),
  'an unknown port gets the missing-port sentence', gone);
ok(gone.indexOf('Invalid show command') === -1,
  'and not the invalid-command sentence', gone);

// The bare form and `brief` are unchanged.
const bare = r.cli.run('show ip interface').output;
ok(bare.length > portBlock.length,
  'the bare form still prints every port, not one', String(bare.length));
const brief = r.cli.run('show ip interface brief').output;
ok(/^Interface\s+IP-Address\s+OK\?\s+Method\s+Status\s+Protocol/.test(brief[0]),
  'show ip interface brief is still the one-line-per-port table', brief[0]);
ok(brief.join('\n').indexOf('status:') === -1,
  'the brief table is not the detail block', brief[1]);
const briefPort = r.cli.run('show ip interface brief ' + eth.name).output.join('\n');
ok(briefPort.indexOf('% show ip interface brief does not take') === 0,
  'show ip interface brief <port> keeps its own refusal, naming its own command', briefPort);

// A tail word after the port is answered by the detail view, in its own words.
const tail = r.cli.run('show ip interface ' + eth.name + ' counters').output.join('\n');
ok(tail.indexOf('Invalid show command') === -1,
  'a tail word after the port is not called an invalid command', tail);
ok(tail.indexOf('counters') !== -1 && tail.indexOf('show interfaces ' + eth.name) !== -1,
  'the tail-word answer points at the per-port view that does print counters', tail);

// The index key after the view names the detail view, not an invalid command.
const key = r.cli.run('show ip interface ?').output.join('\n');
ok(key.indexOf('`show interfaces` lists every port') !== -1,
  '? after the view names the detail view\'s usage', key);
ok(key.indexOf('Invalid show command') === -1,
  '? is not answered as an invalid command', key);

// A switch answers with its own block, switchport line included.
const sw = lab(spec(/Catalyst2960/));
const fa = [...sw.dev.interfaces.values()].filter(function (i) { return i.type === 'ethernet'; })[0];
const swBlock = sw.cli.run('show ip interface ' + fa.name).output.join('\n');
ok(swBlock.indexOf('switchport:') !== -1,
  'a switch port answers with its switchport line', swBlock);
ok(swBlock === sw.cli.run('show interfaces ' + fa.name).output.join('\n'),
  'and it is the same block show interfaces prints for that port');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
