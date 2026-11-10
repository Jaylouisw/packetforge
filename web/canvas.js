'use strict';
// canvas.js — SVG topology canvas: rendering, drag/pan/zoom, cabling, packet animation.
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.getElementById('canvas');
  const world = document.getElementById('world');
  const packetsLayer = document.getElementById('packets');
  const overlay = document.getElementById('overlay');

  const view = { zoom: 1, panX: 60, panY: 40 };
  const state = { topology: null, selected: null, connecting: null, placing: null };

  // callbacks wired by app.js
  const on = {
    place: null,      // (x, y, spec)
    placeBlocked: null, // (x, y, spec) - the point was under a floating overlay, nothing placed
    select: null,     // (deviceId | null)
    selectLink: null, // (linkId)
    contextLink: null, // (linkId, x, y) - right-click on a cable
    move: null,       // (deviceId, x, y)
    portClick: null,  // (deviceId, iface) - also the "complete the cable" call
    connectCancel: null, // () - an in-flight cable was abandoned (empty canvas click)
    context: null,    // (deviceId, x, y)
    dblclick: null,   // (deviceId)
    renderError: null // (failures[], error) - a redraw could not draw everything
  };

  const ICONS = { router: '🧭', switch: '🔀', 'l3-switch': '🔀', tap: '🔍', host: '🖥️', server: '🗄️', firewall: '🛡️', wireless: '📶', ptp: '📻', cloud: '☁️', ont: '📡', ap: '📶' };

  // Human names for connector families, used in port tooltips. Kept here as well as
  // in app.js because the canvas draws its own SVG and cannot import the UI module.
  function cageLabel(cage) {
    const names = {
      rj45: 'RJ45 copper',
      sfp: 'SFP cage',
      'sfp+': 'SFP+ cage',
      sfp28: 'SFP28 cage',
      'qsfp+': 'QSFP+ cage',
      qsfpdd: 'QSFP-DD cage',
      qsfp28: 'QSFP28 cage',
      combo: 'combo RJ45/SFP',
      console: 'console',
      coax: 'F-connector coax',
      dsl: 'RJ11 DSL',
      powerline: 'mains powerline',
      antenna: 'antenna',
      'sc-apc': 'SC/APC fibre',
      'sc-upc': 'SC/UPC fibre',
      'lc-upc': 'LC/UPC fibre',
      'lc-apc': 'LC/APC fibre',
      usb: 'USB'
    };
    return names[cage] || cage;
  }


  function el(name, attrs, parent) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function deviceSize(ifaceCount) {
    if (ifaceCount <= 2) return { w: 132, h: 68 };
    if (ifaceCount <= 8) return { w: 156, h: 88 };
    const rows = Math.ceil(ifaceCount / 2);
    return { w: 172, h: Math.max(92, rows * 13 + 28) };
  }

  function layoutPorts(ifaces, w, h) {
    const out = [];
    if (ifaces.length === 1) { out.push({ name: ifaces[0].name, x: w, y: h / 2 }); return out; }
    const left = [], right = [];
    ifaces.forEach(function (iface, i) { (i % 2 === 0 ? left : right).push(iface); });
    function col(names, x) {
      const step = h / (names.length + 1);
      names.forEach(function (iface, j) { out.push({ name: iface.name, x: x, y: step * (j + 1) }); });
    }
    col(left, 0); col(right, w);
    return out;
  }

  // cached geometry: portPos[deviceId][iface] = {x,y} (world); geo[deviceId] = {pos,size,ports}
  let portPos = {};
  let geo = {};
  // Every cable drawn in the last frame, with the sockets it runs between, so a drag can move the
  // cables attached to the box being dragged. Without this the chassis slides out from under its own
  // cables and they stay behind until something else forces a redraw (#1228).
  let cableNodes = [];

  function specFor(device) {
    // device already carries vendor/model/category/color info from serialize()
    return device;
  }

  // Rendering is all-or-nothing on purpose.
  //
  // This used to clear the drawing surface first and then draw, so ANY throw after the
  // clear left the canvas permanently blank with the topology still intact on the server
  // and no explanation anywhere - the WebSocket handler discarded the exception with a
  // bare `catch (e) {}`. Reported as issue #20 after a hostname edit blanked a lab.
  //
  // Two levels of protection now:
  //   - one malformed device is skipped and reported, the rest still draw
  //   - if the redraw cannot be completed at all, the previous drawing is put back
  // Either way the failure is handed to on.renderError so it can reach the user.
  // What a cable is made of, drawn as what it is made of.
  //
  // Every medium was the same 2 px grey line, so copper, fibre, a DAC, a PON drop and a
  // phone line were visually identical and the only distinction the canvas had was
  // wireless-versus-not. A link you cannot identify is a line, not a cable (issue #34).
  //
  // Classification is by media id, because that is what the link records. Patterns are
  // ordered: the first match wins, so 'dac-10g' is a DAC before it is copper, and a PON
  // drop is PON before it is fibre.
  const MEDIUM_RULES = [
    [/^wireless/, 'wireless'],
    [/^dac/, 'dac'],
    [/^aoc/, 'aoc'],
    [/^(gpon|xgspon|xg-pon|epon|10g-epon|ngpon|pon)/, 'pon'],
    [/^(docsis|moca|coax)/, 'coax'],
    [/^(vdsl|adsl|shdsl|dsl)/, 'dsl'],
    [/^(homeplug|g\.hn|powerline|mains)/, 'powerline'],
    [/(base-t$|-t$|cat[0-9]|rj45|1000base-t|10gbase-t)/, 'copper'],
    [/(base-|optics|fiber|fibre|sx|lx|er|sr|fr|dr|lr4|cr4|base-x)/, 'fiber']
  ];

  // An impossible cable - one the engine refuses - must not be drawn as a working one either (#1305).
  //
  // The verdict arrives with the topology payload (`state.verdicts`, built by `validateTopology()` in
  // server/index.js), so the drawing reads the same answer the inspector prints instead of forming its own
  // opinion. No verdict in the payload means nothing is claimed: the cable is drawn as it always was, and
  // `data-link-valid` says the drawing could not check it rather than implying it is fine.
  function linkIssue(topo, linkId) {
    const v = topo && topo.verdicts;
    if (!v || v.checked === false || !v.byLink) return null;
    // A malformed entry must not cost the cable its drawing: `filter` over a list containing null would throw,
    // the per-link try/catch would swallow it, and a refused cable would silently vanish from the canvas - the
    // worst of the three possible outcomes.
    const list = (v.byLink[linkId] || []).filter(function (i) { return i && typeof i === 'object'; });
    if (!list.length) return null;
    // An error is a refusal - the cable cannot be what it claims. A warning is a caveat - a run that is longer
    // than the medium's reach still links, it just will not carry. They are drawn differently on purpose.
    const err = list.filter(function (i) { return i.severity === 'error'; })[0];
    const warn = list.filter(function (i) { return i.severity === 'warning' || i.severity === 'warn'; })[0];
    return err || warn || null;
  }

  function mediumClass(mediaId) {
    const id = String(mediaId || '').toLowerCase();
    if (!id) return '';
    for (const rule of MEDIUM_RULES) {
      if (rule[0].test(id)) return rule[1];
    }
    return '';
  }

  function render(topo) {
    state.topology = topo;

    const failures = [];
    const previous = { world: world.innerHTML, overlay: overlay.innerHTML };
    // A device that cannot be laid out cannot be drawn either, so it must not be
    // reported twice for the same fault.
    const failedDevices = {};

    function skip(what, id, err) {
      if (what === 'device' && id) {
        if (failedDevices[id]) return;
        failedDevices[id] = true;
      }
      failures.push({ what: what, id: id, message: (err && err.message) || String(err) });
    }

    const devices = (topo && Array.isArray(topo.devices)) ? topo.devices : [];
    const links = (topo && Array.isArray(topo.links)) ? topo.links : [];

    try {
      world.innerHTML = '';
      overlay.innerHTML = '';
      portPos = {};
      geo = {};
      cableNodes = [];

      drawGrid();

      // Two explicit layers inside the drawing surface, created here rather than in
      // index.html so the paint order cannot be lost by editing markup.
      //
      // PAINT ORDER (bottom to top): grid, cables, devices.
      //
      // Cables used to be appended after the devices, so every cable was painted over
      // the chassis it terminated on - the 16 px transparent grab band lay across the
      // faceplate and, worse, its DOM position made it the pointerdown target for the
      // sockets underneath it (issue #66). A cable belongs behind a box, not in front
      // of it: it runs between two sockets and there is nothing of it to read on the
      // inside of a chassis.
      //
      // Paint order and hit order are separate concerns. Reordering the DOM alone does
      // NOT make a socket clickable - painting order would still be deciding what the
      // mouse hits. That is why hit testing is geometric and precedence-ordered (see
      // hitTest below), independent of what is painted where.
      const cableLayer = el('g', { class: 'cable-layer' }, world);
      const deviceLayer = el('g', { class: 'device-layer' }, world);

      // pass 1: compute geometry so links know where the ports are. A device whose
      // interfaces are not a list cannot be laid out, so it is skipped - but it is
      // recorded, because a device vanishing silently is the same complaint as #20.
      for (const d of devices) {
        try { computeGeo(d); } catch (e) { skip('device', d && d.id, e); }
      }

      // devices (above the cables)
      for (const d of devices) {
        if (d && failedDevices[d.id]) continue;
        try { drawDevice(d, deviceLayer); } catch (e) { skip('device', d && d.id, e); }
      }

      for (const link of links) {
        try {
          const a = portWorld(link.a.deviceId, link.a.iface);
          const b = portWorld(link.b.deviceId, link.b.iface);
          if (!a || !b) continue;
          const sel = state.selectedLink === link.id;
          // A wide invisible band so a 2 px line is actually clickable. It is a grab
          // convenience only: hitTest() consults it after every port and every device
          // body, so it can never cover a socket (issue #66).
          const hitLine = el('line', { class: 'link-hit', x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'data-link-id': link.id }, cableLayer);
          // A radio association is not a cable. Drawing it as one made a wireless lab
          // look wired, and hid the fact that the link is a band rather than a run of
          // copper or glass. Every other medium now carries its own class for the same
          // reason: you should be able to read the plant off the drawing.
          const family = mediumClass(link.mediaId || link.media);
          // A cable that is down must not look like a working one. In a diagram a failed link is
          // the most important thing on the page, and drawing it identically is how a lab ends up
          // showing a cut cable carrying traffic.
          const dead = link.state && link.state !== 'up';
          // A cable the engine refuses is a third kind of bad: it is up, it just cannot be what it claims. Drawn
          // separately from `link-down`, because "cut" and "impossible" need different fixes.
          const issue = linkIssue(state.topology, link.id);
          const refused = !!(issue && issue.severity === 'error');
          const drawLine = el('line', {
            class: 'link' + (family ? ' link-' + family : '') + (sel ? ' selected' : '') +
              (link.mediaId ? ' link-media' : '') + (dead ? ' link-down' : '') +
              (refused ? ' link-invalid' : '') + (issue && !refused ? ' link-caveat' : ''),
            x1: a.x, y1: a.y, x2: b.x, y2: b.y,
            'data-link-id': link.id,
            'data-medium': family || 'unknown',
            'data-media-id': link.mediaId || '',
            'data-link-state': link.state || 'up',
            // Three states, said out loud: refused, accepted, and not checked.
            'data-link-valid': refused ? 'false'
              : ((state.topology && state.topology.verdicts && state.topology.verdicts.checked !== false)
                ? (issue ? 'warn' : 'true') : 'unchecked'),
            'data-link-issue': issue ? issue.code : '',
            'data-link-issue-text': issue ? String(issue.message || '') : ''
          }, cableLayer);
          // The message on hover, so a red cable says what is wrong without a click.
          if (issue) {
            el('title', {}, drawLine).textContent = (link.mediaId ? link.mediaId + ': ' : '') +
              String(issue.message || issue.code);
          }
          cableNodes.push({
            id: link.id,
            a: { deviceId: link.a.deviceId, iface: link.a.iface },
            b: { deviceId: link.b.deviceId, iface: link.b.iface },
            from: { x: a.x, y: a.y },
            to: { x: b.x, y: b.y },
            nodes: [hitLine, drawLine]
          });
        } catch (e) { skip('link', link && link.id, e); }
      }

      // ghost link while cabling
      //
      // The rubber band ends exactly at the cursor, so any hit area it had covered the
      // one pixel the user was aiming at: every click on the destination port landed on
      // the ghost instead and started a pan, so no cable could ever be completed with
      // the mouse (issue #61). It is a picture of a cable being dragged, never a target:
      // pointer-events is off here and in style.css, and hitTest() has no case for it.
      if (state.connecting) {
        const a = portWorld(state.connecting.deviceId, state.connecting.iface);
        if (a) {
          ghostLine = el('line', {
            class: 'link-ghost', x1: a.x, y1: a.y, x2: a.x, y2: a.y,
            'pointer-events': 'none', 'data-ghost': 'connecting'
          }, overlay);
        }
      } else {
        ghostLine = null;
      }
    } catch (e) {
      // Could not even complete the frame: put the last good drawing back rather than
      // showing an empty canvas.
      world.innerHTML = previous.world;
      overlay.innerHTML = previous.overlay;
      skip('frame', null, e);
      if (typeof on.renderError === 'function') {
        try { on.renderError(failures, e); } catch (ignored) { /* reporting must not throw */ }
      }
      return;
    }

    if (failures.length && typeof on.renderError === 'function') {
      try { on.renderError(failures, null); } catch (ignored) { /* reporting must not throw */ }
    }
  }

  let ghostLine = null;

  function drawGrid() {
    // subtle grid
    const g = el('g', {}, world);
    const spacing = 60;
    const extent = 6000;
    for (let i = -extent; i <= extent; i += spacing) {
      el('line', { class: 'grid-line', x1: i, y1: -extent, x2: i, y2: extent }, g);
      el('line', { class: 'grid-line', x1: -extent, y1: i, x2: extent, y2: i }, g);
    }
  }

  function computeGeo(d) {
    if (!d || typeof d.id !== 'string') throw new Error('device has no id');
    const ifaces = Array.isArray(d.interfaces) ? d.interfaces : [];
    const pos = (state.topology.layout && state.topology.layout[d.id]) || { x: 100, y: 100 };
    const size = deviceSize(ifaces.length);
    const ports = layoutPorts(ifaces, size.w, size.h);
    geo[d.id] = { pos: pos, size: size, ports: ports };
    portPos[d.id] = {};
    for (const p of ports) {
      portPos[d.id][p.name] = { x: pos.x + p.x, y: pos.y + p.y };
    }
  }

  function drawDevice(d, parent) {
    const g = geo[d.id];
    const color = d.color || '#3f7cff';
    const node = el('g', { 'data-device-id': d.id, class: 'device' }, parent || world);
    node.style.cursor = 'move';

    // body
    el('rect', {
      x: 0, y: 0, width: g.size.w, height: g.size.h, rx: 8,
      class: 'device-body' + (state.selected === d.id ? ' selected' : ''),
      fill: '#1b2230'
    }, node);

    // vendor color strip
    el('rect', { x: 0, y: 0, width: g.size.w, height: 4, rx: 2, fill: color }, node);

    // icon + labels
    el('text', { x: g.size.w / 2, y: g.size.h / 2 - 6, 'text-anchor': 'middle', 'font-size': 22 }, node)
      .textContent = ICONS[d.category] || '📦';
    el('text', { x: g.size.w / 2, y: g.size.h / 2 + 16, 'text-anchor': 'middle', class: 'device-label' }, node)
      .textContent = d.name;
    el('text', { x: g.size.w / 2, y: g.size.h / 2 + 30, 'text-anchor': 'middle', class: 'device-sub' }, node)
      .textContent = d.vendor + ' · ' + d.model;

    // ports
    //
    // A port dot on its own tells you nothing: not its name, not whether it is copper
    // or fibre, not what is plugged into it. On a 48-port switch the dots are
    // indistinguishable, which makes the drawing unusable for the one thing you
    // actually want from it - knowing which socket is which.
    //
    // So each port now carries its identity three ways: a colour by connector family,
    // a hover title with name/cage/rate/what is plugged in, and a label where there is
    // room for one (always on small devices, and on any device you have selected).
    const CAGE_TINT = {
      rj45: '#94a3b8',
      sfp: '#fbbf24', 'sfp+': '#fbbf24', sfp28: '#fbbf24',
      'qsfp+': '#f59e0b', qsfp28: '#f59e0b', qsfpdd: '#f59e0b',
      'sc-apc': '#22d3ee', 'sc-upc': '#22d3ee',
      'lc-upc': '#22d3ee', 'lc-apc': '#4ade80',
      combo: '#e879f9',
      console: '#a78bfa',
      coax: '#fb923c',
      dsl: '#34d399',
      powerline: '#f472b6',
      antenna: '#60a5fa',
      usb: '#cbd5e1'
    };
    function peerRef(portName) {
      const link = (state.topology.links || []).find(function (l) {
        return (l.a.deviceId === d.id && l.a.iface === portName) ||
               (l.b.deviceId === d.id && l.b.iface === portName);
      });
      if (!link) return null;
      const other = link.a.deviceId === d.id ? link.b : link.a;
      const dev = (state.topology.devices || []).find(function (x) { return x.id === other.deviceId; });
      return { deviceId: other.deviceId, iface: other.iface, dev: dev || null };
    }
    function peerLabel(portName) {
      const ref = peerRef(portName);
      if (!ref) return null;
      return (ref.dev ? ref.dev.name : ref.deviceId) + ':' + ref.iface;
    }
    // Whether this socket can carry a frame, and why not. The rule lives in faceplate.js so the panel,
    // the canvas and the inspector say the same thing; the canvas only supplies the facts it can see
    // (#1238). If faceplate.js is not loaded - the canvas tests load this file alone - the title simply
    // omits the status rather than inventing a second answer.
    function linkDownOf(portName) {
      const links = (state.topology.links || []);
      for (const l of links) {
        if (!l || !l.a || !l.b) continue;
        const mine = (l.a.deviceId === d.id && l.a.iface === portName) ||
                     (l.b.deviceId === d.id && l.b.iface === portName);
        if (mine && l.state === 'down') return true;
      }
      return false;
    }
    function linkStateOf(iface, ref, connected, portName) {
      const lib = (typeof window !== 'undefined' && window.PFFaceplate) || null;
      if (!lib || typeof lib.portState !== 'function') return null;
      let peerEnabled;
      if (ref && ref.dev && Array.isArray(ref.dev.interfaces)) {
        const pif = ref.dev.interfaces.find(function (i) { return i && i.name === ref.iface; });
        if (pif) peerEnabled = pif.enabled !== false;
      }
      const facts = { enabled: iface.enabled, cabled: !!connected, peerEnabled: peerEnabled,
        linkDown: linkDownOf(portName) };
      const verdict = lib.portState(facts);
      // The sentence comes from the same place as the verdict, so the canvas cannot phrase it
      // differently from the panel.
      verdict.text = lib.portStateText(facts);
      return verdict;
    }
    // A 12-port cut-off was too tight: a router with 13 sockets showed no labels at
    // all, which is precisely when you need them. Labels are cheap; only genuinely
    // dense hardware (48-port switches) hides them until you select the device.
    const dense = g.ports.length > 24;
    const showLabels = state.selected === d.id || !dense;
    for (const p of g.ports) {
      const iface = d.interfaces.find(function (i) { return i.name === p.name; });
      const peer = peerLabel(p.name);
      const ref = peerRef(p.name);
      const connected = !!peer || !!iface.peer;
      // The socket's own verdict, from the shared rule: "administratively down", "down (no cable)",
      // "down (peer shut down)" (#1238). Before this the title said "up" for anything not shut down,
      // including a port with nothing plugged in.
      const linkState = linkStateOf(iface, ref, connected, p.name);
      // Never guess copper. Defaulting an unresolved cage to rj45 painted fibre
      // ports grey and made the tooltip state "RJ45 copper" - a confident, specific,
      // wrong answer. Unknown is drawn as unknown.
      const cage = iface.cage || null;
      const tint = cage ? (CAGE_TINT[cage] || '#6b7280') : '#6b7280';
      const rate = (iface.speedCaps && iface.speedCaps.length)
        ? Math.max.apply(null, iface.speedCaps) + ' Mbps'
        : '';
      const roleBit = iface.role ? ' · ' + String(iface.role).toUpperCase() : '';
      const title = p.name + ' · ' +
        (cage ? cageLabel(cage) + ' (' + cage + ')' : 'connector unknown') +
        (rate ? ' · ' + rate : '') + roleBit +
        (linkState && linkState.reason === 'no cable'
          ? ' · ' + linkState.text
          : (peer ? ' · cabled to ' + peer : ' · not cabled')) +
        (linkState && linkState.state === 'down' ? ' · ' + linkState.text : '');
      const dot = el('circle', {
        cx: p.x, cy: p.y, r: 5,
        class: 'port' + (connected ? ' connected' : '') +
          (linkState && linkState.state === 'down' ? ' down' : '') +
          (state.connecting && state.connecting.deviceId === d.id && state.connecting.iface === p.name ? ' active' : ''),
        stroke: tint,
        'data-device-id': d.id, 'data-iface': p.name
      }, node);
      el('title', {}, dot).textContent = title;
      if (showLabels) {
        // Left column labels sit outside the body, right column labels inside, so
        // they never collide with the ports opposite them.
        const onLeft = p.x <= 0.5;
        el('text', {
          x: onLeft ? p.x - 9 : p.x + 9,
          y: p.y + 3,
          'text-anchor': onLeft ? 'end' : 'start',
          class: 'port-label' + (connected ? ' cabled' : '')
        }, node).textContent = p.name + (iface.role && iface.dualRole ? ' ⇄' : '');
      }
    }

    node.setAttribute('transform', 'translate(' + g.pos.x + ',' + g.pos.y + ')');
  }

  function portWorld(deviceId, iface) {
    return (portPos[deviceId] && portPos[deviceId][iface]) || null;
  }

  // ---------- hit testing ----------
  //
  // THE PRECEDENCE RULE (first match wins, highest priority first):
  //
  //   1. PORT        - a socket answers to the mouse before anything else, in every
  //                    mode. A port is 5 px of ink; give it a 9 px screen radius so it
  //                    is reachable, and let nothing drawn over it steal the click.
  //   2. DEVICE BODY - a click on a chassis selects/moves the device and must never
  //                    start a cable (dropping a wire by accident when you meant to
  //                    move a box is a data-loss-looking event).
  //   3. CABLE       - the widened grab band of a 2 px line. It is a convenience and
  //                    is therefore consulted LAST of the three: a cable crossing a
  //                    faceplate may be grabbable on the open span, never on top of a
  //                    socket (issue #66).
  //   4. BACKGROUND  - pan, place-on-click, or cancel an in-flight cable.
  //
  // The GHOST CABLE IS NEVER A HIT TARGET. It terminates at the cursor by definition,
  // so any area it claimed would always sit exactly under the click that is meant to
  // complete the link - which is what made cabling impossible by mouse (issue #61).
  // There is no branch for it here, and it is pointer-events:none in style.css.
  //
  // Testing is geometric, not `e.target.closest(...)`. Resolving through the event
  // target made PAINT ORDER decide what the mouse hit: everything added to the drawing
  // later (cables, the ghost) silently became a shield in front of the ports. Paint
  // order and hit order are separate concerns and are now implemented separately.
  const PORT_HIT_PX = 9;    // radius a socket answers to, in screen pixels
  const CABLE_GRAB_PX = 8;  // half-width of a cable's grab band, in screen pixels

  function portAt(w) {
    const ids = Object.keys(geo);
    const r = PORT_HIT_PX / view.zoom;
    let best = null, bestD = Infinity;
    // Reverse order: the last device drawn is the one painted on top, so it wins ties
    // where two chassis overlap.
    for (let i = ids.length - 1; i >= 0; i--) {
      const g = geo[ids[i]];
      if (!g) continue;
      for (const p of g.ports) {
        const dx = (g.pos.x + p.x) - w.x;
        const dy = (g.pos.y + p.y) - w.y;
        const d = dx * dx + dy * dy;
        if (d <= r * r && d < bestD) { bestD = d; best = { deviceId: ids[i], iface: p.name }; }
      }
    }
    return best;
  }

  function deviceAt(w) {
    const ids = Object.keys(geo);
    for (let i = ids.length - 1; i >= 0; i--) {
      const g = geo[ids[i]];
      if (!g) continue;
      if (w.x >= g.pos.x && w.x <= g.pos.x + g.size.w &&
          w.y >= g.pos.y && w.y <= g.pos.y + g.size.h) return { deviceId: ids[i] };
    }
    return null;
  }

  function distToSegment(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    let t = len2 ? ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + vx * t, cy = a.y + vy * t;
    return Math.sqrt((p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy));
  }

  function cableAt(w) {
    const links = (state.topology && Array.isArray(state.topology.links)) ? state.topology.links : [];
    const grab = CABLE_GRAB_PX / view.zoom;
    for (let i = links.length - 1; i >= 0; i--) {
      const l = links[i];
      if (!l || !l.a || !l.b) continue;
      const a = portWorld(l.a.deviceId, l.a.iface);
      const b = portWorld(l.b.deviceId, l.b.iface);
      if (!a || !b) continue;
      if (distToSegment(w, a, b) <= grab) return l;
    }
    return null;
  }

  function hitTest(sx, sy) {
    const w = screenToWorld(sx, sy);
    const port = portAt(w);
    if (port) return { kind: 'port', deviceId: port.deviceId, iface: port.iface };
    const dev = deviceAt(w);
    if (dev) return { kind: 'device', deviceId: dev.deviceId };
    const link = cableAt(w);
    if (link) return { kind: 'link', linkId: link.id };
    return { kind: 'background' };
  }

  function worldToScreen(wx, wy) {
    return { x: wx * view.zoom + view.panX, y: wy * view.zoom + view.panY };
  }
  function screenToWorld(sx, sy) {
    return { x: (sx - view.panX) / view.zoom, y: (sy - view.panY) / view.zoom };
  }

  function applyView() {
    world.setAttribute('transform', 'translate(' + view.panX + ',' + view.panY + ') scale(' + view.zoom + ')');
    overlay.setAttribute('transform', 'translate(' + view.panX + ',' + view.panY + ') scale(' + view.zoom + ')');
    packetsLayer.setAttribute('transform', 'translate(' + view.panX + ',' + view.panY + ') scale(' + view.zoom + ')');
  }

  // Frame the whole board.
  //
  // This used to be `view.zoom = 1; view.panX = 60; view.panY = 40` - a hard-coded reset
  // wearing the label "Fit to view". On any board bigger than the initial window it threw
  // most of the network off-screen, which is the opposite of what the button is for
  // (issue #56). It now measures the devices, scales them to the viewport, and centres
  // the result.
  function fitView() {
    const devices = (state.topology && Array.isArray(state.topology.devices))
      ? state.topology.devices : [];
    const r = rect();
    const vw = (r && r.width) || 800;
    const vh = (r && r.height) || 600;
    const pad = 40;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    for (const d of devices) {
      if (!d || !d.id) continue;
      const g = geo[d.id];
      const pos = g ? g.pos : ((state.topology.layout && state.topology.layout[d.id]) || null);
      if (!pos) continue;
      const size = g ? g.size
        : deviceSize(Array.isArray(d.interfaces) ? d.interfaces.length : 0);
      any = true;
      if (pos.x < minX) minX = pos.x;
      if (pos.y < minY) minY = pos.y;
      if (pos.x + size.w > maxX) maxX = pos.x + size.w;
      if (pos.y + size.h > maxY) maxY = pos.y + size.h;
    }

    // An empty board has nothing to frame, so the default view is the honest answer.
    if (!any) {
      view.zoom = 1; view.panX = 60; view.panY = 40;
      applyView();
      return;
    }

    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const availW = Math.max(50, vw - pad * 2);
    const availH = Math.max(50, vh - pad * 2);

    // Never zoom past the manual limits, and never past 1: showing a two-device board at
    // 3x is technically "fitted" and useless.
    let zoom = Math.min(availW / bw, availH / bh, 1);
    zoom = Math.min(3, Math.max(0.25, zoom));

    view.zoom = zoom;
    view.panX = pad + (availW - bw * zoom) / 2 - minX * zoom;
    view.panY = pad + (availH - bh * zoom) / 2 - minY * zoom;
    applyView();
  }
  function zoomBy(f) {
    view.zoom = Math.min(3, Math.max(0.25, view.zoom * f));
    applyView();
  }

  // ---------- interaction ----------
  let drag = null; // { mode: 'device'|'pan', id, dx, dy, moved }
  const rect = () => svg.getBoundingClientRect();

  svg.addEventListener('pointerdown', function (e) {
    const r = rect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const hit = hitTest(sx, sy);

    // 1. port click → cabling.
    //
    // This is the SAME callback the first click of a cable uses, so while a ghost cable
    // is in flight it is also the code path that completes the link: app.js's
    // PFCanvas.on.portClick sees a pending connection and connects it. All this handler
    // has to do is make sure the click gets there instead of starting a pan (issue #61).
    if (hit.kind === 'port') {
      e.stopPropagation();
      if (on.portClick) on.portClick(hit.deviceId, hit.iface);
      return;
    }

    // 2. device body → select and drag the chassis. Never a cable drip (#66).
    if (hit.kind === 'device') {
      if (on.select) on.select(hit.deviceId);
      drag = { mode: 'device', id: hit.deviceId, moved: false, startSx: sx, startSy: sy };
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    // 3. cable → inspect it. Only reached when no port and no body answered, so the
    //    grab band cannot shadow a socket (issue #66).
    if (hit.kind === 'link') {
      if (on.selectLink) on.selectLink(hit.linkId);
      e.preventDefault();
      return;
    }

    // 4. background: pan (and place-on-click / cancel handled on pointerup)
    drag = { mode: 'pan', moved: false, startSx: sx, startSy: sy, startPanX: view.panX, startPanY: view.panY };
    svg.setPointerCapture(e.pointerId);
  });

  svg.addEventListener('pointermove', function (e) {
    const r = rect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;

    if (drag && drag.mode === 'pan') {
      const dx = sx - drag.startSx, dy = sy - drag.startSy;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      view.panX = drag.startPanX + dx;
      view.panY = drag.startPanY + dy;
      applyView();
      svg.classList.add('dragging');
    } else if (drag && drag.mode === 'device') {
      const dx = sx - drag.startSx, dy = sy - drag.startSy;
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        drag.moved = true;
        const w = screenToWorld(sx, sy);
        // move the device element live
        const g = world.querySelector('[data-device-id="' + drag.id + '"]');
        if (g) {
          const pos = (state.topology.layout && state.topology.layout[drag.id]) || { x: 0, y: 0 };
          g.setAttribute('transform', 'translate(' + (pos.x + dx / view.zoom) + ',' + (pos.y + dy / view.zoom) + ')');
          // ...and the cables attached to it, or the box slides out from under them (#1228). Applied
          // incrementally, so this is the movement since the previous pointermove.
          const stepX = dx / view.zoom - (drag.previewX || 0);
          const stepY = dy / view.zoom - (drag.previewY || 0);
          if (stepX || stepY) {
            dragPreview(drag.id, stepX, stepY);
            drag.previewX = dx / view.zoom;
            drag.previewY = dy / view.zoom;
          }
        }
      }
    } else if (ghostLine && state.connecting) {
      const w = screenToWorld(sx, sy);
      ghostLine.setAttribute('x2', w.x);
      ghostLine.setAttribute('y2', w.y);
    }
  });

  // --- is this point covered by something floating over the canvas? -------------
  //
  // A press can start on the drawing surface and be released over an overlay: the
  // toolbar sits on top of the canvas at bottom-left, and pointer capture keeps sending
  // the events to the SVG. Placing a device at those coordinates creates it *underneath*
  // the panel, where it cannot be clicked, dragged or deleted - it exists on the server
  // and is unreachable with the mouse (#33).
  //
  // So ask the document what is actually at that pixel. Anything that is not the SVG or
  // inside it is an overlay, and a placement aimed at an overlay places nothing.
  function pointElement(clientX, clientY) {
    if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return null;
    try { return document.elementFromPoint(clientX, clientY) || null; } catch (ignored) { return null; }
  }

  // Pure, and exposed on PFCanvas so it can be tested without a browser: does `el`
  // belong to the drawing surface, or is it something painted over it?
  function elementCoversPoint(el, root) {
    if (!el) return false;            // nothing reported - do not block a placement on a guess
    if (el === root) return false;    // the canvas itself
    if (root && typeof root.contains === 'function' && root.contains(el)) return false; // a device or port
    return true;
  }

  svg.addEventListener('pointerup', function (e) {
    const r = rect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (drag) {
      if (drag.mode === 'device') {
        const pos = (state.topology.layout && state.topology.layout[drag.id]) || { x: 100, y: 100 };
        if (drag.moved) {
          const w = screenToWorld(sx, sy);
          const dx = sx - drag.startSx, dy = sy - drag.startSy;
          const nx = Math.round(pos.x + dx / view.zoom);
          const ny = Math.round(pos.y + dy / view.zoom);
          if (on.move) on.move(drag.id, nx, ny);
          // Redraw from the new layout: the live drag moved the box and its cables on screen, but the
          // socket table and the frame both need the final position before the next ping, hit test or
          // click (#1228).
          try { render(state.topology); } catch (ignored) { /* render reports its own failures */ }
        }
      } else if (drag.mode === 'pan') {
        if (!drag.moved) {
          // click on background: cancel a cable in flight, else place or deselect
          const w = screenToWorld(sx, sy);
          if (state.connecting) {
            // A click on empty canvas means "never mind". Without this the ghost keeps
            // following the pointer after the user has given up, and the canvas looks
            // stuck in a mode it will not leave (#61).
            cancelConnecting();
          } else if (state.placing && on.place) {
            if (elementCoversPoint(pointElement(e.clientX, e.clientY), svg)) {
              // Under the toolbar or another floating panel: say so rather than place a
              // device that will be invisible.
              if (typeof on.placeBlocked === 'function') on.placeBlocked(w.x, w.y, state.placing);
            } else {
              on.place(w.x, w.y, state.placing);
            }
          }
          else if (on.select) on.select(null);
        }
      }
      drag = null;
      svg.classList.remove('dragging');
    }
  });

  svg.addEventListener('wheel', function (e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const r = rect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const before = screenToWorld(sx, sy);
    view.zoom = Math.min(3, Math.max(0.25, view.zoom * factor));
    applyView();
    const after = screenToWorld(sx, sy);
    view.panX += (after.x - before.x) * view.zoom;
    view.panY += (after.y - before.y) * view.zoom;
    applyView();
  }, { passive: false });

  // Right-click and double-click go through the same precedence as a plain press: the
  // device under the pointer, found geometrically, so neither can be stolen by a cable
  // that happens to be drawn across a chassis (issue #66).
  function deviceUnder(e) {
    const devEl = e.target && e.target.closest ? e.target.closest('[data-device-id]') : null;
    if (devEl) return devEl.getAttribute('data-device-id');
    const r = rect();
    const hit = hitTest(e.clientX - r.left, e.clientY - r.top);
    if (hit.kind === 'port' || hit.kind === 'device') return hit.deviceId;
    return null;
  }

  svg.addEventListener('contextmenu', function (e) {
    // `r` belongs to other handlers' closures; this one needs its own rect, because a
    // contextmenu fires without a pointerdown having measured first.
    const r = svg.getBoundingClientRect();
    const hit = hitTest(e.clientX - r.left, e.clientY - r.top);
    if (hit.kind === 'link') {
      // A cable is right-clickable in its own right (issue #86). Previously only a device
      // could raise the menu, so the one object a person wants to remove after a bad drag
      // had no menu at all.
      e.preventDefault();
      if (on.contextLink) on.contextLink(hit.linkId, e.clientX, e.clientY);
      return;
    }
    const id = deviceUnder(e);
    if (id) {
      e.preventDefault();
      if (on.context) on.context(id, e.clientX, e.clientY);
    }
  });

  svg.addEventListener('dblclick', function (e) {
    const id = deviceUnder(e);
    if (id && on.dblclick) on.dblclick(id);
  });

  // ---------- packet animation ----------
  //
  // A packet does not travel from the middle of one box to the middle of another: it leaves a socket
  // and arrives at a socket, which is exactly the line the cable is drawn along. This used to tween
  // device centre -> device centre, so the dot cut across empty canvas while the cable ran somewhere
  // else, and after a device had been dragged it matched neither position (#1228).
  function socketPoint(deviceId, iface) {
    const p = portWorld(deviceId, iface);
    if (p) return { x: p.x, y: p.y };
    // No socket position: fall back to the box, but only where the box actually is. Inventing a
    // position for a device with no layout entry is how a dot ends up flying to the top-left corner
    // of the grid and looking like a physics bug.
    const d = ((state.topology && state.topology.devices) || []).find(function (x) { return x.id === deviceId; });
    if (!d) return null;
    const pos = state.topology.layout && state.topology.layout[deviceId];
    if (!pos) return null;
    const size = deviceSize(Array.isArray(d.interfaces) ? d.interfaces.length : 0);
    return { x: pos.x + size.w / 2, y: pos.y + size.h / 2 };
  }

  // Redraw every tracked cable from the current socket positions. Used after geometry is recomputed,
  // so the picture and the animation cannot disagree about where a socket is.
  function refreshCableGeometry() {
    for (const c of cableNodes) {
      const a = portWorld(c.a.deviceId, c.a.iface);
      const b = portWorld(c.b.deviceId, c.b.iface);
      if (!a || !b) continue;
      c.from = { x: a.x, y: a.y };
      c.to = { x: b.x, y: b.y };
      for (const n of c.nodes) {
        if (!n || !n.setAttribute) continue;
        n.setAttribute('x1', a.x); n.setAttribute('y1', a.y);
        n.setAttribute('x2', b.x); n.setAttribute('y2', b.y);
      }
    }
  }

  // Geometry is computed during render(). If the layout has moved since - a drag that was persisted
  // but not yet redrawn, a remote client's move that arrived mid-animation - the socket table is stale
  // and every consumer of it (animation, hit testing) is quietly wrong. Recompute for the devices
  // whose position no longer matches, then redraw the cables that hang off them.
  function ensureGeoCurrent() {
    const devices = (state.topology && state.topology.devices) || [];
    let changed = false;
    for (const d of devices) {
      if (!d || typeof d.id !== 'string') continue;
      const pos = state.topology.layout && state.topology.layout[d.id];
      const g = geo[d.id];
      if (!g) {
        try { computeGeo(d); changed = true; } catch (ignored) { /* reported by render */ }
        continue;
      }
      if (pos && (g.pos.x !== pos.x || g.pos.y !== pos.y)) {
        try { computeGeo(d); changed = true; } catch (ignored) { /* reported by render */ }
      }
    }
    if (changed) refreshCableGeometry();
    return changed;
  }

  // While a box is being dragged, its cables must move with it. Straight-line geometry makes this
  // exact: shift the endpoints that belong to the dragged device by the same delta and leave the far
  // ends alone.
  function dragPreview(deviceId, dx, dy) {
    const g = geo[deviceId];
    if (g) g.pos = { x: g.pos.x + dx, y: g.pos.y + dy };
    if (portPos[deviceId]) {
      for (const name of Object.keys(portPos[deviceId])) {
        const p = portPos[deviceId][name];
        portPos[deviceId][name] = { x: p.x + dx, y: p.y + dy };
      }
    }
    for (const c of cableNodes) {
      const aMoves = c.a.deviceId === deviceId;
      const bMoves = c.b.deviceId === deviceId;
      if (!aMoves && !bMoves) continue;
      if (aMoves) c.from = { x: c.from.x + dx, y: c.from.y + dy };
      if (bMoves) c.to = { x: c.to.x + dx, y: c.to.y + dy };
      for (const n of c.nodes) {
        if (!n || !n.setAttribute) continue;
        n.setAttribute('x1', c.from.x); n.setAttribute('y1', c.from.y);
        n.setAttribute('x2', c.to.x); n.setAttribute('y2', c.to.y);
      }
    }
  }

  function deviceCenter(deviceId) {
    const d = (state.topology.devices || []).find(function (x) { return x.id === deviceId; });
    if (!d) return null;
    const pos = (state.topology.layout && state.topology.layout[d.id]) || { x: 100, y: 100 };
    const size = deviceSize(d.interfaces.length);
    return { x: pos.x + size.w / 2, y: pos.y + size.h / 2 };
  }

  function tween(dot, x1, y1, x2, y2, duration) {
    return new Promise(function (resolve) {
      const t0 = performance.now();
      function step(now) {
        let k = (now - t0) / duration;
        if (k >= 1) k = 1;
        const x = x1 + (x2 - x1) * ease(k);
        const y = y1 + (y2 - y1) * ease(k);
        dot.setAttribute('cx', x); dot.setAttribute('cy', y);
        if (k < 1) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
  }
  function ease(k) { return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; }

  async function animateEvents(events) {
    packetsLayer.innerHTML = '';
    const frames = (events || []).filter(function (e) { return e.type === 'frame'; });
    if (!frames.length) return;
    // The layout may have moved since the last frame was drawn (a drag that was persisted without a
    // redraw, or a move from another client). Recompute before animating rather than after.
    ensureGeoCurrent();
    for (const f of frames) {
      const a = socketPoint(f.from, f.fromIface);
      const b = socketPoint(f.to, f.toIface);
      if (!a || !b) continue;
      const dot = el('circle', { r: 6, class: 'packet' }, packetsLayer);
      await tween(dot, a.x, a.y, b.x, b.y, 240);
      dot.remove();
      await new Promise(function (res) { setTimeout(res, 40); });
    }
  }

  function setPlacing(spec) { state.placing = spec; }
  function setConnecting(c) { state.connecting = c; render(state.topology); }

  // Abandon an in-flight cable. One place, so every cancel route (Esc in app.js, a
  // click on empty canvas, a second click on the same port) leaves the same state and
  // the same redraw behind.
  function cancelConnecting() {
    if (!state.connecting) return false;
    state.connecting = null;
    render(state.topology);
    if (typeof on.connectCancel === 'function') {
      try { on.connectCancel(); } catch (ignored) { /* UI reporting must not throw */ }
    }
    return true;
  }

  function setSelected(id) { state.selected = id; state.selectedLink = null; render(state.topology); }
  function setSelectedLink(id) { state.selectedLink = id; state.selected = null; render(state.topology); }
  function setTopology(t) { state.topology = t; render(t); }

  window.PFCanvas = {
    render: render,
    setTopology: setTopology,
    setSelected: setSelected,
    setSelectedLink: setSelectedLink,
    getSelectedLink: function () { return state.selectedLink; },
    setPlacing: setPlacing,
    setConnecting: setConnecting,
    getConnecting: function () { return state.connecting; },
    animateEvents: animateEvents,
    socketPoint: socketPoint,
    ensureGeoCurrent: ensureGeoCurrent,
    dragPreview: dragPreview,
    refreshCableGeometry: refreshCableGeometry,
    // What the last frame drew, so a test can assert a cable is continuous from socket to socket.
    cables: function () { return cableNodes.map(function (c) { return { id: c.id, from: c.from, to: c.to }; }); },
    fitView: fitView,
    zoomBy: zoomBy,
    deviceCenter: deviceCenter,
    // Exposed for the hit-testing tests and for the devtools console: where a socket
    // actually is in world coordinates, and what the mouse would resolve to.
    // Exposed for the overlay-placement test: the rule that decides whether a point on
    // the canvas is actually covered by something floating over it (#33).
    elementCoversPoint: elementCoversPoint,
    portWorld: function (deviceId, iface) {
      const p = portWorld(deviceId, iface);
      return p ? { x: p.x, y: p.y } : null;
    },
    hitTest: hitTest,
    cancelConnecting: cancelConnecting,
    on: on
  };
})();
