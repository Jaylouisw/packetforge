'use strict';
// `ping <name>` and `show ip dns` - the resolver the product already had, and the console that refused it (#1375).
//
// `Simulator.ping()` has accepted a hostname since #241: it resolves through the lab's DNS servers, emits a dns
// event, and distinguishes NXDOMAIN from NODATA from SERVFAIL. The console's `ping` refused anything that was not
// an address *before* the engine saw it, so the first command anybody types could not use the resolver. And
// `dns zone` / `dns add` were writable with no way to read a zone back.
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine/topology');
const { Simulator } = require('../engine/simulator');
const dns = require('../engine/dns');
const cliModule = require('../engine/cli');
const CliSession = cliModule.CliSession || cliModule;

let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + msg); }
  else { failed++; console.error('  \u2717 ' + msg + (detail ? '  [' + detail + ']' : '')); }
}
const ROOT = require('path').join(__dirname, '..');
const specs = loadCatalog(ROOT + '/devices').filter(function (s) { return !s.error; });
const ROUTER = specs.find(function (s) { return /^ISR 4331$/.test(s.model); }) ||
  specs.find(function (s) { return /ISR 4331/.test(s.model); });
const HOST = specs.find(function (s) {
  return /^(pc|host|endpoint|workstation)/i.test(s.category || '') && s.model;
}) || specs.find(function (s) { return /linux|ubuntu|debian/i.test((s.category || '') + s.model) && s.model; }) || ROUTER;

function lab(opts) {
  opts = opts || {};
  const t = new Topology();
  t.addDevice(ROUTER, 'r1');
  t.addDevice(HOST, 'h1');
  const hp = Array.from(t.getDevice('h1').interfaces.keys()).filter(function (n) {
    return !/^(mgmt|console|aux)/i.test(n);
  })[0];
  t.connect('r1', 'Gi0/0/1', 'h1', hp, { mediaId: '1000base-t', speedMbps: 1000 });
  const r1p = t.getDevice('r1').interfaces.get('Gi0/0/1');
  r1p.ip = '10.0.0.1'; r1p.mask = '255.255.255.0';
  const h = t.getDevice('h1').interfaces.get(hp);
  h.ip = '10.0.0.50'; h.mask = '255.255.255.0';
  t.getDevice('h1').config.defaultGateway = '10.0.0.1';

  const rs = new CliSession(t.getDevice('r1'), t, null);
  ['enable', 'configure terminal'].concat(opts.zone || ['dns zone lab', 'dns add r1 A 10.0.0.1',
    'dns add www A 10.0.0.50', 'dns add alias CNAME www.lab', 'dns add only-txt TXT hello']).forEach(function (c) {
    rs.run(c);
  });
  rs.run('exit');
  if (opts.noServer) t.getDevice('r1').config.dnsZones = [];
  if (!opts.noResolver) {
    const hs = new CliSession(t.getDevice('h1'), t, null);
    hs.run('enable'); hs.run('configure terminal'); hs.run('ip name-server 10.0.0.1');
  }
  return t;
}
function show(t, id, sim, cmd) {
  return ((new CliSession(t.getDevice(id), t, sim).run(cmd) || {}).output || []).join('\n');
}

console.log('');
console.log('ping takes a name, and says how it resolved:');
{
  const t = lab();
  const sim = new Simulator(t);
  const text = show(t, 'h1', sim, 'ping r1.lab');
  ok(/Translating "r1\.lab"\.\.\.domain server \(10\.0\.0\.1\) \[OK\]/.test(text),
    'the translation names the server that answered, by address', text.split('\n')[1]);
  ok(/r1\.lab -> 10\.0\.0\.1/.test(text), 'and the address it resolved to', text);
  ok(/Success rate is 100 percent \(4\/4\)/.test(text), 'and the ping actually happens', text);
  ok(/Reply from 10\.0\.0\.1/.test(text), 'replies name the address, not the name');

  // A CNAME resolves to its target's address through the engine, and the console prints what came back.
  const cname = show(t, 'h1', sim, 'ping alias.lab');
  ok(/alias\.lab -> 10\.0\.0\.50/.test(cname), 'a CNAME chain resolves to the target address', cname);

  // An address still works, and prints no translation.
  const byIp = show(t, 'h1', sim, 'ping 10.0.0.1');
  ok(!/Translating/.test(byIp), 'an address is not translated');
  ok(/Success rate is 100 percent/.test(byIp), 'and still pings');
}

console.log('');
console.log('Each way a name can fail is named, and nothing is sent:');
{
  const t = lab();
  const sim = new Simulator(t);

  const nx = show(t, 'h1', sim, 'ping nope.lab');
  ok(/% Could not resolve "nope\.lab": NXDOMAIN/.test(nx), 'a name in no zone is NXDOMAIN', nx);
  ok(/no zone any server here hosts contains that name/.test(nx), 'with the reason spelled out');
  ok(/Nothing was sent/.test(nx), 'and an explicit statement that no packet went anywhere');
  ok(!/Sending /.test(nx), 'no echo was attempted');

  const nodata = show(t, 'h1', sim, 'ping only-txt.lab');
  ok(/% Could not resolve "only-txt\.lab": NODATA/.test(nodata),
    'a name that exists without an A record is NODATA, not NXDOMAIN', nodata);
  ok(/has no A record/.test(nodata), 'and the difference is explained');
  ok(/dns add only-txt\.lab A/.test(nodata), 'with the command that would fix it');

  const noServer = lab({ noServer: true });
  const servfail = show(noServer, 'h1', new Simulator(noServer), 'ping r1.lab');
  ok(/SERVFAIL/.test(servfail), 'a lab with no DNS server at all is SERVFAIL', servfail);
  ok(/no device in this lab hosts a DNS zone/.test(servfail), 'and says so');

  // A malformed address is a typo, not a name to look up.
  const bad = show(t, 'h1', sim, 'ping 10.0.0.999');
  ok(/Invalid ping target: 10\.0\.0\.999/.test(bad), 'a malformed address is refused as an address', bad);
  ok(/not a name that could resolve/.test(bad), 'and not looked up as a name');
}

console.log('');
console.log('show ip dns reads the zones back:');
{
  const t = lab();
  const sim = new Simulator(t);
  const text = show(t, 'r1', sim, 'show ip dns');
  ok(/Zone lab \(default TTL 3600\)/.test(text), 'the zone is named with its default TTL', text.split('\n')[0]);
  ok(/r1\.lab\s+3600\s+IN A\s+10\.0\.0\.1/.test(text), 'an A record is printed in zone-file shape', text);
  ok(/alias\.lab\s+3600\s+IN CNAME\s+www\.lab/.test(text), 'a CNAME too');
  ok(/Name servers this device asks: none configured/.test(text),
    'with no resolver list it says lookups fall back to any server in the lab', text);
  ok(/falls back to any server in the lab/.test(text), 'naming the fallback the engine actually uses');

  // Every A record printed must be what the engine resolves that name to - the page is a claim, so check it.
  const zone = t.getDevice('r1').config.dnsZones.filter(function (z) { return z.name === 'lab'; })[0];
  const printed = text.split('\n').filter(function (l) { return /IN A/.test(l); });
  let agree = 0;
  for (const line of printed) {
    const name = line.trim().split(/\s+/)[0];
    const addr = line.trim().split(/\s+/).pop();
    const res = dns.resolve(zone, name, 'A');
    const got = (res.answers || []).filter(function (a) { return a.type === 'A'; })[0];
    if (got && (got.value === addr || got.address === addr)) agree++;
  }
  ok(printed.length > 0 && agree === printed.length,
    'every printed A record is the address the engine resolves for that name',
    agree + '/' + printed.length);

  const one = show(t, 'r1', sim, 'show ip dns zone lab');
  ok(/Zone lab/.test(one) && !/NOT answered/.test(one), 'one zone can be asked for on its own', one.split('\n')[0]);
  const unknown = show(t, 'r1', sim, 'show ip dns zone example.com');
  ok(/No DNS zone example\.com/.test(unknown), 'an unknown zone is reported', unknown);
  ok(/zones here: lab/.test(unknown), 'and the zones that exist are listed');

  const usage = show(t, 'r1', sim, 'show ip dns bogus');
  ok(/Usage: show ip dns/.test(usage), 'an unknown subcommand gets the usage line', usage);
}

console.log('');
console.log('A device that is not a server, and a zone the server would refuse:');
{
  const t = lab({ noServer: true });
  const none = show(t, 'r1', new Simulator(t), 'show ip dns');
  ok(/not a DNS server/.test(none), 'no zones means it is not a server, and it says so', none);
  ok(/dns zone/.test(none), 'naming the command that would make it one');

  // A record the engine would refuse to answer for is marked, not printed as if it were live.
  const t2 = lab({ zone: ['dns zone lab', 'dns add r1 A 10.0.0.1', 'dns add bad AAAA not-an-address'] });
  const broken = show(t2, 'r1', new Simulator(t2), 'show ip dns zone lab');
  ok(/NOT answered/.test(broken), 'a zone with an unusable record says it is not answered', broken);
  ok(/AAAA|record type|value/i.test(broken), 'and names the record and the reason');
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
