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
    select: null,     // (deviceId | null)
    move: null,       // (deviceId, x, y)
    portClick: null,  // (deviceId, iface)
    context: null,    // (deviceId, x, y)
    dblclick: null,   // (deviceId)
    renderError: null // (failures[], error) - a redraw could not draw everything
  };

  const ICONS = { router: '🧭', switch: '🔀', 'l3-switch': '🔀', host: '🖥️', server: '🗄️', firewall: '🛡️', wireless: '📶', ptp: '📻', cloud: '☁️', ont: '📡', ap: '📶' };

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

      drawGrid();

      // pass 1: compute geometry so links know where the ports are. A device whose
      // interfaces are not a list cannot be laid out, so it is skipped - but it is
      // recorded, because a device vanishing silently is the same complaint as #20.
      for (const d of devices) {
        try { computeGeo(d); } catch (e) { skip('device', d && d.id, e); }
      }

      // links (under devices)
      for (const link of links) {
        try {
          const a = portWorld(link.a.deviceId, link.a.iface);
          const b = portWorld(link.b.deviceId, link.b.iface);
          if (!a || !b) continue;
          const sel = state.selectedLink === link.id;
          // wide invisible hit target so a 2px line is actually clickable
          el('line', { class: 'link-hit', x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'data-link-id': link.id }, world);
          // A radio association is not a cable. Drawing it as one made a wireless lab
          // look wired, and hid the fact that the link is a band rather than a run of
          // copper or glass.
          const isWireless = String(link.mediaId || link.media || '').indexOf('wireless') === 0;
          el('line', {
            class: 'link' + (isWireless ? ' link-wireless' : '') + (sel ? ' selected' : ''),
            x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'data-link-id': link.id
          }, world);
        } catch (e) { skip('link', link && link.id, e); }
      }

      // devices
      for (const d of devices) {
        if (d && failedDevices[d.id]) continue;
        try { drawDevice(d); } catch (e) { skip('device', d && d.id, e); }
      }

      // ghost link while cabling
      if (state.connecting) {
        const a = portWorld(state.connecting.deviceId, state.connecting.iface);
        if (a) {
          ghostLine = el('line', { class: 'link-ghost', x1: a.x, y1: a.y, x2: a.x, y2: a.y }, overlay);
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

  function drawDevice(d) {
    const g = geo[d.id];
    const color = d.color || '#3f7cff';
    const node = el('g', { 'data-device-id': d.id, class: 'device' }, world);
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
    function peerLabel(portName) {
      const link = (state.topology.links || []).find(function (l) {
        return (l.a.deviceId === d.id && l.a.iface === portName) ||
               (l.b.deviceId === d.id && l.b.iface === portName);
      });
      if (!link) return null;
      const other = link.a.deviceId === d.id ? link.b : link.a;
      const dev = (state.topology.devices || []).find(function (x) { return x.id === other.deviceId; });
      return (dev ? dev.name : other.deviceId) + ':' + other.iface;
    }
    // A 12-port cut-off was too tight: a router with 13 sockets showed no labels at
    // all, which is precisely when you need them. Labels are cheap; only genuinely
    // dense hardware (48-port switches) hides them until you select the device.
    const dense = g.ports.length > 24;
    const showLabels = state.selected === d.id || !dense;
    for (const p of g.ports) {
      const iface = d.interfaces.find(function (i) { return i.name === p.name; });
      const peer = peerLabel(p.name);
      const connected = !!peer || !!iface.peer;
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
        (peer ? ' · cabled to ' + peer : ' · not cabled') +
        (iface.enabled === false ? ' · administratively down' : '');
      const dot = el('circle', {
        cx: p.x, cy: p.y, r: 5,
        class: 'port' + (connected ? ' connected' : '') +
          (iface.enabled === false ? ' down' : '') +
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

  function fitView() {
    view.zoom = 1; view.panX = 60; view.panY = 40;
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
    const target = e.target;

    // port click → cabling
    if (target.classList && target.classList.contains('port')) {
      e.stopPropagation();
      const devId = target.getAttribute('data-device-id');
      const iface = target.getAttribute('data-iface');
      if (on.portClick) on.portClick(devId, iface);
      return;
    }

    const devEl = target.closest ? target.closest('[data-device-id]') : null;
    if (devEl) {
      const id = devEl.getAttribute('data-device-id');
      if (on.select) on.select(id);
      drag = { mode: 'device', id: id, moved: false, startSx: sx, startSy: sy };
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    // link click → inspect the cable
    const linkEl = target.closest ? target.closest('[data-link-id]') : null;
    if (linkEl) {
      const lid = linkEl.getAttribute('data-link-id');
      if (on.selectLink) on.selectLink(lid);
      e.preventDefault();
      return;
    }

    // background: pan (and place-on-click handled on pointerup)
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
        }
      }
    } else if (ghostLine && state.connecting) {
      const w = screenToWorld(sx, sy);
      ghostLine.setAttribute('x2', w.x);
      ghostLine.setAttribute('y2', w.y);
    }
  });

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
        }
      } else if (drag.mode === 'pan') {
        if (!drag.moved) {
          // click on background: place device or deselect
          const w = screenToWorld(sx, sy);
          if (state.placing && on.place) on.place(w.x, w.y, state.placing);
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

  svg.addEventListener('contextmenu', function (e) {
    const devEl = e.target.closest ? e.target.closest('[data-device-id]') : null;
    if (devEl) {
      e.preventDefault();
      const id = devEl.getAttribute('data-device-id');
      if (on.context) on.context(id, e.clientX, e.clientY);
    }
  });

  svg.addEventListener('dblclick', function (e) {
    const devEl = e.target.closest ? e.target.closest('[data-device-id]') : null;
    if (devEl) {
      const id = devEl.getAttribute('data-device-id');
      if (on.dblclick) on.dblclick(id);
    }
  });

  // ---------- packet animation ----------
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
    const frames = events.filter(function (e) { return e.type === 'frame'; });
    for (const f of frames) {
      const a = deviceCenter(f.from);
      const b = deviceCenter(f.to);
      if (!a || !b) continue;
      const dot = el('circle', { r: 6, class: 'packet' }, packetsLayer);
      await tween(dot, a.x, a.y, b.x, b.y, 240);
      dot.remove();
      await new Promise(function (res) { setTimeout(res, 40); });
    }
  }

  function setPlacing(spec) { state.placing = spec; }
  function setConnecting(c) { state.connecting = c; render(state.topology); }
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
    fitView: fitView,
    zoomBy: zoomBy,
    deviceCenter: deviceCenter,
    on: on
  };
})();
