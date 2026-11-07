'use strict';
// audit-port-types.js -- connector / port-type coherence audit.
//
// audit-devices.js asks whether a port can be cabled at all. This asks a
// sharper question: does the port's PHYSICAL CAGE agree with what the spec
// says the port IS?
//
// The engine resolves a cage from an explicit `cage` / `connector`, otherwise
// from the port name, type and speed (engine/media.js -> inferCage). Those two
// sources can disagree. When they do, the GUI draws the wrong hardware (a PtP
// radio rendered as a fibre socket) and the link layer will happily accept a
// cable that cannot exist in the field (a patch lead into an antenna).
//
// Usage: node scripts/audit-port-types.js [--json] [--quiet]
// Exit:   0 = no contradictions, 1 = at least one found (CI gate).
const path = require('path');
const { loadCatalog } = require('../devices/registry');
const { Topology } = require('../engine');

// Human-facing names for the type families we police.
const TYPE_LABEL = {
  wireless: 'wireless radio',
  radio: 'wireless radio',
  console: 'console',
  coax: 'coax',
  dsl: 'DSL line',
  powerline: 'powerline',
  pon: 'PON subscriber port',
  ethernet: 'ethernet'
};

// Cages that are legitimately fibre-bearing. Used for the cross-family rule.
const FIBRE_CAGES = [
  'sfp', 'sfp+', 'sfp28', 'qsfp+', 'qsfp28', 'qsfpdd',
  'sc-apc', 'sc-upc', 'lc-upc', 'lc-apc'
];

// Connectors that are unambiguously a fibre interface. The bare tokens 'lc',
// 'sc' and 'mpo' are medium-level connector names in engine/media.js; specs in
// the wild use them as if they were cages, so they count here too -- that is
// precisely the mistake the audit is looking for.
const FIBRE_CONNECTORS = FIBRE_CAGES.concat(['lc', 'sc', 'mpo', 'mtp']);

// A declared copper connector that must never end up in a fibre cage.
const COPPER_CONNECTORS = ['rj45'];

const PON_CAGES = ['sc-apc', 'sc-upc', 'lc-upc', 'lc-apc'];

// A cage can be named but not modelled (e.g. connector "lc", which is a MEDIUM
// attribute, not a cage). media.derivePortHardware then does
// `CAGES[cage] || CAGES.rj45` and hands back RJ45 copper media with the
// unmodelled string still attached -- so the port *renders and cables* as
// copper while claiming to be fibre. That silent degradation is the defect, so
// the audit compares against the EFFECTIVE cage, not the label.
function isKnownCage(cage) {
  const media = require('../engine/media');
  return Object.prototype.hasOwnProperty.call(media.CAGES, cage);
}

function effectiveCage(cage) {
  return isKnownCage(cage) ? cage : 'rj45';
}

function isFibreConnector(c) { return FIBRE_CONNECTORS.indexOf(c) !== -1; }

function isFibreCage(c) { return FIBRE_CAGES.indexOf(c) !== -1; }

// Severity is about how wrong the model is, not how loud the bug looks.
//   high   - type and cage are different physical media: impossible cabling and
//            a wrong icon, so a student can build a link that cannot exist.
//   medium - same medium family, wrong physical interface: it cables, but the
//            hardware, the connector and often the reach are wrong.
//   low    - internal inconsistency the engine still recovers from.
function severityRank(s) { return s === 'high' ? 0 : s === 'medium' ? 1 : 2; }

// Port names are human-facing ("port2" before "port10"), so compare digit runs
// numerically rather than lexicographically.
function naturalCompare(a, b) {
  const as = String(a).match(/(\d+|\D+)/g) || [];
  const bs = String(b).match(/(\d+|\D+)/g) || [];
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const x = as[i], y = bs[i];
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return as.length - bs.length;
}

// Every rule that can fire on one port. Returns [{ rule, severity, note }].
function checkPort(type, connector, cage) {
  const hits = [];
  const c = connector || '';
  const known = isKnownCage(cage);
  // Compare against what the engine will actually hand out, not the label.
  const eff = effectiveCage(cage);
  const degrade = known ? '' : ' (cage "' + cage + '" is not a modelled cage, so the engine falls back to RJ45 copper)';

  // An unmodelled cage with no fibre connector to explain it: the spec names a
  // connector the engine has never heard of, and the port quietly becomes RJ45.
  if (!known && !(c && isFibreConnector(c))) {
    hits.push({
      rule: 'unknown-cage',
      severity: 'high',
      note: 'resolved cage "' + cage + '" is not modelled by the engine' +
        (c ? ' (declared connector "' + c + '")' : '') +
        '; it presents as RJ45 copper and has no mating rule, so every cable is refused ' +
        'with "Cannot mate RJ45 to RJ45" -- including to another port of the same kind'
    });
  }

  // --- declared type vs resolved cage -------------------------------------
  if (type === 'wireless' || type === 'radio') {
    if (eff !== 'antenna') {
      hits.push({
        rule: 'wireless-not-antenna',
        severity: isFibreCage(eff) || eff === 'rj45' ? 'high' : 'medium',
        note: 'a wireless radio must present an antenna; it resolves to ' + eff + degrade +
          (isFibreCage(eff)
            ? ', so it renders as a fibre socket and can be patched into a switch with a fibre or DAC lead'
            : ', so it renders as a wired socket and can be cabled to copper')
      });
    }
  } else if (type === 'console') {
    if (eff !== 'console') {
      hits.push({
        rule: 'console-not-console',
        severity: 'medium',
        note: 'a console port must present a console (RS-232) cage; it resolves to ' + eff + degrade +
          ', so it can be cabled as a data port instead of only to a terminal'
      });
    }
  } else if (type === 'coax') {
    if (eff !== 'coax') {
      hits.push({
        rule: 'coax-not-coax',
        severity: 'medium',
        note: 'a coax port must present an F-connector; it resolves to ' + eff + degrade +
          ', so a DOCSIS subscriber port is modelled as a data/optical socket'
      });
    }
  } else if (type === 'dsl') {
    if (eff !== 'dsl') {
      hits.push({
        rule: 'dsl-not-dsl',
        severity: 'medium',
        note: 'a DSL port must present an RJ11; it resolves to ' + eff + degrade +
          ', so the line port is modelled as ethernet/optical'
      });
    }
  } else if (type === 'powerline') {
    if (eff !== 'powerline') {
      hits.push({
        rule: 'powerline-not-powerline',
        severity: 'medium',
        note: 'a powerline port must present a mains plug; it resolves to ' + eff + degrade +
          ', so the mains side is modelled as a data/optical socket'
      });
    }
  } else if (type === 'pon') {
    if (PON_CAGES.indexOf(eff) === -1) {
      hits.push({
        rule: 'pon-not-optical-connector',
        severity: isFibreCage(eff) ? 'low' : 'high',
        note: 'a PON port must present an SC or LC subscriber connector; it resolves to ' + eff + degrade +
          (isFibreCage(eff)
            ? ', which is fibre but not a PON connector, so polish and connector shape cannot be checked'
            : ', so a fibre subscriber line is modelled as copper and can be plugged into a switch port')
      });
    }
  } else if (type === 'ethernet') {
    if (eff === 'antenna' || eff === 'console') {
      hits.push({
        rule: 'ethernet-not-data',
        severity: 'high',
        note: 'an ethernet port must present a data cage; it resolves to ' + eff + degrade +
          (eff === 'antenna'
            ? ', so a wired port renders as a radio and can only be "cabled" to another radio'
            : ', so a data port is modelled as a terminal lead and cannot join a LAN')
      });
    }
  }

  // --- declared connector vs resolved cage --------------------------------
  // The engine lets an explicit connector define the cage, so a known cage can
  // only disagree with the connector when the spec also sets `cage` (or a
  // hardware block) explicitly. An unmodelled fibre connector is the other way
  // in: the declaration is fibre, the resolved hardware is copper.
  if (c && isFibreConnector(c) && eff === 'rj45') {
    hits.push({
      rule: 'fibre-connector-copper-cage',
      severity: 'high',
      note: known
        ? 'declares fibre connector "' + c + '" but resolves to an RJ45 cage, so the port renders as copper ' +
          'and a patch lead mates with it'
        : 'declares fibre connector "' + c + '" but "' + c + '" is not a modelled cage: the port presents as ' +
          'RJ45 copper, advertises 10GBASE-T media, and then refuses every cable (including its own kind) with ' +
          '"Cannot mate RJ45 to RJ45"'
    });
  }
  if (c && COPPER_CONNECTORS.indexOf(c) !== -1 && isFibreCage(eff)) {
    hits.push({
      rule: 'copper-connector-fibre-cage',
      severity: 'high',
      note: 'declares copper connector "' + c + '" but resolves to a ' + eff + ' fibre cage, so an optical ' +
        'port accepts RJ45 copper cabling'
    });
  }

  return hits;
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.indexOf('--json') !== -1;
  const quiet = argv.indexOf('--quiet') !== -1;

  // --out <path>  write the raw document (generatedAt + offenders) for the
  // research pipeline; the human summary still goes to stdout.
  let outPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') outPath = argv[i + 1];
    else if (argv[i].indexOf('--out=') === 0) outPath = argv[i].slice(6);
  }

  const cat = loadCatalog(path.join(process.cwd(), 'devices'));
  const topology = new Topology();

  const report = {
    models: cat.length,
    vendors: new Set(cat.map(function (s) { return s.vendor; })).size,
    ports: 0,
    offenders: [],
    failed: []
  };
  const bySeverity = { high: 0, medium: 0, low: 0 };
  const byRule = {};
  const byType = {};   // wireless / pon / ethernet / ... buckets
  const byVendor = {};
  const devicesSeen = new Set();

  for (const spec of cat) {
    let dev;
    try {
      dev = topology.addDevice(spec);
    } catch (e) {
      report.failed.push({ model: spec.vendor + '/' + spec.model, error: e.message });
      continue;
    }

    // Expanded interface specs, keyed by name, so we can read what the spec
    // DECLARED (before the engine resolved a cage for it).
    const declared = new Map();
    for (const s of (dev.spec.interfaces || [])) declared.set(s.name, s);

    for (const iface of dev.interfaces.values()) {
      // Subinterfaces borrow the parent's hardware; auditing them would report
      // the same physical port twice.
      if (iface.parent) continue;
      report.ports++;

      const declaredSpec = declared.get(iface.name) || {};
      const type = String(iface.type || 'ethernet').toLowerCase();
      const connector = declaredSpec.connector || declaredSpec.cage || '';
      const cage = iface.hardware.cage;
      const hits = checkPort(type, connector, cage);
      if (!hits.length) continue;

      hits.sort(function (a, b) { return severityRank(a.severity) - severityRank(b.severity); });
      const worst = hits[0].severity;
      const offender = {
        vendor: spec.vendor || 'generic',
        model: spec.model || 'unknown',
        port: iface.name,
        type: type,
        declaredConnector: String(connector),
        resolvedCage: String(cage),
        note: hits.map(function (h) { return h.note; }).join('; '),
        // extra context for the report; JSON consumers can ignore it
        severity: worst,
        rules: hits.map(function (h) { return h.rule; }),
        category: spec.category || 'generic',
        resolvedCageName: iface.hardware.cageName
      };
      report.offenders.push(offender);

      devicesSeen.add(offender.vendor + '/' + offender.model);
      bySeverity[worst] = (bySeverity[worst] || 0) + 1;
      for (const h of hits) byRule[h.rule] = (byRule[h.rule] || 0) + 1;
      const bucket = (type === 'radio') ? 'wireless' : type;
      byType[bucket] = (byType[bucket] || 0) + 1;
      byVendor[offender.vendor] = (byVendor[offender.vendor] || 0) + 1;
    }
  }

  // Worst first: severity, then how central the port is to the model (a radio
  // that cannot be a radio is worse than a stray console port), then name.
  report.offenders.sort(function (a, b) {
    const s = severityRank(a.severity) - severityRank(b.severity);
    if (s) return s;
    const d = naturalCompare(a.vendor + '/' + a.model, b.vendor + '/' + b.model);
    if (d) return d;
    return naturalCompare(a.port, b.port);
  });

  const doc = {
    generatedAt: new Date().toISOString(),
    offenders: report.offenders.map(function (o) {
      return {
        vendor: o.vendor,
        model: o.model,
        port: o.port,
        type: o.type,
        declaredConnector: o.declaredConnector,
        resolvedCage: o.resolvedCage,
        note: o.note
      };
    })
  };

  const summary = {
    models: report.models,
    vendors: report.vendors,
    ports: report.ports,
    devicesOffending: devicesSeen.size,
    portsOffending: report.offenders.length,
    bySeverity: bySeverity,
    byType: byType,
    byRule: byRule,
    byVendor: byVendor,
    failed: report.failed
  };

  if (outPath) {
    const fs = require('fs');
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath), JSON.stringify(doc, null, 2) + '\n');
  }

  if (asJson) {
    // Machine-readable: the document plus the summary alongside it, so a CI job
    // can assert on counts without re-deriving them.
    console.log(JSON.stringify({ summary: summary, result: doc }, null, 2));
    return report.offenders.length ? 1 : 0;
  }

  console.log('Port type / connector audit');
  console.log('  models:  ' + report.models + ' across ' + report.vendors + ' vendors');
  console.log('  ports:   ' + report.ports);
  console.log('  offending devices: ' + devicesSeen.size);
  console.log('  offending ports:   ' + report.offenders.length +
    '  (high ' + (bySeverity.high || 0) + ', medium ' + (bySeverity.medium || 0) +
    ', low ' + (bySeverity.low || 0) + ')');

  if (report.offenders.length) {
    const buckets = Object.keys(byType).sort(function (a, b) { return byType[b] - byType[a]; });
    console.log('  by declared type:  ' + buckets.map(function (k) {
      return k + ' ' + byType[k];
    }).join(', '));
    const rules = Object.keys(byRule).sort(function (a, b) { return byRule[b] - byRule[a]; });
    console.log('  by rule:           ' + rules.map(function (k) {
      return k + ' ' + byRule[k];
    }).join(', '));
    console.log('');
    for (const o of report.offenders) {
      console.log('[' + o.severity.toUpperCase() + '] ' + o.vendor + '/' + o.model + ' ' + o.port +
        '  type=' + o.type +
        ' connector=' + (o.declaredConnector || '(none)') +
        ' cage=' + o.resolvedCage);
      if (!quiet) console.log('        ' + o.note);
    }
  }

  if (report.failed.length) {
    console.log('\nFailed to materialise: ' + report.failed.length);
    for (const f of report.failed.slice(0, 10)) console.log('   - ' + f.model + ': ' + f.error);
  }

  console.log('\n' + (report.offenders.length
    ? report.offenders.length + ' port(s) contradict their declared type.'
    : 'No port contradicts its declared type.'));
  return report.offenders.length ? 1 : 0;
}

// Run only when invoked directly, so test/ can import the rules.
if (require.main === module) process.exit(main());

module.exports = {
  main: main,
  checkPort: checkPort,
  isKnownCage: isKnownCage,
  effectiveCage: effectiveCage,
  FIBRE_CONNECTORS: FIBRE_CONNECTORS,
  PON_CAGES: PON_CAGES
};
