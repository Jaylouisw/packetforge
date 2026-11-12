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
// opts: topology | ctx — the topology, so cables and LLDP neighbours can be drawn
//       fullNames      — print the interface name instead of the panel number, when
//                        it fits (the inspector asks for it)
//       width          — the px the panel will be given, if not the 316px default
//
// Labels are never allowed to overflow their cell: the row width is chosen from the
// measured text (see Geometry), so a dense panel gets more rows rather than sliced
// glyphs. Issue #26 was that failure — an eight-wide cage group cutting "Gi1/1/1"
// through the middle of a character.
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

  // How many cells per physical row at most. A 24-port switch is two rows of twelve,
  // a 48-port is four, which is how the silkscreen looks and still fits a 340px
  // inspector. These are ceilings, not promises: plan() lowers the count when the
  // labels need the room (see Geometry below).
  var COLUMNS = { copper: 12, combo: 6, fibre: 8, console: 2, other: 8 };

  // ---------------------------------------------------------------------------
  // Geometry — how much room a label actually gets
  //
  // Issue #26: an eight-wide cage group allots a cell's label 27.6px by this estimate
  // (28px measured in Chromium), while "Gi1/1/1" drawn at 9px monospace needs 35.7px
  // there. .fp-port is a fixed-height overflow:hidden box with no ellipsis, so the
  // excess was cut through the middle of a glyph and the socket became unreadable.
  //
  // The fix is to stop guessing: the column count is derived from the width of the
  // text that will be painted, and a label that still cannot fit is shortened
  // deliberately (silkscreen number, then an ellipsis) with the full name kept in
  // the tooltip. Nothing is ever left for the browser to slice.
  //
  // Every number below mirrors a declaration in web/faceplate.css. They have to
  // agree or the estimate is a fiction, so test/faceplate-clipping.test.js reads the
  // stylesheet and fails when the two drift apart.
  // ---------------------------------------------------------------------------
  var METRICS = {
    // #inspector is a fixed 340px column (web/style.css) and .tab-panel pads it by
    // 12px a side, so the panel is 316px wide before its own padding is taken.
    panelWidth: 316,
    panelPadX: 12,      // .faceplate { padding: 10px 12px 11px }
    panelBorder: 1,     // .faceplate { border: 1px }
    gap: 3,             // .faceplate { --fp-gap: 3px } / .fp-row { gap }
    cellPadX: 2,        // .fp-port { padding: 0 2px 2px }
    cellBorder: 1,      // .fp-port { border: 1px }
    fontSize: 9,        // .fp-port { font-size: 9px }
    // Advance width of the panel's monospace glyph as a fraction of font-size.
    // Consolas is 0.55em, Cascadia Code and SF Mono are 0.60em; take the widest so
    // the estimate errs towards a shorter row and never towards a sliced label.
    charRatio: 0.62,
    roleArrow: 6        // .fp-role .fp-port-name::after ("⇄" at 7px, plus its margin)
  };
  var CHAR_W = METRICS.fontSize * METRICS.charRatio;

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
  // Geometry helpers (see METRICS above)
  // ---------------------------------------------------------------------------
  function panelInner(panelWidth) {
    var w = (typeof panelWidth === 'number' && panelWidth > 0) ? panelWidth : METRICS.panelWidth;
    return w - 2 * METRICS.panelPadX - 2 * METRICS.panelBorder;
  }

  // Rendered width of a label, in px. Monospace, so this is a multiplication and
  // not a guess: every glyph has the same advance.
  function textWidth(text) {
    return String(text == null ? '' : text).length * CHAR_W;
  }

  // The space a label gets inside its cell for a given column count: the panel
  // minus its padding, split into equal tracks less the gaps, minus the cell's own
  // padding and border. This is the number issue #26 was silently overrunning.
  function labelBudget(columns, panelWidth) {
    var cols = (typeof columns === 'number' && columns >= 1) ? Math.floor(columns) : 1;
    var cell = (panelInner(panelWidth) - (cols - 1) * METRICS.gap) / cols;
    return cell - 2 * METRICS.cellPadX - 2 * METRICS.cellBorder;
  }

  // The widest row that still gives every label the room it needs. Fewer columns
  // means taller, not wider: the panel gets more rows and stays readable.
  function columnsThatFit(count, want, need, panelWidth) {
    var cols = Math.max(1, Math.min(count, want));
    while (cols > 1 && labelBudget(cols, panelWidth) < need) cols--;
    return cols;
  }

  // Last resort when even a single column is too narrow: cut the label ourselves, on
  // a glyph boundary and with an ellipsis, so it is obviously shortened. The caller
  // keeps the full name in the tooltip, which is where a cut label belongs.
  function clip(text, budget) {
    var s = String(text == null ? '' : text);
    if (textWidth(s) <= budget) return { text: s, truncated: false };
    var room = Math.max(1, Math.floor(budget / CHAR_W) - 1);
    return { text: s.slice(0, room) + '\u2026', truncated: true };
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
    // opts.width lets a host place the panel in a narrower column; the default is the
    // inspector it was designed for.
    var panelWidth = (typeof opts.width === 'number' && opts.width > 0) ? opts.width : METRICS.panelWidth;
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
      var want = columnsFor(g.family, g.ports.length);
      var short = shortLabels(g.ports);
      g.shortOf = function (name) {
        if (opts.fullNames) return name;
        return short[name] || name;
      };

      // --- how the group is labelled, and how wide that makes a row ------------
      //
      // Preference order: the full interface name when it fits, then the silkscreen
      // number ("1/1/49" lives on the panel as "49"), then fewer columns, and only
      // then an ellipsis. Each step is a deliberate choice about what to drop; the
      // old layout dropped the last glyphs of the name without deciding to.
      var fullLabels = g.ports.map(function (p) { return p.name; });
      var silkLabels = g.ports.map(function (p) { return short[p.name] || p.name; });
      var candidates = opts.fullNames ? [fullLabels, silkLabels] : [silkLabels];

      var need = function (labels) {
        var w = 0;
        g.ports.forEach(function (p, i) {
          var n = textWidth(labels[i]) + (p.role ? METRICS.roleArrow : 0);
          if (n > w) w = n;
        });
        return w;
      };

      var chosen = null;
      for (var ci = 0; ci < candidates.length && !chosen; ci++) {
        if (need(candidates[ci]) <= labelBudget(want, panelWidth)) chosen = candidates[ci];
      }

      var labels, columns, cut = {};
      if (chosen) {
        // Density wins: the labels fit as they are, keep the widest row.
        columns = want;
        labels = chosen;
      } else {
        // Nothing fits at full density. The panel numbers are never longer than the
        // full names, so they are the thing to keep while rows get narrower.
        var preferred = candidates[candidates.length - 1];
        columns = columnsThatFit(g.ports.length, want, need(preferred), panelWidth);
        var budget = labelBudget(columns, panelWidth);
        labels = preferred.map(function (s, i) {
          var fitted = clip(s, budget - (g.ports[i].role ? METRICS.roleArrow : 0));
          if (fitted.truncated) cut[g.ports[i].name] = true;
          return fitted.text;
        });
      }

      g.columns = columns;
      // What the panel actually shows: the interface name, the silkscreen number the
      // hardware prints, or a name the layout had to cut. Callers use it to explain
      // the panel; the test uses it to know which shortening was deliberate.
      var shortened = false;
      g.ports.forEach(function (p, i) { if (labels[i] !== p.name) shortened = true; });
      g.labelMode = Object.keys(cut).length ? 'truncated' : (shortened ? 'silkscreen' : 'full');
      g.truncated = Object.keys(cut).length > 0;
      g.budget = labelBudget(columns, panelWidth);
      g.cut = cut;
      g.labelOf = function (name) {
        for (var k = 0; k < g.ports.length; k++) {
          if (g.ports[k].name === name) return labels[k];
        }
        return name;
      };

      g.rows = chunk(g.ports, g.columns);
      g.rate = groupRate(g.ports);
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
        deviceId: other.deviceId,
        dev: dev || null,
        iface: other.iface,
        toString: function () { return this.device + ':' + this.iface; }
      };
    }
    return null;
  }

  // The cable itself can be down while both ends stay patched. `link down` is a first-class state in
  // this simulator, so a port on a down link is down - and it is not "no cable", which is a different
  // fault with a different fix (#1238).
  function linkDownOf(device, name, ctx) {
    var links = (ctxParts(ctx).links) || [];
    for (var i = 0; i < links.length; i++) {
      var l = links[i];
      if (!l || !l.a || !l.b) continue;
      var mine = (l.a.deviceId === device.id && l.a.iface === name) ||
                 (l.b.deviceId === device.id && l.b.iface === name);
      if (mine && l.state === 'down') return true;
    }
    return false;
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
  // Whether a port can carry a frame, and why not when it cannot (#1238)
  // ---------------------------------------------------------------------------
  //
  // Three views describe a port - this faceplate cell, the canvas tooltip, the inspector footer - and
  // each of them answered one question, "is it shut down", then printed the answer as the status. An
  // unplugged port was therefore described as healthy in all three, which is the worst possible place
  // to be wrong: the canvas is what you look at when a link will not come up.
  //
  // The rule lives here, once, and the other two call it. The sentence about a socket should not be
  // written three times.
  //
  // Facts are passed in rather than looked up, so a caller that cannot see the topology says
  // `undefined` instead of guessing: an unknown cable is not a missing cable.
  function portState(facts) {
    var f = facts || {};
    if (f.enabled === false) {
      return { state: 'down', status: 'administratively down', reason: 'shut down' };
    }
    // `notconnect` is the word the vendor CLIs use for "the socket is fine, nothing is in it", and it
    // is deliberately not `down`: painting every unused port on a 48-port faceplate red would say
    // "fault" 46 times. The status text is still `down (no cable)`, because that is what it is.
    if (f.cabled === false) {
      return { state: 'notconnect', status: 'down', reason: 'no cable' };
    }
    // A patched cable can be taken down without being unplugged (`link down`), and the simulator will
    // not carry a frame across it. Reporting the port as up in that case is the same lie as calling an
    // empty socket up (#1238).
    if (f.linkDown === true) {
      return { state: 'down', status: 'down', reason: 'link down' };
    }
    if (f.peerEnabled === false) {
      return { state: 'down', status: 'down', reason: 'peer shut down' };
    }
    // A port the spanning tree blocks is plugged in, up, and unable to carry a frame - and it is not a fault. Two
    // things follow from that, and both are the reason this is its own state rather than `down`:
    //
    //   * the status must say what actually happens to traffic, in the words `show spanning-tree` already uses
    //     ("blocking (traffic dropped)"), because a healthy-looking port that drops everything is the exact lie
    //     this function was written to stop (#1238, #1441);
    //   * it must not be painted as a fault. A redundant lab blocks ports by design, and 22 red ports on a triangle
    //     would report a healthy tree as a broken board - the same mistake `notconnect` avoids for empty sockets.
    if (f.blocked === true) {
      return { state: 'blocked', status: 'blocking', reason: 'traffic dropped' };
    }
    return { state: f.cabled === true ? 'cabled' : 'up', status: 'up', reason: null };
  }

  // The sentence a tooltip shows: "administratively down", "down (no cable)", "down (peer shut down)",
  // "up". Here rather than at each call site, so the panel, the canvas and the inspector cannot drift
  // into three slightly different descriptions of one socket.
  function portStateText(facts) {
    var s = portState(facts);
    if (!s.reason) return s.status;
    if (s.reason === 'shut down') return 'administratively down';
    return s.status + ' (' + s.reason + ')';
  }

  // ---------------------------------------------------------------------------
  // The state payload's per-device runtime, whichever shape the caller holds: the panel passes the topology
  // document, the canvas passes `state.topology`. `runtime` rides on the serialized board, so both reach it.
  function runtimeOf(ctx) {
    if (!ctx) return null;
    if (ctx.runtime) return ctx.runtime;
    var topo = ctx.topology || null;
    return (topo && topo.runtime) || null;
  }

  // What the tree decided about one device's ports, from the payload (#1441). `null` means the payload said nothing
  // about this box - an older server, or a device that is not a bridge - and a view that is told nothing must not
  // answer "forwarding".
  function stpOf(ctx, deviceId) {
    var rt = runtimeOf(ctx);
    var row = (rt && deviceId) ? rt[deviceId] : null;
    return (row && row.stp) || null;
  }

  // One port's tree verdict, in the shape `portState()` takes. Facts are passed in rather than looked up, the same
  // rule the rest of this file follows: an unknown tree is not a forwarding tree, so it is `undefined`, not false.
  function stpVerdict(stpForDevice, port) {
    if (!stpForDevice || !port) return undefined;
    var row = stpForDevice[port];
    if (!row) return undefined;
    return { blocked: row.blocked === true, text: row.text || null };
  }

  // ---------------------------------------------------------------------------
  // The port cell
  function cell(device, iface, group, ctx, opts) {
    var cage = resolveCage(iface);
    var info = cageInfo(cage);
    var name = iface.name;
    var short = group.labelOf ? group.labelOf(name) : (group.shortOf ? group.shortOf(name) : name);
    var peer = peerOf(device, name, ctx);
    var plugged = peerText(peer, iface);
    var lldp = iface.lldp || null;
    var poeOut = num(iface.poeOut);
    var poeIn = num(iface.poeIn);
    var down = iface.enabled === false;
    var hasCable = !!peer || !!iface.peer || !!lldp;
    // The far end's own state, when this view can see it: a cabled port whose partner is shut cannot
    // carry a frame either, and saying "cabled" without that is half an answer (#1238).
    var peerIf = null;
    if (peer && peer.dev && peer.dev.interfaces) {
      var plist = peer.dev.interfaces;
      for (var pi = 0; pi < plist.length; pi++) {
        if (plist[pi] && plist[pi].name === peer.iface) { peerIf = plist[pi]; break; }
      }
      if (!peerIf && plist[peer.iface]) peerIf = plist[peer.iface];
    }
    var linkFacts = {
      enabled: iface.enabled,
      cabled: hasCable,
      peerEnabled: peerIf ? peerIf.enabled !== false : undefined,
      linkDown: linkDownOf(device, name, ctx),
      // The tree's verdict, from the payload (#1441). Undefined when the view was given no state: a rule that
      // invented "forwarding" for a box it knew nothing about would be the same lie in a new place.
      blocked: (function () {
        var v = stpVerdict(stpOf(ctx, device.id), name);
        return v ? v.blocked : undefined;
      })()
    };
    var linkState = portState(linkFacts);
    // A blocked port is cabled - it is a working cable on a port the tree has shut - so the PoE and peer parts of
    // the cell must still see it as patched, or a blocked uplink would lose its power draw and its peer label.
    var cabled = linkState.state === 'cabled' || linkState.state === 'blocked';
    var state = linkState.state;
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
    // "not cabled" was the whole story before #1238, and it left the operational half unsaid. When the
    // port is known to have no cable, say what that means: down (no cable).
    if (linkState.reason === 'no cable') title.push(portStateText(linkFacts));
    else title.push(plugged ? 'cabled to ' + plugged : 'not cabled');
    // A patched, up port that the tree blocks carries nothing: the tooltip has to say so, in the console's words,
    // or the one view an operator checks when traffic stops reports the socket as fine (#1441).
    if (linkState.state === 'blocked') title.push(portStateText(linkFacts));
    if (lldp && lldp.systemName) {
      title.push('LLDP ' + lldp.systemName + (lldp.portId ? ':' + lldp.portId : ''));
    }
    if (poeOut) title.push('PoE out ' + poeOut + ' W' + (cabled ? '' : ' (capable)'));
    if (poeIn) title.push('PoE in ' + poeIn + ' W');
    if (iface.ip) title.push('IP ' + iface.ip + (iface.mask ? '/' + iface.mask : ''));
    // One sentence, from one rule: "down (no cable)", "down (peer shut down)", "administratively
    // down". The cell used to say only "administratively down", so every other reason a link is dead
    // was invisible here (#1238).
    if (linkState.state === 'down') title.push(portStateText(linkFacts));

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
    // A label the layout had to cut says so, so nothing downstream mistakes the
    // ellipsis for the port's name. data-port and the tooltip keep the real one.
    if (group.cut && group.cut[name]) attrs.push('data-truncated="1"');
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
      ' data-cage="' + esc(group.cage) + '" data-count="' + group.ports.length + '"' +
      // the geometry the layout committed to, so a test (or a host) can check that the
      // CSS hook below really gives each label the width the plan assumed
      ' data-columns="' + group.columns + '" data-label="' + esc(group.labelMode || 'silkscreen') + '">' +
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
    FAMILY_ORDER: FAMILY_ORDER,
    // geometry: what the layout assumed, and how it decides (issue #26)
    METRICS: METRICS,
    textWidth: textWidth,
    labelBudget: labelBudget,
    columnsThatFit: columnsThatFit,
    clip: clip,
    // The one rule about whether a port can carry a frame, and why not (#1238). Exported because the
    // canvas tooltip and the inspector footer describe the same socket and must not disagree.
    portState: portState,
    portStateText: portStateText,
    // The tree's verdict for one port, and the two readers that find it in a state payload (#1441). Exported so the
    // canvas and the inspector ask the same place the panel does instead of each writing its own lookup.
    runtimeOf: runtimeOf,
    stpOf: stpOf,
    stpVerdict: stpVerdict
  };

  root.PFFaceplate = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
