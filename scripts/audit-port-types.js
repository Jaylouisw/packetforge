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
// ---------------------------------------------------------------------------
// A spec may describe its ports as an explicit `interfaces` array, as a compact
// `portTemplate` that the engine expands into N ports, or as both. This audit reads
// the EXPANDED list (devices/registry.effectiveInterfaces), so a port that only
// exists because a template generated it is inspected exactly like a hand-written
// one. Reading `interfaces` alone made this audit silent for the ~a fifth of the
// catalogue that is template-only, which is how the FortiGate 200G shipped with no
// copper ports modelled (issue #71, see #60).
const path = require('path');
const { loadCatalog, effectiveInterfaces } = require('../devices/registry');
const { Topology } = require('../engine');
const mediaLib = require('../engine/media');

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
  return Object.prototype.hasOwnProperty.call(mediaLib.CAGES, cage);
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
    // A radio may present an antenna OR a cellular cage: both are radios that take no cable,
    // and since #129 the engine distinguishes "5G modem" from "Wi-Fi radio" by cage rather
    // than by pretending one of them is the other. Either is consistent with the declared
    // type; anything else is the defect this rule exists for.
    if (eff !== 'antenna' && eff !== 'wwan') {
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

// ---------------------------------------------------------------------------
// portTemplate coherence
// ---------------------------------------------------------------------------
// A template is ONE declaration standing in for N ports, so it is the only place
// that can say what those ports physically are. When it says nothing, the engine
// falls back to inferCage(), which reads the port NAME and the declared rate, and
// to a 1000 Mbps default when the rate does not parse. The port then exists, draws
// as something, and contradicts nothing -- because nothing was claimed. That is the
// shape of the #60 defects: the FortiGate 200G modelled no copper ports at all, and
// the 80F/600E SFP cages resolved to RJ45, and the audit agreed with the engine
// every time because the spec under it was silent.
//
// A declared-but-unmodelled connector is already caught by `unknown-cage` above, so
// these rules only speak to the remaining case: the template names nothing at all.

// How many ports the template generates. Mirrors devices/registry.effectiveInterfaces:
// generated ports are the FIRST count entries of the effective list.
function templatePortCount(spec) {
  const t = spec && spec.portTemplate;
  if (!t) return 0;
  return (t.count === undefined || t.count === null) ? 1 : t.count;
}

// Does anything in the declaration pin the connector down? A `hardware` block counts,
// because the engine reads it before it starts guessing.
function declaresConnector(decl) {
  const d = decl || {};
  const hw = (d.hardware && typeof d.hardware === 'object') ? d.hardware : {};
  return !!(d.connector || d.cage || hw.cage || hw.connector);
}

function declaredSpeedCaps(decl, tpl) {
  const a = decl && Array.isArray(decl.speedCaps) ? decl.speedCaps : null;
  const b = tpl && Array.isArray(tpl.speedCaps) ? tpl.speedCaps : null;
  if (a && a.length) return a;
  if (b && b.length) return b;
  return [];
}

// A rate the engine can read. parseSpeedMbps returns null for anything it does not
// understand, and derivePortHardware then quietly falls back to 1000 Mbps - so a 25G
// template port can be modelled as a 1G SFP while every check agrees with it, because
// the spec never stated a rate the code could read.
function knownSpeedMbps(decl, tpl) {
  if (tpl) {
    // The template's own value wins: expansion defaults a missing speed to "1G", and an
    // invented 1G is not a declared rate.
    if (tpl.speed === undefined || tpl.speed === null) return null;
    return mediaLib.parseSpeedMbps(tpl.speed);
  }
  return mediaLib.parseSpeedMbps(decl ? decl.speed : undefined);
}

function checkTemplatePort(spec, decl, iface) {
  const tpl = (spec && spec.portTemplate) || {};
  const hits = [];
  // The four-way silence: no connector, no cage, no speedCaps, no readable rate. The
  // port's entire hardware description is a guess, so no datasheet claim can ever be
  // contradicted and no rule above can ever fire on it.
  if (!declaresConnector(decl) && !declaredSpeedCaps(decl, tpl).length && !knownSpeedMbps(decl, tpl)) {
    hits.push({
      rule: 'template-undeclared-hardware',
      severity: 'high',
      note: 'the portTemplate declares no connector, no cage, no speedCaps and no rate the engine can read, so this ' +
        'port has no declared physical identity at all: the cage is inferred from the port name alone and the rate ' +
        'fell back to 1 Gbit/s (it presents as ' + String(iface && iface.hardware && iface.hardware.cage) + '). ' +
        'Nothing here can be checked against a datasheet, and a wrong connector or a wrong line rate can never be caught'
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// One spec in, one audit out
// ---------------------------------------------------------------------------
// Everything the CLI reports is produced here, so a test can hand in a fixture spec
// that was never written into devices/ and ask the same questions CI asks.
// Returns { ports, offenders, templatePorts, undeclaredPorts } (plus `error` when the
// spec cannot be materialised at all).
function auditSpec(spec) {
  const result = { ports: 0, offenders: [], templatePorts: 0, undeclaredPorts: [] };
  let dev;
  try {
    dev = new Topology().addDevice(spec);
  } catch (e) {
    result.error = e.message;
    return result;
  }

  // The EXPANDED declaration list: template ports first, then explicit ones.
  const ports = effectiveInterfaces(spec);
  const tplCount = spec.portTemplate ? templatePortCount(spec) : 0;
  const seen = new Set();

  // Classifier for the one case a silent template gets badly wrong and no rule above
  // can decide: a 10G+ population that the engine renders as RJ45 copper because the
  // port name says nothing and 10G is not in inferCage's optical rate list. 10GBASE-T
  // is real, so the rate alone proves nothing - what decides it is the spec's own
  // words: a box that says SFP/QSFP and never says RJ45/copper/10GBASE-T is describing
  // fibre ports, and if its template resolves them to copper, the fibre ports are not
  // modelled at all. This is the 80F/600E/200G shape (issue #60), reported as evidence
  // rather than as a failure because the wording is a heuristic, not a datasheet.
  const hay = String(spec.model || '') + ' ' + String(spec.label || '') + ' ' + String(spec.description || '');
  const saysFibre = /\b(sfp|qsfp|xfp|cfp)\b/i.test(hay);
  const saysCopper = /\b(rj45|10gbase-?t|copper|mggbe|multigigabit)\b/i.test(hay);
  const copperIsUndescribed = saysFibre && !saysCopper;
  result.fibreAsCopper = [];

  for (let idx = 0; idx < ports.length; idx++) {
    const decl = ports[idx];
    const fromTemplate = idx < tplCount;

    // The interface map is keyed by name, so a name declared twice silently collapses:
    // the device ends up with fewer ports than the spec declares and the dropped one is
    // invisible to every check. A template can collide with an explicit port even
    // though neither declaration looks wrong on its own.
    if (seen.has(decl.name)) {
      result.offenders.push({
        vendor: spec.vendor || 'generic',
        model: spec.model || 'unknown',
        port: String(decl.name),
        type: String(decl.type || 'ethernet').toLowerCase(),
        declaredConnector: String(decl.connector || decl.cage || ''),
        resolvedCage: String((dev.interfaces.get(decl.name) || { hardware: {} }).hardware.cage),
        severity: 'high',
        rules: ['port-name-declared-twice'],
        origin: fromTemplate ? 'template' : 'explicit',
        note: 'declared twice: the first port of this name is the one the device keeps, so this one does not exist ' +
          'and no other check can see it'
      });
      continue;
    }
    seen.add(decl.name);

    const iface = dev.interfaces.get(decl.name);
    if (!iface) continue;
    // Subinterfaces borrow the parent's hardware; auditing them would report
    // the same physical port twice.
    if (iface.parent) continue;
    result.ports++;
    if (fromTemplate) result.templatePorts++;

    const type = String(iface.type || 'ethernet').toLowerCase();
    const connector = decl.connector || decl.cage || '';
    const cage = iface.hardware.cage;
    const hits = checkPort(type, connector, cage);
    if (fromTemplate) {
      for (const h of checkTemplatePort(spec, decl, iface)) hits.push(h);
      // Nothing in the template says what this port physically is: the cage came from
      // the port-name heuristic. Counted as coverage, not as a contradiction.
      if (!declaresConnector(decl)) result.undeclaredPorts.push({ name: decl.name, cage: String(cage) });
      const mbps = knownSpeedMbps(decl, spec.portTemplate) || 0;
      if (!declaresConnector(decl) && String(cage) === 'rj45' && mbps >= 10000 && copperIsUndescribed) {
        result.fibreAsCopper.push({ name: decl.name, speed: String(decl.speed || '') });
      }
    }
    if (!hits.length) continue;

    hits.sort(function (a, b) { return severityRank(a.severity) - severityRank(b.severity); });
    result.offenders.push({
      vendor: spec.vendor || 'generic',
      model: spec.model || 'unknown',
      port: String(decl.name),
      type: type,
      declaredConnector: String(connector),
      resolvedCage: String(cage),
      note: hits.map(function (h) { return h.note; }).join('; '),
      // extra context for the report; JSON consumers can ignore it
      severity: hits[0].severity,
      rules: hits.map(function (h) { return h.rule; }),
      origin: fromTemplate ? 'template' : 'explicit',
      category: spec.category || 'generic',
      resolvedCageName: iface.hardware.cageName
    });
  }
  return result;
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

  const report = {
    models: cat.length,
    vendors: new Set(cat.map(function (s) { return s.vendor; })).size,
    ports: 0,
    offenders: [],
    failed: [],
    // Template-expanded ports, and how many of them nothing in the spec pins down.
    // These are coverage, not offenders: a spec that declares nothing contradicts
    // nothing, yet those are exactly the ports no check can hold to a datasheet.
    templatePorts: 0,
    templateSpecs: 0,
    undeclaredTemplatePorts: 0,
    undeclaredTemplateSpecs: [],
    fibreAsCopperPorts: 0,
    fibreAsCopperSpecs: []
  };
  const bySeverity = { high: 0, medium: 0, low: 0 };
  const byRule = {};
  const byType = {};   // wireless / pon / ethernet / ... buckets
  const byVendor = {};
  const byOrigin = { template: 0, explicit: 0 };
  const devicesSeen = new Set();

  for (const spec of cat) {
    const res = auditSpec(spec);
    if (res.error) {
      report.failed.push({ model: spec.vendor + '/' + spec.model, error: res.error });
      continue;
    }

    report.ports += res.ports;
    report.templatePorts += res.templatePorts;
    if (res.fibreAsCopper && res.fibreAsCopper.length) {
      report.fibreAsCopperPorts += res.fibreAsCopper.length;
      report.fibreAsCopperSpecs.push({
        vendor: spec.vendor || 'generic',
        model: spec.model || 'unknown',
        ports: res.fibreAsCopper.length,
        total: res.templatePorts,
        speed: res.fibreAsCopper[0].speed,
        first: res.fibreAsCopper[0].name
      });
    }
    if (res.templatePorts) {
      report.templateSpecs++;
      if (res.undeclaredPorts.length) {
        report.undeclaredTemplatePorts += res.undeclaredPorts.length;
        report.undeclaredTemplateSpecs.push({
          vendor: spec.vendor || 'generic',
          model: spec.model || 'unknown',
          ports: res.undeclaredPorts.length,
          total: res.templatePorts,
          first: res.undeclaredPorts[0].name,
          cage: res.undeclaredPorts[0].cage
        });
      }
    }

    for (const offender of res.offenders) {
      report.offenders.push(offender);

      devicesSeen.add(offender.vendor + '/' + offender.model);
      bySeverity[offender.severity] = (bySeverity[offender.severity] || 0) + 1;
      for (const r of offender.rules) byRule[r] = (byRule[r] || 0) + 1;
      const bucket = (offender.type === 'radio') ? 'wireless' : offender.type;
      byType[bucket] = (byType[bucket] || 0) + 1;
      byOrigin[offender.origin] = (byOrigin[offender.origin] || 0) + 1;
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
    // Ports that only exist because a portTemplate generated them. Before #71 these
    // were the ones this audit could not see at all.
    templatePorts: report.templatePorts,
    templateSpecs: report.templateSpecs,
    devicesOffending: devicesSeen.size,
    portsOffending: report.offenders.length,
    bySeverity: bySeverity,
    byType: byType,
    byRule: byRule,
    byOrigin: byOrigin,
    byVendor: byVendor,
    failed: report.failed,
    // Coverage, not failures: template ports whose connector nothing in the spec
    // declares, so the cage is the engine's guess from the port name.
    undeclaredTemplateHardware: {
      specs: report.undeclaredTemplateSpecs.length,
      ports: report.undeclaredTemplatePorts,
      models: report.undeclaredTemplateSpecs.map(function (u) { return u.vendor + '/' + u.model; })
    },
    // 10G+ template ports presented as RJ45 copper on a box whose own wording says
    // SFP/QSFP and never says copper - the #60 shape, measured.
    fibreDeclaredAsCopper: {
      specs: report.fibreAsCopperSpecs.length,
      ports: report.fibreAsCopperPorts,
      models: report.fibreAsCopperSpecs.map(function (u) { return u.vendor + '/' + u.model; })
    }
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
  console.log('  ports:   ' + report.ports +
    (report.templatePorts
      ? '  (' + report.templatePorts + ' of them expanded from a portTemplate in ' + report.templateSpecs + ' specs)'
      : ''));
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
    console.log('  by port origin:    template ' + (byOrigin.template || 0) + ', explicit ' + (byOrigin.explicit || 0));
    console.log('');
    for (const o of report.offenders) {
      console.log('[' + o.severity.toUpperCase() + '] ' + o.vendor + '/' + o.model + ' ' + o.port +
        '  type=' + o.type +
        ' connector=' + (o.declaredConnector || '(none)') +
        ' cage=' + o.resolvedCage +
        (o.origin === 'template' ? '  (from portTemplate)' : ''));
      if (!quiet) console.log('        ' + o.note);
    }
  }

  // Coverage, not failure. A spec that declares nothing contradicts nothing, so these
  // are not offenders - but the cage on every one of these ports came from the engine's
  // name/rate heuristic, which means the audit and the engine can only ever agree with
  // each other. This is the list #71 exists to make countable.
  if (report.undeclaredTemplateSpecs.length) {
    const list = report.undeclaredTemplateSpecs.slice().sort(function (a, b) {
      return b.ports - a.ports || naturalCompare(a.vendor + '/' + a.model, b.vendor + '/' + b.model);
    });
    console.log('\nTemplate ports whose connector nothing declares: ' + report.undeclaredTemplatePorts +
      ' port(s) in ' + list.length + ' spec(s)');
    console.log('  The template names no connector/cage and no speedCaps, so each cage below is inferred from the');
    console.log('  port name and rate. Nothing can contradict a datasheet here, because the spec states nothing.');
    if (!quiet) {
      for (const u of list.slice(0, 15)) {
        console.log('    - ' + u.vendor + '/' + u.model + '  ' + u.ports + '/' + u.total + ' template ports' +
          ' (e.g. ' + u.first + ' -> ' + u.cage + ')');
      }
      if (list.length > 15) console.log('    ... and ' + (list.length - 15) + ' more (see --json summary.undeclaredTemplateHardware)');
    }
  }

  // The #60 shape, measured: a fibre-only box whose template population the engine
  // renders as RJ45 copper. Reported, not gated - the wording is evidence, not proof.
  if (report.fibreAsCopperSpecs.length) {
    const list = report.fibreAsCopperSpecs.slice().sort(function (a, b) {
      return b.ports - a.ports || naturalCompare(a.vendor + '/' + a.model, b.vendor + '/' + b.model);
    });
    console.log('\nTemplate ports at 10G+ presented as RJ45 copper on a box that describes itself as SFP: ' +
      report.fibreAsCopperPorts + ' port(s) in ' + list.length + ' spec(s)');
    console.log('  These specs say SFP/QSFP and never say RJ45/copper/10GBASE-T, their template declares no');
    console.log('  connector, and 10G is not in the engine\'s optical rate list - so the fibre ports are');
    console.log('  modelled as copper sockets that would take a patch lead (the FortiGate 80F/600E/200G shape, #60).');
    if (!quiet) {
      for (const u of list.slice(0, 15)) {
        console.log('    - ' + u.vendor + '/' + u.model + '  ' + u.ports + '/' + u.total + ' template ports at ' +
          u.speed + ' (' + u.first + ' -> rj45)');
      }
      if (list.length > 15) console.log('    ... and ' + (list.length - 15) + ' more (see --json summary.fibreDeclaredAsCopper)');
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
  // Per-spec entry point: hand it a fixture and it audits it exactly as the CLI does.
  auditSpec: auditSpec,
  checkTemplatePort: checkTemplatePort,
  effectiveInterfaces: effectiveInterfaces,
  isKnownCage: isKnownCage,
  effectiveCage: effectiveCage,
  FIBRE_CONNECTORS: FIBRE_CONNECTORS,
  PON_CAGES: PON_CAGES
};
