'use strict';
// faceplate.js — a device drawn the way the hardware actually looks.
//
// On a 48-port switch the canvas port dots are unusable: 48 unlabelled circles in
// two columns, labels hidden until you select the device, and even then you cannot
// tell which socket is which. The answer is not bigger dots, it is the thing every
// network engineer already reads fluently: the FRONT PANEL.
//
// Real hardware has a shape. A 24-port access switch is one block of numbered RJ45
// sockets wrapping into rows of twelve, with the SFP cages sitting apart at the end,
// and a console port off to one side. This module renders exactly that, in that
// order, because the layout carries the information the dots could not: position,
// number, connector family, and what is plugged in.
//
// Contract:
//   html = window.PFFaceplate.render(device, opts)   // device = serialized device
//   wrap.innerHTML = html
//   PFFaceplate.bind(wrap, function (hit) { ... })    // delegated, no inline JS
//
// The device object is what the engine serialises (engine/device.js). Per interface
// it carries: name, cage, speedCaps, enabled, ip, lldp, poeIn, poeOut, role, vlan.
//
// Styling is by hook only: data-cage="rj45|sfp|sfp+|..." plus fp-* classes, never an
// inline colour, so web/faceplate.css owns the theme and the maintainer can restyle
// the panel without touching this file.
(function (root) {
  // ---------------------------------------------------------------------------
  // Connector families
  //
  // The order of FAMILY is the order on a real chassis: copper sockets first, then
  // the shared combo cages, then fibre, then the console port, then the specialist
  // copper the CPEs have (coax / DSL / powerline). Anything unknown sorts last and
  // is drawn as unknown — guessing "rj45" would paint fibre grey and confidently
  // answer a question we did not know.
  // ---------------------------------------------------------------------------
  var CAGE_INFO = {
    rj45: { label: 'RJ45', family: 'copper' },
    rj11: { label: 'RJ11', family: 'copper' },
    combo: { label: 'Combo RJ45/SFP', family: 'combo' },
    sfp: { label: 'SFP', family: 'fibre' },
    'sfp+': { label: 'SFP+', family: 'fibre' },
    sfp28: { label: 'SFP28', family: 'fibre' },
    'qsfp+': { label: 'QSFP+', family: 'fibre' },
    qsfp28: { label: 'QSFP28', family: 'fibre' },
    qsfpdd: { label: 'QSFP-DD', family: 'fibre' },
    'sc-apc': { label: 'SC/APC', family: 'fibre' },
    'sc-upc': { label: 'SC/UPC', family: 'fibre' },
    'lc-upc': { label: 'LC/UPC', family: 'fibre' },
    'lc-apc': { label: 'LC/APC', family: 'fibre' },
    mpo: { label: 'MPO', family: 'fibre' },
    console: { label: 'Console', family: 'console' },
    usb: { label: 'USB', family: 'console' },
    coax: { label: 'Coax', family: 'other' },
    dsl: { label: 'DSL', family: 'other' },
    powerline: { label: 'Powerline', family: 'other' },
    antenna: { label: 'Antenna', family: 'other' },
    unknown: { label: 'Connector unknown', family: 'other' }
  };

  var FAMILY_ORDER = ['copper', 'combo', 'fibre', 'console', 'other'];
  var FAMILY_LABEL = {
    copper: 'Copper',
    combo: 'Combo',
    fibre: 'Fibre',
    console: 'Console',
    other: 'Other'
  };
  var FAMILY_RANK = {};
  FAMILY_ORDER.forEach(function (f, i) { FAMILY_RANK[f] = (i + 1) * 10; });

  // How many cells per physical row. A 24-port switch is two rows of twelve, a
  // 48-port is four, which is how the silkscreen looks and still fits a 340px
  // inspector. Capped at 12 so no row becomes a single unreadable line.
  var COLUMNS = { copper: 12, combo: 6, fibre: 8, console: 2, other: 8 };

  function cageInfo(cage) {
    return CAGE_INFO[cage] || CAGE_INFO.unknown;
  }

  function cageLabel(cage) {
    return cageInfo(cage).label;
  }

  function familyOf(cage, iface) {
    var known = CAGE_INFO[cage];
    if (known) return known.family;
    // Some CPEs declare a console port with no connector; type is the fallback.
    if (iface && (iface.type === 'console' || iface.type === 'serial')) return 'console';
    return 'other';
  }

  function resolveCage(iface) {
    var cage = iface.cage || iface.connector || null;
    if (cage) return String(cage).toLowerCase();
    if (iface.type === 'console' || iface.type === 'serial') return 'console';
    return 'unknown';
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  function fmtRate(mbps) {
    if (typeof mbps !== 'number' || !isFinite(mbps) || mbps <= 0) return '';
    if (mbps >= 1000) {
      var g = mbps / 1000;
      return (g % 1 === 0 ? g : g.toFixed(1)) + 'G';
    }
    return mbps + 'M';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function num(v) {
    return typeof v === 'number' && isFinite(v) && v > 0 ? v : null;
  }

  function rateOf(iface) {
    var caps = Array.isArray(iface.speedCaps) ? iface.speedCaps : [];
    var best = 0;
    caps.forEach(function (s) { if (typeof s === 'number' && s > best) best = s; });
    if (best) return fmtRate(best);
    return typeof iface.speed === 'string' ? iface.speed : '';
  }

  function groupRate(ports) {
    var seen = [];
    ports.forEach(function (p) {
      (Array.isArray(p.speedCaps) ? p.speedCaps : []).forEach(function (s) {
        if (seen.indexOf(s) < 0) seen.push(s);
      });
    });
    seen.sort(function (a, b) { return a - b; });
    return seen.map(function (s) { return fmtRate(s); }).join('/');
  }

  // ---------------------------------------------------------------------------
  // Grouping
  //
  // Group by connector, not by name: the name is a silkscreen detail, the cage is
  // the physical hole. Ports keep their declaration order inside a group because
  // that is the hardware order (1/1/2 before 1/1/10 — alphabetising would scramble
  // the panel).
  // ---------------------------------------------------------------------------
  function portsOf(device) {
    if (!device) return [];
    var list = device.interfaces;
    if (!list) return [];
    var arr = (typeof list.values === 'function' && typeof list.get === 'function' && !Array.isArray(list))
      ? Array.from(list.values())
      : Array.from(list);
    // Subinterfaces are logical, not sockets on the front panel.
    return arr.filter(function (i) { return i && i.name && !i.parent; });
  }

  function chunk(list, size) {
    var out = [];
    for (var i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  function columnsFor(family, count) {
    var want = COLUMNS[family] || 8;
    return count < want ? count : want;
  }

  // The silkscreen prints 1..48, not 1/1/1..1/1/48. Strip a shared prefix only when
  // it ends at a real separator ("1/1/", "Fa0/") and every remainder is numeric, so
  // a PC's eth0/eth1 keeps its full name.
  function shortLabels(ports) {
    var out = {};
    ports.forEach(function (p) { out[p.name] = p.name; });
    if (ports.length < 2) return out;
    var prefix = ports[0].name;
    ports.forEach(function (p) {
      var i = 0;
      while (i < prefix.length && i < p.name.length && prefix.charAt(i) === p.name.charAt(i)) i++;
      prefix = prefix.slice(0, i);
    });
    if (!prefix || !/[\/\-_.: ]$/.test(prefix)) return out;
    var short = {};
    for (var k = 0; k < ports.length; k++) {
      var rest = ports[k].name.slice(prefix.length);
      if (!/^\d+$/.test(rest)) return out;
      short[ports[k].name] = rest;
    }
    return short;
  }

  function plan(device, opts) {
    opts = opts || {};
    var ports = portsOf(device);
    var groups = [];
    var byCage = {};
    ports.forEach(function (iface, idx) {
      var cage = resolveCage(iface);
      var g = byCage[cage];
      if (!g) {
        g = byCage[cage] = {
          cage: cage,
          family: familyOf(cage, iface),
          ports: [],
          first: idx
        };
        groups.push(g);
      }
      g.ports.push(iface);
    });

    groups.sort(function (a, b) {
      var d = FAMILY_RANK[a.family] - FAMILY_RANK[b.family];
      if (d) return d;
      return a.first - b.first;
    });

    groups.forEach(function (g) {
      var info = cageInfo(g.cage);
      g.label = info.label;
      g.familyLabel = FAMILY_LABEL[g.family] || 'Other';
      g.columns = columnsFor(g.family, g.ports.length);
      g.rows = chunk(g.ports, g.columns);
      g.rate = groupRate(g.ports);
      var short = shortLabels(g.ports);
      g.shortOf = function (name) {
        if (opts.fullNames) return name;
        return short[name] || name;
      };
    });
    return groups;
  }

  // ---------------------------------------------------------------------------
  // What is plugged in
  //
  // The cables live on the topology, not on the device, so the caller may hand us
  // either a topology ({devices, links}) or its links/devices arrays. When there is
  // no topology we still know something is in the socket if the port has heard an
  // LLDP neighbour — frames only arrive over a cable.
  // ---------------------------------------------------------------------------
  function ctxParts(ctx) {
    if (!ctx) return { links: [], devices: [] };
    var topo = ctx.topology || ctx;
    return {
      links: ctx.links || topo.links || [],
      devices: ctx.devices || topo.devices || []
    };
  }

  function peerOf(device, name, ctx) {
    var parts = ctxParts(ctx);
    var links = parts.links || [];
    for (var i = 0; i < links.length; i++) {
      var l = links[i];
      if (!l || !l.a || !l.b) continue;
      var other = null;
      if (l.a.deviceId === device.id && l.a.iface === name) other = l.b;
      else if (l.b.deviceId === device.id && l.b.iface === name) other = l.a;
      if (!other) continue;
      var dev = null;
      for (var j = 0; j < (parts.devices || []).length; j++) {
        if (parts.devices[j].id === other.deviceId) { dev = parts.devices[j]; break; }
      }
      return {
        device: (dev && (dev.name || dev.id)) || other.deviceId,
        iface: other.iface,
        toString: function () { return this.device + ':' + this.iface; }
      };
    }
    return null;
  }

  function peerText(peer, iface) {
    if (peer) return peer.device + ':' + peer.iface;
    if (iface.peer) return String(iface.peer);
    if (iface.lldp) {
      return (iface.lldp.systemName || iface.lldp.chassisId || 'neighbour') +
        (iface.lldp.portId ? ':' + iface.lldp.portId : '');
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // The port cell
  // ---------------------------------------------------------------------------
  function cell(device, iface, group, ctx, opts) {
    var cage = resolveCage(iface);
    var info = cageInfo(cage);
    var name = iface.name;
    var short = group.shortOf(name);
    var peer = peerOf(device, name, ctx);
    var plugged = peerText(peer, iface);
    var lldp = iface.lldp || null;
    var poeOut = num(iface.poeOut);
    var poeIn = num(iface.poeIn);
    var down = iface.enabled === false;
    var cabled = !down && (!!peer || !!iface.peer || !!lldp);
    var state = down ? 'down' : (cabled ? 'cabled' : 'up');
    var rate = rateOf(iface);

    var cls = ['fp-port', 'fp-' + state];
    if (poeOut && cabled) cls.push('fp-poe');
    if (poeIn) cls.push('fp-poe-in');
    if (lldp) cls.push('fp-lldp');
    if (iface.ip) cls.push('fp-ip');
    if (opts.selectedPort && opts.selectedPort === name) cls.push('fp-selected');
    if (iface.role) cls.push('fp-role');

    // The tooltip is the same sentence the canvas uses, so the two views never tell
    // the operator different stories about the same socket.
    var title = [name, info.label + ' (' + cage + ')'];
    if (rate) title.push(rate);
    if (iface.role) title.push(String(iface.role).toUpperCase());
    if (iface.description) title.push(iface.description);
    title.push(plugged ? 'cabled to ' + plugged : 'not cabled');
    if (lldp && lldp.systemName) {
      title.push('LLDP ' + lldp.systemName + (lldp.portId ? ':' + lldp.portId : ''));
    }
    if (poeOut) title.push('PoE out ' + poeOut + ' W' + (cabled ? '' : ' (capable)'));
    if (poeIn) title.push('PoE in ' + poeIn + ' W');
    if (iface.ip) title.push('IP ' + iface.ip + (iface.mask ? '/' + iface.mask : ''));
    if (down) title.push('administratively down');

    var aria = name + ' ' + info.label + (rate ? ' ' + rate : '') + ' — ' + state +
      (plugged ? ', ' + plugged : '');

    var attrs = [
      'type="button"',
      'class="' + esc(cls.join(' ')) + '"',
      'data-cage="' + esc(cage) + '"',
      'data-port="' + esc(name) + '"',
      'data-iface="' + esc(name) + '"',
      'data-state="' + esc(state) + '"',
      'data-device-id="' + esc(device.id || '') + '"'
    ];
    if (lldp && lldp.systemName) attrs.push('data-lldp="' + esc(lldp.systemName) + '"');
    attrs.push('title="' + esc(title.join(' · ')) + '"');
    attrs.push('aria-label="' + esc(aria) + '"');

    var html = '<button ' + attrs.join(' ') + '>' +
      '<span class="fp-led" aria-hidden="true"></span>' +
      '<span class="fp-port-name">' + esc(short) + '</span>' +
      (poeOut && cabled ? '<span class="fp-port-flag" aria-hidden="true">P</span>' : '') +
      '</button>';
    return html;
  }

  function groupHtml(device, group, ctx, opts) {
    var rows = group.rows.map(function (row) {
      return '<div class="fp-row fp-cols-' + group.columns + '">' +
        row.map(function (iface) { return cell(device, iface, group, ctx, opts); }).join('') +
        '</div>';
    }).join('');
    return '<section class="fp-group" data-family="' + esc(group.family) + '"' +
      ' data-cage="' + esc(group.cage) + '" data-count="' + group.ports.length + '">' +
      '<div class="fp-group-head">' +
        '<span class="fp-group-name">' + esc(group.familyLabel) + '</span>' +
        '<span class="fp-group-cage" data-cage="' + esc(group.cage) + '">' + esc(group.label) + '</span>' +
        '<span class="fp-group-count">' + group.ports.length + (group.ports.length === 1 ? ' port' : ' ports') + '</span>' +
        (group.rate ? '<span class="fp-group-rate">' + esc(group.rate) + '</span>' : '') +
      '</div>' + rows + '</section>';
  }

  function legendHtml(groups) {
    // The key only lists families the device actually has — a legend full of colours
    // that are not on the panel is noise.
    var seen = [];
    groups.forEach(function (g) {
      if (seen.indexOf(g.family) < 0) seen.push(g.family);
    });
    var keys = seen.map(function (f) {
      var sample = groups.filter(function (g) { return g.family === f; })[0];
      return '<span class="fp-key" data-cage="' + esc(sample.cage) + '">' +
        '<i class="fp-swatch" aria-hidden="true"></i>' +
        esc(FAMILY_LABEL[f] || 'Other') + '</span>';
    }).join('');
    return '<div class="fp-legend">' + keys + '</div>';
  }

  function render(device, opts) {
    opts = opts || {};
    if (!device) return '<div class="faceplate fp-empty">No device selected.</div>';

    var groups = plan(device, opts);
    var total = 0;
    groups.forEach(function (g) { total += g.ports.length; });

    var spec = device.spec || {};
    var model = device.model || device.label || spec.model || '';
    var vendor = device.vendor || spec.vendor || '';
    var modelText = [vendor, model].filter(Boolean).join(' ');
    var counts = groups.map(function (g) { return g.ports.length + '× ' + g.label; }).join(' · ');

    var head = '<div class="fp-head">' +
      '<span class="fp-title">' + esc(device.name || device.id || 'device') + '</span>' +
      (modelText ? '<span class="fp-model">' + esc(modelText) + '</span>' : '') +
      '<span class="fp-counts">' + esc(counts || 'no ports') + '</span>' +
      '</div>';

    var body;
    if (!groups.length) {
      body = '<div class="fp-empty">This device has no physical ports.</div>';
    } else {
      body = '<div class="fp-groups">' +
        groups.map(function (g) { return groupHtml(device, g, opts.topology || opts.ctx || null, opts); }).join('') +
        '</div>' + legendHtml(groups);
    }

    return '<div class="faceplate" data-device-id="' + esc(device.id || '') + '"' +
      ' data-port-count="' + total + '">' + head + body + '</div>';
  }

  // Delegated click handling: the markup carries no inline JS, so the panel stays a
  // pure string and the host decides what a click means.
  function bind(rootEl, onPort) {
    if (!rootEl || typeof rootEl.addEventListener !== 'function' || typeof onPort !== 'function') {
      return function () {};
    }
    function handler(ev) {
      var node = ev && ev.target;
      var hit = (node && node.closest) ? node.closest('.fp-port') : null;
      if (!hit) return;
      var d = hit.dataset || {};
      var rd = rootEl.dataset || {};
      onPort({
        port: d.port || d.iface || null,
        iface: d.iface || d.port || null,
        cage: d.cage || null,
        state: d.state || null,
        lldp: d.lldp || null,
        deviceId: d.deviceId || rd.deviceId || null,
        cell: hit,
        event: ev
      });
    }
    rootEl.addEventListener('click', handler);
    return function unbind() {
      if (rootEl.removeEventListener) rootEl.removeEventListener('click', handler);
    };
  }

  // Convenience for the inspector: paint a container and wire the clicks in one go.
  function mount(el, device, opts) {
    opts = opts || {};
    if (!el) return function () {};
    el.innerHTML = render(device, opts);
    if (el.dataset) el.dataset.deviceId = device && device.id ? device.id : '';
    return opts.onPort ? bind(el, opts.onPort) : function () {};
  }

  var api = {
    render: render,
    plan: plan,
    bind: bind,
    mount: mount,
    cageLabel: cageLabel,
    cageInfo: cageInfo,
    familyOf: familyOf,
    fmtRate: fmtRate,
    portsOf: portsOf,
    escape: esc,
    COLUMNS: COLUMNS,
    FAMILY_ORDER: FAMILY_ORDER
  };

  root.PFFaceplate = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
