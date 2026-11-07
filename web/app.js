'use strict';
// app.js — PacketForge frontend logic: state, API, palette, inspector, console, simulation.
(function () {
  const TOPO = 'default';
  let catalog = { specs: [], categories: {} };
  let topo = null;
  let selectedId = null;
  let selectedLink = null;
  let placing = null;
  const consoleLog = {}; // deviceId -> { lines: [], prompt: '>' }

  const $ = function (s) { return document.querySelector(s); };

  // ---------- API ----------
  async function api(method, path, body) {
    const opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch('/api' + path, opts);
    if (!res.ok) {
      let msg = res.status + ' ' + res.statusText;
      try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) {}
      throw new Error(msg);
    }
    return res.json();
  }

  function deviceById(id) {
    return (topo && topo.devices || []).find(function (d) { return d.id === id; }) || null;
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.add('hidden'); }, 2600);
  }
  function setStatus(msg) { $('#status-left').textContent = msg; }

  // ---------- palette ----------
  const CAT_LABELS = {
    router: 'Routers', switch: 'Switches', 'l3-switch': 'L3 Switches', firewall: 'Firewalls',
    wireless: 'Wireless APs', ptp: 'PTP Radios', olt: 'OLTs (PON headend)', ont: 'ONT / ONU',
    splitter: 'PON Splitters (passive)',
    modem: 'Modems (DOCSIS / DSL)', powerline: 'Powerline / MoCA',
    host: 'End Devices', server: 'Servers', nas: 'NAS', desktop: 'Desktops', laptop: 'Laptops',
    phone: 'Phones', tablet: 'Tablets', printer: 'Printers', camera: 'IP Cameras',
    nvr: 'NVR / DVR', iot: 'IoT / Smart Home', cloud: 'Cloud / WAN'
  };
  // Network gear first, then the things that plug into it.
  const CAT_ORDER = ['router', 'switch', 'l3-switch', 'firewall', 'wireless', 'ptp',
    'olt', 'splitter', 'ont', 'modem', 'powerline', 'host', 'server', 'nas', 'desktop', 'laptop',
    'phone', 'tablet', 'printer', 'camera', 'nvr', 'iot', 'cloud'];
  const BADGE_LABELS = {
    router: 'Router', switch: 'Switch', 'l3-switch': 'L3 Switch', firewall: 'Firewall',
    wireless: 'AP', ptp: 'PTP', olt: 'OLT', ont: 'ONT', splitter: 'Splitter', modem: 'Modem', powerline: 'Powerline',
    host: 'Host', server: 'Server', nas: 'NAS', desktop: 'Desktop', laptop: 'Laptop',
    phone: 'Phone', tablet: 'Tablet', printer: 'Printer', camera: 'Camera', nvr: 'NVR',
    iot: 'IoT', cloud: 'WAN'
  };
  const VENDOR_LABELS = {
    'cisco': 'Cisco', 'juniper': 'Juniper', 'arista': 'Arista', 'mikrotik': 'MikroTik',
    'huawei': 'Huawei', 'ubiquiti': 'Ubiquiti', 'tp-link': 'TP-Link', 'netgear': 'Netgear',
    'zyxel': 'Zyxel', 'gl-inet': 'GL.iNet', 'protectli': 'Protectli', 'qotom': 'Qotom',
    'raspberrypi': 'Raspberry Pi', 'qnap': 'QNAP', 'trendnet': 'TRENDnet', 'adtran': 'ADTRAN',
    'generic': 'Generic'
  };
  let paletteFilter = { q: '', vendor: '', type: '' };

  function vendorLabel(v) {
    return VENDOR_LABELS[v] || (v ? v.charAt(0).toUpperCase() + v.slice(1) : 'Unknown');
  }

  function buildFilterControls() {
    const specs = catalog.specs || [];
    const vendorSel = $('#pf-vendor');
    if (vendorSel.options.length <= 1) {
      const vendors = [];
      const seen = {};
      for (const s of specs) { if (!seen[s.vendor]) { seen[s.vendor] = 1; vendors.push(s.vendor); } }
      for (const v of vendors) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = vendorLabel(v) + ' (' + specs.filter(function (s) { return s.vendor === v; }).length + ')';
        vendorSel.appendChild(o);
      }
    }
    const typeSel = $('#pf-type');
    if (typeSel.options.length <= 1) {
      for (const c of CAT_ORDER) {
        if (specs.some(function (s) { return s.category === c; })) {
          const o = document.createElement('option');
          o.value = c;
          o.textContent = CAT_LABELS[c] || c;
          typeSel.appendChild(o);
        }
      }
    }
  }

  function renderPalette() {
    const list = $('#palette-list');
    list.innerHTML = '';
    const specs = catalog.specs || [];
    buildFilterControls();

    const q = paletteFilter.q.trim().toLowerCase();
    const filtered = specs.filter(function (s) {
      if (paletteFilter.vendor && s.vendor !== paletteFilter.vendor) return false;
      if (paletteFilter.type && s.category !== paletteFilter.type) return false;
      if (q) {
        const hay = (s.vendor + ' ' + s.model + ' ' + s.label + ' ' + (s.description || '') + ' ' + (s.category || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });

    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'palette-empty';
      empty.textContent = 'No devices match your search / filters.';
      list.appendChild(empty);
      return;
    }

    // group by manufacturer (vendor), collapsible
    const groups = {};
    for (const s of filtered) { (groups[s.vendor] = groups[s.vendor] || []).push(s); }
    const vendorNames = Object.keys(groups).sort(function (a, b) { return vendorLabel(a).localeCompare(vendorLabel(b)); });

    for (const v of vendorNames) {
      const items = groups[v];
      const sec = document.createElement('div');
      sec.className = 'vendor-group open';
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'vendor-head';
      head.innerHTML = '<span class="vh-caret">▾</span><span class="vh-name">' + vendorLabel(v) + '</span><span class="vh-count">' + items.length + '</span>';
      head.addEventListener('click', function () {
        sec.classList.toggle('open');
        head.querySelector('.vh-caret').textContent = sec.classList.contains('open') ? '▾' : '▸';
      });
      const body = document.createElement('div');
      body.className = 'vendor-body';
      for (const s of items) {
        const card = document.createElement('div');
        card.className = 'device-card';
        card.setAttribute('data-vendor', s.vendor);
        card.setAttribute('data-model', s.model);
        card.title = s.description || (s.vendor + ' ' + s.model);
        card.innerHTML =
          '<span class="dc-icon">' + (iconFor(s) || '📦') + '</span>' +
          '<span class="dc-text"><div class="dc-label">' + s.label + '</div>' +
          '<div class="dc-sub">' + s.model + '</div></span>' +
          '<span class="dc-badge dc-badge-' + (s.category || 'other') + '">' + (BADGE_LABELS[s.category] || s.category || '?') + '</span>';
        card.addEventListener('click', function () {
          placing = s;
          document.querySelectorAll('.device-card').forEach(function (c) { c.classList.remove('active'); });
          card.classList.add('active');
          PFCanvas.setPlacing(s);
          setStatus('Click the canvas to place a ' + s.label + ' (Esc to cancel)');
        });
        body.appendChild(card);
      }
      sec.appendChild(head);
      sec.appendChild(body);
      list.appendChild(sec);
    }
  }

  function iconFor(s) {
    const m = {
      router: '🧭', switch: '🔀', 'l3-switch': '🔀', firewall: '🛡️', wireless: '📶', ptp: '📻',
      olt: '🏢', ont: '📡', splitter: '🔀', modem: '📞', powerline: '🔌',
      host: '🖥️', server: '🗄️', nas: '💾', desktop: '🖥️', laptop: '💻',
      phone: '📱', tablet: '📲', printer: '🖨️', camera: '📷', nvr: '🎥', iot: '🏠',
      cloud: '☁️', ap: '📶'
    };
    return m[s.category] || m[s.icon] || '📦';
  }

  $('#pf-search').addEventListener('input', function () { paletteFilter.q = this.value; renderPalette(); });
  $('#pf-vendor').addEventListener('change', function () { paletteFilter.vendor = this.value; renderPalette(); });
  $('#pf-type').addEventListener('change', function () { paletteFilter.type = this.value; renderPalette(); });

  // ---------- canvas callbacks ----------
  PFCanvas.on.place = async function (x, y, spec) {
    try {
      const r = await api('POST', '/topologies/' + TOPO + '/devices', { vendor: spec.vendor, model: spec.model, x: Math.round(x), y: Math.round(y) });
      topo = r.state;
      placing = null;
      document.querySelectorAll('.device-card').forEach(function (c) { c.classList.remove('active'); });
      PFCanvas.setPlacing(null);
      PFCanvas.setTopology(topo);
      select(r.device.id);
      setStatus('Placed ' + r.device.label);
    } catch (e) { toast(e.message); }
  };

  PFCanvas.on.select = function (id) { select(id); };
  PFCanvas.on.selectLink = function (id) { selectLink(id); };

  PFCanvas.on.move = async function (id, x, y) {
    if (!topo.layout) topo.layout = {};
    topo.layout[id] = { x: x, y: y };
    try { await api('POST', '/topologies/' + TOPO + '/layout', { positions: { [id]: { x: x, y: y } } }); } catch (e) {}
  };

  // Modal that lets the user choose the physical medium for a new cable.
  function pickLinkMedia(options, verdict, portA, portB) {
    return new Promise(function (resolve) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';

      let html = '<div class="modal-title">Cable ' + esc(portA) + ' &rarr; ' + esc(portB) + '</div>';
      html += '<div class="modal-sub">Choose the physical medium' +
        (verdict && verdict.speedMbps ? ' &middot; negotiated ' + verdict.speedMbps + ' Mbps' : '') + '</div>';
      html += '<div class="media-list">';
      for (const o of options) {
        const sel = (verdict && o.id === verdict.mediaId) || (!verdict && o === options[0]);
        html += '<label class="media-opt' + (sel ? ' sel' : '') + '">' +
          '<input type="radio" name="pf-media" value="' + esc(o.id) + '"' + (sel ? ' checked' : '') + '>' +
          '<span class="mo-name">' + esc(o.name || o.id) + '</span>' +
          '<span class="mo-meta">' + esc(o.family || '') + (o.maxRangeM ? ' &middot; ' + o.maxRangeM + ' m' : '') + '</span>' +
          '</label>';
      }
      html += '</div>';
      html += '<div class="modal-actions">' +
        '<button class="btn" data-act="cancel">Cancel</button>' +
        '<button class="btn primary" data-act="ok">Connect</button></div>';
      box.innerHTML = html;
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      function done(val) {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        resolve(val);
      }
      function onKey(e) { if (e.key === 'Escape') done(null); }
      document.addEventListener('keydown', onKey);
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) { done(null); return; }
        const act = e.target.getAttribute('data-act');
        if (act === 'cancel') { done(null); return; }
        if (act === 'ok') {
          const chosen = box.querySelector('input[name=pf-media]:checked');
          done(chosen ? chosen.value : null);
        }
      });
    });
  }

  function devName(id) {
    const d = deviceById(id);
    return d ? d.name : id;
  }

  // Clicking a second port: dry-run the cable, block impossible ones, then
  // let the user choose the medium when more than one is valid.
  PFCanvas.on.portClick = async function (deviceId, iface) {
    const c = PFCanvas.getConnecting();
    if (!c) {
      PFCanvas.setConnecting({ deviceId: deviceId, iface: iface });
      setStatus('Now click the destination port (Esc to cancel)');
      return;
    }
    if (c.deviceId === deviceId) { PFCanvas.setConnecting(null); setStatus('Ready'); return; }

    // 1. Physical feasibility (dry run)
    let verdict = null;
    let options = [];
    try {
      const v = await api('POST', '/topologies/' + TOPO + '/validate-link', {
        a: { deviceId: c.deviceId, iface: c.iface },
        b: { deviceId: deviceId, iface: iface }
      });
      verdict = v.verdict;
      options = v.mediaOptions || [];
    } catch (e) { /* fall through; the server will decide */ }

    if (verdict && verdict.ok === false) {
      const err = (verdict.errors && verdict.errors[0]) || null;
      toast('Impossible: ' + (err ? err.message : 'incompatible ports'));
      PFCanvas.setConnecting(null);
      setStatus('Blocked: ' + (err ? err.code : 'E_LINK'));
      return;
    }

    // 2. Choose the medium
    let mediaId = verdict ? verdict.mediaId : null;
    if (options.length > 1) {
      const picked = await pickLinkMedia(options, verdict,
        devName(c.deviceId) + '/' + c.iface, devName(deviceId) + '/' + iface);
      if (!picked) { PFCanvas.setConnecting(null); setStatus('Ready'); return; }
      mediaId = picked;
    }

    // 3. Connect
    try {
      const r = await api('POST', '/topologies/' + TOPO + '/links', {
        a: { deviceId: c.deviceId, iface: c.iface },
        b: { deviceId: deviceId, iface: iface },
        mediaId: mediaId
      });
      topo = r.state;
      PFCanvas.setConnecting(null);
      PFCanvas.setTopology(topo);
      const via = (r.link && r.link.mediaId) ? ' via ' + r.link.mediaId : '';
      setStatus('Connected ' + devName(c.deviceId) + '/' + c.iface + ' to ' + devName(deviceId) + '/' + iface + via);
    } catch (e) {
      PFCanvas.setConnecting(null);
      toast('Impossible: ' + e.message);
    }
  };

  PFCanvas.on.context = function (id, x, y) { showContextMenu(id, x, y); };

  // The canvas reports anything it could not draw. One bad device must not be able to
  // take the rest of the drawing - or the user's ability to notice - with it.
  PFCanvas.on.renderError = function (failures, fatal) {
    const list = failures || [];
    console.error('canvas render problems', fatal || '', list);
    if (fatal) {
      setStatus('Canvas could not be redrawn - showing the last good view. Press F5 to reload.');
      return;
    }
    const names = list.map(function (f) { return f.what + ' ' + (f.id || '?'); }).join(', ');
    setStatus('Some items could not be drawn: ' + names + ' (see console)');
  };
  PFCanvas.on.dblclick = function (id) { select(id); switchTab('console'); };

  // ---------- selection + inspector ----------
  function select(id) {
    selectedId = id;
    selectedLink = null;
    PFCanvas.setSelected(id);
    renderDeviceTab();
    renderSimulateTab();
    if (id) {
      const d = deviceById(id);
      if (d) setStatus('Selected: ' + d.name + ' (' + d.vendor + ' ' + d.model + ')');
    } else {
      setStatus('Ready');
    }
  }

  function selectLink(id) {
    selectedLink = id;
    selectedId = null;
    PFCanvas.setSelectedLink(id);
    renderDeviceTab();
    const l = (topo.links || []).find(function (x) { return x.id === id; });
    if (l) {
      const da = deviceById(l.a.deviceId), db = deviceById(l.b.deviceId);
      setStatus('Link: ' + (da ? da.name : '?') + ':' + l.a.iface + ' ↔ ' +
        (db ? db.name : '?') + ':' + l.b.iface);
    }
  }

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-tab') === name); });
    document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'tab-' + name); });
  }

  function renderDeviceTab() {
    const wrap = $('#tab-device');
    if (selectedLink) { renderLinkInspector(wrap); return; }
    const d = deviceById(selectedId);
    if (!d) {
      wrap.innerHTML = '<div class="field-label">No device selected</div><div style="color:var(--muted);font-size:13px">Click a device on the canvas to inspect and configure it.</div>';
      return;
    }
    const vendorColor = d.color || '#3f7cff';
    let html = '';
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
      '<span class="vendor-badge" style="background:' + vendorColor + '">' + d.vendor.toUpperCase() + '</span>' +
      '<strong>' + d.name + '</strong>' +
      // A right-click menu was the only way to remove a device, and it did not open.
      // Delete belongs somewhere you can see it.
      '<button id="btn-delete-device" class="btn danger" style="margin-left:auto;padding:4px 10px;font-size:12px" title="Remove this device and all of its cables">Delete device</button>' +
      '</div>';

    // The front panel. On a 48-port switch the per-port list below is a wall of rows and
    // the canvas is a cluster of unlabelled dots; a panel laid out the way the chassis is
    // answers "which socket is port 23" by position alone. Optional on purpose - if the
    // module is absent the inspector still works.
    if (typeof window !== 'undefined' && window.PFFaceplate && typeof window.PFFaceplate.render === 'function') {
      try {
        html += '<div class="fp-wrap"><div class="field-label" style="margin-top:8px">Front panel</div>' +
          window.PFFaceplate.render(d, { topology: topo, fullNames: true }) + '</div>';
      } catch (e) { /* a layout failure must not cost you the port list */ }
    }
    html += '<div class="kv"><span class="k">Model</span><span>' + d.model + ' (' + d.label + ')</span></div>';
    html += '<div class="kv"><span class="k">Category</span><span>' + d.category + '</span></div>';
    html += '<div class="kv"><span class="k">ID</span><span style="font-family:var(--mono)">' + d.id + '</span></div>';
    html += '<div class="field-label">Capabilities</div><div>';
    for (const c of (d.capabilities || [])) html += '<span class="chip">' + c + '</span>';
    html += '</div>';

    // PoE: report the real budget and what is actually being drawn. Denials are
    // the point - a budget nobody can exceed is decoration.
    const poe = poeSummary(d);
    const psePorts = d.interfaces.filter(function (i) { return i.poeOut; }).length;
    if (poe && !poe.unknown) {
      html += '<div class="kv"><span class="k">PoE budget</span><span>' + poe.budget + ' W' +
        (psePorts ? ' · ' + psePorts + ' PSE ports' : '') + '</span></div>';
      html += '<div class="kv"><span class="k">PoE in use</span><span' +
        (poe.denied ? ' style="color:var(--red)"' : '') + '>' +
        (Math.round(poe.used * 100) / 100) + ' W' +
        (poe.denied ? ' · ' + poe.denied + ' port' + (poe.denied > 1 ? 's' : '') + ' DENIED' : '') +
        '</span></div>';
    } else if (psePorts) {
      html += '<div class="kv"><span class="k">PoE</span><span class="muted">' + psePorts +
        ' PSE ports · budget not modelled</span></div>';
    }

    // SCION membership
    if (d.config && d.config.scionAs) {
      html += '<div class="kv"><span class="k">SCION</span><span class="mono">' +
        d.config.scionAs + ' <span class="muted">(' +
        (/:0$/.test(d.config.scionAs) ? 'core AS' : 'non-core') + ')</span></span></div>';
    }

    // hostname editor
    html += '<div class="field-label">Hostname</div>';
    html += '<input type="text" id="hostname-input" style="width:100%;background:var(--bg-2);border:1px solid var(--border-2);color:var(--text);border-radius:5px;padding:6px 8px" value="' + (d.name || '') + '">';

    // interfaces — hardware-aware, filterable, expandable
    const upCount = d.interfaces.filter(function (i) { return i.enabled; }).length;
    html += '<div class="field-label">Interfaces <span class="iface-count">' +
      d.interfaces.length + ' ports · ' + upCount + ' up</span></div>';
    html += '<input id="iface-filter" class="iface-filter" type="search" placeholder="filter ports by name, media or IP…" autocomplete="off" spellcheck="false">';
    html += '<div class="iface-list" id="iface-list">';
    for (const i of d.interfaces) html += ifaceRowHTML(d, i);
    html += '</div>';
    html += '<div class="hint" style="margin-top:6px">Click a port to edit its IP and admin state, and to see its real hardware. Toggle ▲/▼ to shut it down.</div>';

    // routes
    html += '<div class="field-label">Routes</div>';
    const routes = (topo.runtime && topo.runtime[d.id] && topo.runtime[d.id].routes) || [];
    if (routes.length) {
      html += '<table class="iface-table"><thead><tr><th>Type</th><th>Network</th><th>Via</th></tr></thead><tbody>';
      for (const r of routes) html += '<tr><td>' + r.code + '</td><td>' + r.dest + '/' + maskBits(r.mask) + '</td><td>' + r.gw + '</td></tr>';
      html += '</tbody></table>';
    } else {
      html += '<div class="hint">No routes. Assign IPs to interfaces.</div>';
    }

    wrap.innerHTML = html;

    // interface rows: expand on click, filter by text
    const listEl = wrap.querySelector('#iface-list');
    if (listEl) {
      listEl.addEventListener('click', function (e) {
        const head = e.target.closest ? e.target.closest('.iface-head') : null;
        if (!head) return;
        const row = head.parentElement;
        const wasOpen = row.classList.contains('open');
        listEl.querySelectorAll('.iface-row.open').forEach(function (r) { r.classList.remove('open'); });
        if (!wasOpen) row.classList.add('open');
      });
    }
    const filt = wrap.querySelector('#iface-filter');
    if (filt && listEl) {
      filt.addEventListener('input', function () {
        const q = filt.value.trim().toLowerCase();
        listEl.querySelectorAll('.iface-row').forEach(function (row) {
          row.style.display = (!q || row.textContent.toLowerCase().indexOf(q) >= 0) ? '' : 'none';
        });
      });
    }

    // The delete button is part of the generated HTML, so it needs wiring on every
    // render - same as the interface editors below.
    bindDeviceDelete();

    // Clicking a port on the panel reports it in the status bar: the panel answers
    // "where is it", this answers "what is it".
    if (typeof window !== 'undefined' && window.PFFaceplate && typeof window.PFFaceplate.bind === 'function') {
      const fp = wrap.querySelector('.fp-wrap');
      if (fp) {
        try {
          window.PFFaceplate.bind(fp, function (hit) {
            const name = hit && (hit.port || hit.name);
            const iface = name ? d.interfaces && (d.interfaces[name] || d.interfaces.find(function (i) { return i.name === name; })) : null;
            if (iface) setStatus(name + ' - ' + (iface.cage || 'connector unknown') + (iface.enabled === false ? ' (administratively down)' : ''));
            else if (name) setStatus(String(name));
          });
        } catch (e) { /* binding is an enhancement, not a requirement */ }
      }
    }

    // wire interface editors
    wrap.querySelectorAll('input[data-field]').forEach(function (inp) {
      inp.addEventListener('change', function () { applyInterfaceEdit(d.id, inp.getAttribute('data-iface'), inp.getAttribute('data-field'), inp.value); });
      // Enter should commit the field you are in, the way it does everywhere else.
      // Tab keeps its natural meaning: it moves to the next field, and for an address
      // that next field is its mask.
      inp.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); }
      });
    });
    wrap.querySelectorAll('.port-toggle').forEach(function (sp) {
      sp.addEventListener('click', async function () {
        const iface = sp.getAttribute('data-iface');
        const cur = d.interfaces.find(function (i) { return i.name === iface; });
        try {
          const r = await api('POST', '/topologies/' + TOPO + '/interfaces/' + d.id + '/' + iface, { enabled: !cur.enabled });
          topo = r.state; PFCanvas.setTopology(topo); renderDeviceTab();
        } catch (e) { toast(e.message); }
      });
    });
    // Dual-purpose cages (a 10G port that can be WAN or LAN) flip here. The server
    // only accepts roles the port actually lists, so an impossible combination comes
    // back as a refusal rather than silently becoming something the hardware is not.
    wrap.querySelectorAll('.port-role[data-iface]').forEach(function (chip) {
      chip.addEventListener('click', async function (ev) {
        ev.stopPropagation();
        const iface = chip.getAttribute('data-iface');
        const cur = d.interfaces.find(function (i) { return i.name === iface; });
        const opts = cur && cur.dualRole ? cur.dualRole : [];
        if (opts.length < 2) return;
        const next = opts[(opts.indexOf(cur.role) + 1) % opts.length];
        try {
          const r = await api('POST', '/topologies/' + TOPO + '/interfaces/' + d.id + '/' + iface, { role: next });
          topo = r.state; PFCanvas.setTopology(topo); renderDeviceTab();
          toast(iface + ' is now a ' + next.toUpperCase() + ' port');
        } catch (e) { toast(e.message); }
      });
    });
    const hn = wrap.querySelector('#hostname-input');
    if (hn) hn.addEventListener('change', async function () {
      try {
        const r = await api('POST', '/topologies/' + TOPO + '/config/' + d.id, { commands: ['configure terminal', 'hostname ' + hn.value.trim()] });
        topo = r.state; PFCanvas.setTopology(topo); select(d.id);
      } catch (e) { toast(e.message); }
    });
  }

  function maskBits(mask) {
    if (!mask) return '?';
    const parts = mask.split('.').map(Number);
    return parts.reduce(function (a, o) { return a + (o.toString(2).match(/1/g) || []).length; }, 0);
  }

  // ---------- IP / mask editing ----------
  // The server requires a mask whenever an address is set, and the old code
  // satisfied that by quietly filling in 255.255.255.0 the instant you typed an
  // address. So a /24 appeared before you had a chance to say otherwise, and
  // because the panel re-rendered on save, focus was thrown away too - Tab never
  // reached the mask box. Both halves of that are the bug.
  //
  // Now an address is buffered until its mask arrives: type the address, press Tab,
  // and you land in the mask field on the same port. Nothing is committed until
  // both halves exist (issue #7).
  const pendingIp = Object.create(null);

  function maskFromShorthand(v) {
    const s = String(v || '').trim().replace(/^\//, '');
    if (!/^\d{1,2}$/.test(s)) return String(v || '').trim();
    const bits = Number(s);
    if (bits > 32) return String(v || '').trim();
    let n = 0;
    for (let i = 0; i < bits; i++) n |= (1 << (31 - i));
    return [24, 16, 8, 0].map(function (sh) { return (n >>> sh) & 255; }).join('.');
  }

  function focusMask(devId, iface) {
    const el = document.querySelector('input[data-iface="' + iface + '"][data-field="mask"]');
    if (el) { el.focus(); if (el.select) el.select(); }
  }

  async function applyInterfaceEdit(devId, iface, field, value) {
    const key = devId + '/' + iface;
    try {
      const d = deviceById(devId);
      const cur = d.interfaces.find(function (i) { return i.name === iface; });
      if (!cur) return;

      if (field === 'ip') {
        const typed = String(value || '').trim();
        if (!typed) {
          // Clearing the address clears its mask with it - an address with no mask
          // is not a thing you can route.
          delete pendingIp[key];
          const r = await api('POST', '/topologies/' + TOPO + '/interfaces/' + devId + '/' + iface,
            { ip: null, mask: null });
          topo = r.state; PFCanvas.setTopology(topo); renderDeviceTab();
          toast('Cleared ' + iface);
          return;
        }
        // Hold the address and put the cursor where the next number belongs.
        pendingIp[key] = typed;
        focusMask(devId, iface);
        toast('Enter the mask for ' + typed + ' (24, or 255.255.255.0)');
        return;
      }

      if (field === 'mask') {
        const raw = String(value || '').trim();
        const ip = pendingIp[key] || cur.ip;
        if (!ip) { toast('Enter an IP address first'); return; }
        if (!raw) { toast('A mask is required with an address'); focusMask(devId, iface); return; }
        const mask = maskFromShorthand(raw);
        const r = await api('POST', '/topologies/' + TOPO + '/interfaces/' + devId + '/' + iface, { ip: ip, mask: mask });
        delete pendingIp[key];
        topo = r.state; PFCanvas.setTopology(topo); renderDeviceTab();
        toast('Set ' + iface + ' to ' + ip + '/' + maskBits(mask));
        return;
      }
    } catch (e) { toast(e.message); }
  }

  // ---------- console ----------
  function consoleState(devId) {
    if (!consoleLog[devId]) consoleLog[devId] = { lines: [], prompt: '>' };
    return consoleLog[devId];
  }

  // ---------- inspector helpers ----------
  function fmtSpeed(mbps) {
    if (!mbps) return '—';
    if (mbps >= 1000) {
      const g = mbps / 1000;
      return (g % 1 === 0 ? g : g.toFixed(1)) + 'G';
    }
    return mbps + 'M';
  }

  function cageLabel(c) {
    const known = {
      rj45: 'RJ45', sfp: 'SFP', 'sfp+': 'SFP+', sfp28: 'SFP28',
      qsfpdd: 'QSFP-DD cage (200/400G)',
      'qsfp+': 'QSFP+', qsfp28: 'QSFP28', console: 'Console',
      'sc-apc': 'SC/APC fibre', 'sc-upc': 'SC/UPC fibre',
      'lc-upc': 'LC/UPC fibre', 'lc-apc': 'LC/APC fibre',
      combo: 'combo RJ45/SFP', coax: 'F-connector coax', dsl: 'RJ11 DSL',
      powerline: 'mains powerline', usb: 'USB', antenna: 'Antenna'
    };
    return known[c] || String(c || '').toUpperCase();
  }

  function vlanSummary(i) {
    const v = i.vlan || {};
    if (v.mode === 'trunk') {
      const allowed = v.allowedVlans === 'all' ? 'all'
        : (Array.isArray(v.allowedVlans) ? v.allowedVlans.join(',') : v.allowedVlans);
      return 'trunk · native ' + (v.nativeVlan || 1) + ' · allowed ' + allowed;
    }
    return 'access ' + (v.accessVlan || 1);
  }

  // Display mirror of Simulator.computePoe(): a PSE serves powered devices in
  // port-name order until its budget runs out. ui-render.test.js asserts this
  // agrees with the engine, so the two cannot drift apart silently.
  function poeSummary(d) {
    const psePorts = d.interfaces
      .filter(function (i) { return i.poeOut; })
      .map(function (i) { return i.name; })
      .sort();
    if (!d.poeBudget && !psePorts.length) return null;
    if (!d.poeBudget) {
      return { budget: 0, used: 0, unknown: true, ports: [], denied: 0, psePorts: psePorts.length };
    }

    let remaining = d.poeBudget;
    const ports = [];
    for (const name of psePorts) {
      const link = (topo.links || []).find(function (l) {
        return (l.a.deviceId === d.id && l.a.iface === name) ||
               (l.b.deviceId === d.id && l.b.iface === name);
      });
      if (!link) continue;
      const other = (link.a.deviceId === d.id)
        ? { id: link.b.deviceId, iface: link.b.iface }
        : { id: link.a.deviceId, iface: link.a.iface };
      const peer = deviceById(other.id);
      const peerIface = peer && peer.interfaces.find(function (i) { return i.name === other.iface; });
      if (!peerIface || !peerIface.poeIn) continue;      // not a powered device
      const draw = peerIface.poeIn;
      if (remaining >= draw) {
        remaining -= draw;
        ports.push({ name: name, pd: peer.name, draw: draw, powered: true });
      } else {
        ports.push({ name: name, pd: peer.name, draw: draw, powered: false });
      }
    }
    return {
      budget: d.poeBudget,
      used: d.poeBudget - remaining,
      unknown: false,
      ports: ports,
      denied: ports.filter(function (p) { return !p.powered; }).length,
      psePorts: psePorts.length
    };
  }

  // One interface, collapsed to a single line with its hardware visible.
  function ifaceRowHTML(d, i) {
    // A bridge group is one switch chip with one address: only the representative
    // port offers address inputs, and the others say where the address lives. Eight
    // identical address boxes on a consumer router imply eight addresses, which the
    // hardware does not have (issue #8).
    const groupRep = i.bridgeGroup
      ? (d.interfaces.find(function (x) { return x.bridgeGroup === i.bridgeGroup; }) || {}).name
      : null;
    const isRep = !i.bridgeGroup || groupRep === i.name;
    // A dual-purpose cage is a switch, not a label: show it and let it be flipped.
    const roleChip = i.dualRole
      ? '<span class="port-role" data-iface="' + i.name + '" title="This cage is either ' +
          i.dualRole.join(' or ') + '; click to switch">' +
          String(i.role || i.dualRole[0]).toUpperCase() + ' \u21c4</span>'
      : (i.role ? '<span class="port-role fixed" title="Fixed role">' + i.role.toUpperCase() + '</span>' : '');
    const connected = (topo.links || []).some(function (l) {
      return (l.a.deviceId === d.id && l.a.iface === i.name) ||
             (l.b.deviceId === d.id && l.b.iface === i.name);
    });
    const hw = i.cage ? cageLabel(i.cage) + ' ' + fmtSpeed(i.speed) : fmtSpeed(i.speed);
    const ipText = i.ip ? i.ip + '/' + maskBits(i.mask) : '—';
    const caps = (i.speedCaps && i.speedCaps.length)
      ? i.speedCaps.slice().sort(function (a, b) { return a - b; }).map(fmtSpeed).join(' / ')
      : fmtSpeed(i.speed);

    // What is actually plugged into this socket. "cabled" as a bare dot told you a
    // cable existed but not where it went, which is the question you have when you
    // are staring at eight identical ports.
    const peerLink = (topo.links || []).find(function (l) {
      return (l.a.deviceId === d.id && l.a.iface === i.name) ||
             (l.b.deviceId === d.id && l.b.iface === i.name);
    });
    let peerText = '';
    if (peerLink) {
      const other = peerLink.a.deviceId === d.id ? peerLink.b : peerLink.a;
      const otherDev = deviceById(other.deviceId);
      const peerName = otherDev ? otherDev.name : other.deviceId;
      const media = peerLink.mediaId ? ' · ' + peerLink.mediaId : '';
      const len = peerLink.lengthM ? ' · ' + peerLink.lengthM + ' m' : '';
      peerText = '<span class="port-peer" title="' + peerName + ' ' + other.iface + media + len + '">' +
        '\u2192 ' + peerName + ':' + other.iface + '</span>';
    }

    // What announced itself on this port. Unlike the cable line above, this came from
    // a frame: it is what the far end says about itself, which is how you notice when
    // the cable record and reality disagree.
    let lldpText = '';
    if (i.lldp) {
      lldpText = '<span class="port-lldp" title="Announced over LLDP by the far end">' +
        'LLDP: ' + (i.lldp.systemName || '?') + '/' + (i.lldp.portId || '?') + '</span>';
    }

    let html = '<div class="iface-row" data-iface="' + i.name + '">';
    html += '<div class="iface-head">' +
      '<span class="dot ' + (i.enabled ? 'up' : 'down') + '"></span>' +
      '<span class="port-name">' + i.name + '</span>' +
      '<span class="port-media">' + hw + '</span>' +
      '<span class="port-ip' + (i.ip ? ' has' : '') + '">' + ipText + '</span>' +
      peerText + lldpText +
      '</div>';

    html += '<div class="iface-body">';
    html += '<div class="iface-edit">' + roleChip +
      (isRep
        ? '<input type="text" data-iface="' + i.name + '" data-field="ip" value="' + (i.ip || '') + '" placeholder="IP">' +
          '<input type="text" data-iface="' + i.name + '" data-field="mask" value="' + (i.mask || '') + '" placeholder="mask">'
        : '<span class="port-shared" title="These ports are one switch chip and share one address">' +
          'address on ' + groupRep + '</span>') +
      '<span class="port-toggle" data-iface="' + i.name + '" data-field="toggle" title="Toggle admin state" style="color:' +
        (i.enabled ? 'var(--green)' : 'var(--red)') + '">' + (i.enabled ? '▲ up' : '▼ down') + '</span>' +
      '</div>';
    html += '<div class="hw-grid">';
    html += '<span class="k">Cage</span><span>' + (i.cage ? cageLabel(i.cage) + ' <span class="mono muted">(' + i.cage + ')</span>' : '—') + '</span>';
    html += '<span class="k">Speeds</span><span>' + caps + '</span>';
    html += '<span class="k">Media</span><span class="mono">' + ((i.media || []).join(', ') || '—') + '</span>';
    if (i.poeOut) html += '<span class="k">PoE</span><span>PSE, ' + i.poeOut + ' W out</span>';
    if (i.poeIn) html += '<span class="k">PoE</span><span>PD, powered by the cable</span>';
    html += '<span class="k">VLAN</span><span>' + vlanSummary(i) + '</span>';
    if (i.lagId) html += '<span class="k">LAG</span><span>group ' + i.lagId + '</span>';
    if (i.encapVid) html += '<span class="k">Sub-if</span><span>802.1Q encap ' + i.encapVid + '</span>';
    html += '</div></div></div>';
    return html;
  }

  function endpointHTML(d, ifaceName, iface) {
    if (!d) return '';
    let h = '<div class="endpoint">';
    h += '<div class="ep-head"><strong>' + d.name + '</strong> <span class="muted">' +
      d.vendor + ' ' + d.model + '</span></div>';
    h += '<div class="kv"><span class="k">Port</span><span class="mono">' + ifaceName + '</span></div>';
    if (iface) {
      h += '<div class="kv"><span class="k">Cage</span><span>' + (iface.cage ? cageLabel(iface.cage) : '—') + '</span></div>';
      h += '<div class="kv"><span class="k">Port rate</span><span>' + fmtSpeed(iface.speed) + '</span></div>';
      h += '<div class="kv"><span class="k">Admin</span><span style="color:' +
        (iface.enabled ? 'var(--green)' : 'var(--red)') + '">' + (iface.enabled ? 'up' : 'down') + '</span></div>';
    }
    h += '</div>';
    return h;
  }

  // Inspector for a selected cable: media, negotiated rate, both ends.
  function renderLinkInspector(wrap) {
    const link = (topo.links || []).find(function (l) { return l.id === selectedLink; });
    if (!link) {
      wrap.innerHTML = '<div class="field-label">That cable no longer exists</div>';
      return;
    }
    const da = deviceById(link.a.deviceId), db = deviceById(link.b.deviceId);
    const ia = da && da.interfaces.find(function (i) { return i.name === link.a.iface; });
    const ib = db && db.interfaces.find(function (i) { return i.name === link.b.iface; });

    let html = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
      '<span class="vendor-badge" style="background:#2f6f4f">LINK</span>' +
      '<strong>Physical cable</strong></div>';
    html += '<div class="kv"><span class="k">Type</span><span>' + (link.type || 'ethernet') + '</span></div>';
    html += '<div class="kv"><span class="k">Media</span><span class="mono">' + (link.mediaId || '—') + '</span></div>';
    html += '<div class="kv"><span class="k">Rate</span><span>' +
      (link.speedMbps ? fmtSpeed(link.speedMbps) + ' (' + link.speedMbps + ' Mbps)' : '—') + '</span></div>';
    html += '<div class="kv"><span class="k">Duplex</span><span>' + (link.duplex || '—') + '</span></div>';
    if (link.lengthM) html += '<div class="kv"><span class="k">Length</span><span>' + link.lengthM + ' m</span></div>';
    if (link.lagId) html += '<div class="kv"><span class="k">LAG</span><span>group ' + link.lagId + '</span></div>';
    html += '<div class="kv"><span class="k">State</span><span>' + (link.state || 'up') + '</span></div>';

    html += '<div class="field-label">Endpoints</div>';
    html += endpointHTML(da, link.a.iface, ia);
    html += endpointHTML(db, link.b.iface, ib);

    html += '<div class="verdict">Cages mate and the media is supported at both ends — ' +
      'this cable passed the physical-layer check when it was created. An impossible ' +
      'combination is refused at that moment, not silently accepted.</div>';

    wrap.innerHTML = html;
  }

  function renderConsole() {
    const d = deviceById(selectedId);
    const out = $('#console-output');
    if (!d) { out.textContent = 'Select a device to open its console.'; $('#console-prompt').textContent = '>'; return; }
    const st = consoleState(d.id);
    out.innerHTML = st.lines.map(function (l) {
      const cls = l.k === 'err' ? 'console-err' : (l.k === 'cmd' ? 'console-cmd' : '');
      return '<div class="' + cls + '">' + esc(l.t) + '</div>';
    }).join('');
    out.scrollTop = out.scrollHeight;
    $('#console-prompt').textContent = st.prompt;
  }

  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  async function runConsoleCommand(cmd) {
    const d = deviceById(selectedId);
    if (!d) return;
    const st = consoleState(d.id);
    const oldPrompt = st.prompt;
    st.lines.push({ t: oldPrompt + cmd, k: 'cmd' });
    try {
      const r = await api('POST', '/topologies/' + TOPO + '/config/' + d.id, { commands: [cmd] });
      st.prompt = r.prompt;
      for (const l of r.output.split('\n')) {
        if (l === oldPrompt + cmd) continue; // skip server's echo of the command
        st.lines.push({ t: l, k: l.charAt(0) === '%' ? 'err' : 'out' });
      }
      topo = r.state; PFCanvas.setTopology(topo);
      if (selectedId === d.id) renderDeviceTab();
    } catch (e) {
      st.lines.push({ t: '% ' + e.message, k: 'err' });
    }
    renderConsole();
  }

  // ---------- simulate ----------
  function renderSimulateTab() {
    const wrap = $('#tab-simulate');
    const d = deviceById(selectedId);
    if (!d) { wrap.innerHTML = '<div class="field-label">No device selected</div><div class="hint">Select a host or router to ping from.</div>'; return; }
    wrap.innerHTML =
      '<div class="field-label">Ping from <strong>' + d.name + '</strong></div>' +
      '<div class="ping-form">' +
      '<label>Destination IP</label>' +
      '<input id="ping-dst" placeholder="e.g. 192.168.1.20" spellcheck="false">' +
      '<label>Count</label>' +
      '<input id="ping-count" type="number" min="1" max="50" value="4">' +
      '<button id="ping-run" class="btn ping-run">▶ Send Ping</button>' +
      '</div>' +
      '<div id="ping-result" class="ping-result"></div>' +
      '<div id="event-log" class="event-log"></div>';
    $('#ping-run').addEventListener('click', runPing);
    $('#ping-dst').addEventListener('keydown', function (e) { if (e.key === 'Enter') runPing(); });
  }

  async function runPing() {
    const dst = $('#ping-dst').value.trim();
    const count = parseInt($('#ping-count').value, 10) || 4;
    const d = deviceById(selectedId);
    if (!d) return;
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(dst)) { toast('Enter a valid IPv4 destination'); return; }
    $('#ping-result').innerHTML = 'Sending ' + count + ' ICMP echos to ' + dst + '…';
    $('#event-log').innerHTML = '';
    try {
      const r = await api('POST', '/topologies/' + TOPO + '/ping', { src: d.id, dst: dst, count: count });
      topo = r.state || topo;
      const ok = r.replies.filter(function (x) { return x.success; }).length;
      $('#ping-result').innerHTML =
        '<span class="' + (ok === count ? 'ok' : 'fail') + '">Success rate ' + Math.round(ok / count * 100) + '% (' + ok + '/' + count + ')</span>';
      renderEventLog(r.events);
      PFCanvas.animateEvents(r.events);
    } catch (e) { $('#ping-result').innerHTML = '<span class="fail">' + esc(e.message) + '</span>'; }
  }

  function renderEventLog(events) {
    const log = $('#event-log');
    if (!log) return;
    const rows = events.map(function (e) {
      const cls = e.type === 'frame' ? 'frame'
        : (e.type === 'drop' || e.type === 'vlan-drop' || e.type === 'stp-block' || e.type === 'acl-deny') ? 'drop'
        : (e.type === 'lag') ? 'lag' : '';
      return '<div class="ev ' + cls + '">' + String(e.step).padStart(3, '0') + ' ' + describeEvent(e) + '</div>';
    });
    log.innerHTML = rows.join('\n');
    log.scrollTop = log.scrollHeight;
  }

  function describeEvent(e) {
    switch (e.type) {
      case 'ping': return 'ICMP echo #' + e.seq + ' → ' + e.dst;
      case 'arp-request': return 'ARP who-has ' + e.targetIp;
      case 'arp-reply': return 'ARP reply ' + e.targetIp + ' = ' + e.mac;
      case 'arp-cache': return e.dev + ' cached ' + e.ip + ' → ' + e.mac;
      case 'frame': {
        const f = e.frame || {};
        const tag = f.wireTagged ? '  [802.1Q vlan ' + f.wireVid + ']' : '';
        if (f.etherType === 'arp') return e.from + ' → ' + e.to + '  ARP ' + (f.arp ? f.arp.op : '') + tag;
        if (f.etherType === 'ipv4') return e.from + ' → ' + e.to + '  IPv4 ' + (f.ip ? f.ip.src + '→' + f.ip.dst : '') + (f.icmp ? ' ICMP type ' + f.icmp.type : '') + tag;
        return e.from + ' → ' + e.to + '  frame' + tag;
      }
      case 'route': return e.dev + ' routes ' + e.dst + ' via ' + e.via + ' out ' + e.iface;
      case 'switch': return e.dev + ' ' + e.action + ' out ' + e.iface + (e.vlan ? ' (vlan ' + e.vlan + ')' : '');
      case 'icmp-echo': return e.dev + ' received echo from ' + e.from;
      case 'icmp-reply': return e.dev + ' sending echo-reply to ' + e.to;
      case 'icmp-received': return e.dev + ' got echo-reply from ' + e.from;
      case 'drop': return 'DROP (' + (e.reason || '') + ')';
      case 'acl-deny': return 'ACL ' + (e.acl == null ? '?' : e.acl) + ' DENY ' + e.dir + ' on ' +
        (e.dev || '') + '/' + (e.iface || '') +
        (e.src ? '  ' + e.src + ' → ' + e.dst : '');
      case 'vlan-drop': return 'VLAN DROP ' + (e.dev || '') + '/' + (e.iface || '') +
        ' vlan ' + (e.vlan == null ? '?' : e.vlan) + ' — ' + (e.reason || 'not a member');
      case 'stp-block': return 'STP BLOCK ' + (e.dev || '') + '/' + (e.iface || '') +
        (e.vlan ? ' vlan ' + e.vlan : '') + ' — ' + (e.reason || 'blocking');
      case 'lag': return 'LAG ' + (e.dev || '') + ' group ' + e.lag + ' → ' + e.picked +
        ' of [' + (e.members || []).join(', ') + ']';
      case 'poe-deny': return 'PoE deny ' + (e.dev || '') + '/' + (e.iface || '') +
        (e.pd ? ' → ' + e.pd : '') + ': ' + (e.reason || 'budget exhausted');
      case 'scion-path': return 'SCION ' + (e.src || '') + ' → ' + (e.dst || '') +
        '  [' + (e.shape || '') + ']  ' + ((e.hops || []).join(' → '));
      case 'scion-hop': return 'SCION hop → ' + (e.to || '') + '  (AS ' + (e.as || '') + ')';
      case 'scion-drop': return 'SCION drop  ' + (e.src || '') + ' → ' + (e.dst || '') + ': ' + (e.reason || '');
      case 'scion-delivered': return 'SCION delivered at ' + (e.at || '');
      case 'nd-request': return 'ND  ' + (e.dev || '') + '/' + (e.iface || '') + '  who has ' +
        (e.target || '') + '  → ' + (e.mac || '');
      case 'nd-advert': return 'ND  ' + (e.dev || '') + ' is-at ' + (e.target || '') + ' ' + (e.mac || '');
      case 'nd-cache': return 'ND  ' + (e.dev || '') + ' cached ' + (e.addr || '') + ' → ' + (e.mac || '');
      case 'icmp6-echo': return 'ICMPv6 echo ' + (e.dev || '') + ' from ' + (e.from || '') + ' seq ' + e.seq;
      case 'icmp6-reply': return 'ICMPv6 reply ' + (e.dev || '') + ' to ' + (e.to || '') + ' seq ' + e.seq;
      case 'icmp6-received': return 'ICMPv6 reply received by ' + (e.dev || '') + ' from ' + (e.from || '');
      case 'route6': return e.dev + ' routes ' + e.dst + ' via ' + e.via + ' out ' + e.iface +
        '  (hop ' + e.hopLimit + ')';
      case 'ping6': return 'ping6 seq ' + e.seq + ' → ' + e.dst;
      case 'rs-send': return 'RS  ' + (e.dev || '') + '/' + (e.iface || '') +
        '  who is a router?  → ' + (e.dst || 'ff02::2');
      case 'rs-recv': return 'RS  ' + (e.dev || '') + '/' + (e.iface || '') +
        '  heard from ' + (e.from || '') + '  (answering)';
      case 'ra-send': return 'RA  ' + (e.dev || '') + '/' + (e.iface || '') + '  → ' + (e.dst || 'ff02::1') +
        '  [' + ((e.prefixes || []).join(', ') || 'default router') + ']' +
        (e.m ? '  M=1' : '') + (e.solicited ? '  (solicited)' : '');
      case 'ra-recv': return 'RA  ' + (e.dev || '') + '/' + (e.iface || '') + '  from ' + (e.from || '') +
        '  [' + ((e.prefixes || []).join(', ') || 'default router') + ']' + (e.m ? '  M=1' : '');
      case 'slaac-address': return 'SLAAC ' + (e.dev || '') + '/' + (e.iface || '') + '  ' +
        (e.addr || '') + '/' + (e.prefix == null ? '' : e.prefix) + '  from ' + (e.prefixSource || '');
      case 'slaac-refused': return 'SLAAC refused ' + (e.dev || '') + '/' + (e.iface || '') +
        ': ' + (e.reason || '');
      case 'bgp': return 'BGP ' + (e.dev || '?') + ' ' + (e.session === 'ebgp' ? '⇄' : '↔') +
        ' ' + (e.peer || '?') + '  ' + (e.session || '') + '  AS' + e.localAs + '–AS' + e.remoteAs;
      case 'dns': return 'DNS ' + (e.qname || '?') + (e.ok
        ? ' → ' + (e.address || '?') + ' (from ' + (e.server || '?') + ')'
        : ' NXDOMAIN' + (e.server ? ' (from ' + e.server + ')' : ''));
      case 'limit': return 'simulation limit: ' + e.reason;
      default: return e.type;
    }
  }

  // ---------- context menu ----------
  function showContextMenu(id, x, y) {
    const menu = $('#context-menu');
    // The element was missing from index.html for a long time, and assigning .innerHTML
    // on null threw - which meant the context menu, and therefore the only visible
    // "Delete device", could never appear (issue #16). A missing element must degrade,
    // not throw.
    if (!menu) { setStatus('Context menu unavailable - use Delete in the inspector'); return; }
    menu.innerHTML =
      '<div class="cm-item" data-act="console">Open console</div>' +
      '<div class="cm-item" data-act="ping">Ping from here…</div>' +
      '<div class="cm-item danger" data-act="delete">Delete device</div>';
    menu.style.display = 'block';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.onclick = async function (e) {
      const act = e.target.getAttribute('data-act');
      menu.style.display = 'none';
      if (act === 'console') { select(id); switchTab('console'); }
      else if (act === 'ping') { select(id); switchTab('simulate'); $('#ping-dst').focus(); }
      else if (act === 'delete') { await deleteDevice(id); }
    };
    document.addEventListener('click', function hide() { menu.style.display = 'none'; document.removeEventListener('click', hide); });
  }

  // The inspector's delete button, wired after each render because the button is part
  // of the generated HTML.
  function bindDeviceDelete() {
    // Looked up defensively: the render tests drive this code against a stub DOM that
    // implements querySelector but not getElementById, and a UI detail must not be able
    // to throw its way out of a render.
    let btn = null;
    try {
      btn = (typeof document.getElementById === 'function')
        ? document.getElementById('btn-delete-device')
        : document.querySelector('#btn-delete-device');
    } catch (e) { btn = null; }
    if (!btn || !btn.addEventListener) return;
    btn.addEventListener('click', function () {
      if (selectedId) deleteDevice(selectedId);
    });
  }

  async function deleteDevice(id) {
    try {
      const r = await api('DELETE', '/topologies/' + TOPO + '/devices/' + id);
      topo = r.state;
      if (selectedId === id) selectedId = null;
      PFCanvas.setTopology(topo); PFCanvas.setSelected(null);
      renderDeviceTab(); renderSimulateTab();
      setStatus('Deleted device ' + id);
    } catch (e) { toast(e.message); }
  }

  // ---------- topbar actions ----------
  function bindTopbar() {
    $('#btn-export').addEventListener('click', function () {
      const blob = new Blob([JSON.stringify(topo, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'packetforge-topology.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });

    $('#btn-import').addEventListener('click', function () {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.json';
      inp.onchange = async function () {
        if (!inp.files.length) return;
        const text = await inp.files[0].text();
        try {
          const doc = JSON.parse(text);
          const r = await api('POST', '/topologies/' + TOPO + '/load', doc);
          topo = r.state; selectedId = null;
          PFCanvas.setTopology(topo); PFCanvas.setSelected(null);
          renderDeviceTab(); renderSimulateTab();
          toast('Topology imported');
        } catch (e) { toast('Import failed: ' + e.message); }
      };
      inp.click();
    });

    $('#btn-new').addEventListener('click', async function () {
      if (!confirm('Start a new empty topology? Unsaved work will be lost.')) return;
      try {
        const r = await api('POST', '/topologies/' + TOPO + '/load', { format: 'packetforge-topology', version: 1, devices: [], links: [], layout: {} });
        topo = r.state; selectedId = null;
        PFCanvas.setTopology(topo); PFCanvas.setSelected(null);
        renderDeviceTab(); renderSimulateTab();
        setStatus('New empty topology');
      } catch (e) { toast(e.message); }
    });

    $('#btn-reset').addEventListener('click', async function () {
      try { await api('POST', '/topologies/' + TOPO + '/reset'); toast('ARP/MAC tables cleared'); } catch (e) { toast(e.message); }
    });

    $('#btn-zoom-in').addEventListener('click', function () { PFCanvas.zoomBy(1.2); });
    $('#btn-zoom-out').addEventListener('click', function () { PFCanvas.zoomBy(0.8); });
    $('#btn-zoom-fit').addEventListener('click', function () { PFCanvas.fitView(); });
  }

  // ---------- keyboard ----------
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.key === 'Escape') {
      placing = null;
      document.querySelectorAll('.device-card').forEach(function (c) { c.classList.remove('active'); });
      PFCanvas.setPlacing(null);
      PFCanvas.setConnecting(null);
      setStatus('Ready');
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      // Backspace is also "navigate back" in some browsers; a device deletion here is
      // deliberate, so stop the default.
      e.preventDefault();
      deleteDevice(selectedId);
    }
  });

  // ---------- console form ----------
  $('#console-form').addEventListener('submit', function (e) {
    e.preventDefault();
    const input = $('#console-input');
    const cmd = input.value;
    input.value = '';
    if (cmd.trim()) runConsoleCommand(cmd);
  });

  // ---------- tabs ----------
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      switchTab(t.getAttribute('data-tab'));
      if (t.getAttribute('data-tab') === 'console') renderConsole();
    });
  });

  // ---------- websocket sync ----------
  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try { ws = new WebSocket(proto + '://' + location.host + '/'); } catch (e) { return; }
    ws.onmessage = function (ev) {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'topology') {
          topo = m.state;
          PFCanvas.setTopology(topo);
          if (selectedId && !deviceById(selectedId)) { selectedId = null; PFCanvas.setSelected(null); }
          renderDeviceTab(); renderSimulateTab();
        }
      } catch (e) {
        // This was a bare `catch (e) {}`. A redraw that threw therefore produced an
        // empty canvas, an empty inspector and no output anywhere - the failure was
        // discarded at the only place that could have reported it (issue #20).
        console.error('topology sync failed', e);
        setStatus('Render failed - the canvas may be out of date. Press F5 to reload.');
      }
    };
  }

  // ---------- boot ----------
  async function boot() {
    bindTopbar();
    switchTab('device');
    try {
      const cat = await api('GET', '/catalog');
      catalog = cat;
      renderPalette();
      const t = await api('GET', '/topologies/' + TOPO);
      topo = t;
      PFCanvas.setTopology(topo);
      PFCanvas.fitView();
      renderDeviceTab();
      renderSimulateTab();
      setStatus('Ready — ' + topo.devices.length + ' device(s), ' + topo.links.length + ' link(s)');
      $('#status-right').textContent = catalog.specs.length + ' models · ' +
        new Set(catalog.specs.map(function (s) { return s.vendor; })).size + ' vendors';
      connectWS();
    } catch (e) {
      toast('Failed to load: ' + e.message);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);

  // Small surface for the UI render tests (also handy in the devtools console).
  window.__pf = {
    setTopology: function (t) { topo = t; },
    selectDevice: function (id) { selectedId = id; selectedLink = null; },
    selectLink: function (id) { selectedLink = id; selectedId = null; },
    renderDeviceTab: renderDeviceTab,
    renderLinkInspector: renderLinkInspector,
    ifaceRowHTML: ifaceRowHTML,
    poeSummary: poeSummary,
    fmtSpeed: fmtSpeed,
    cageLabel: cageLabel,
    vlanSummary: vlanSummary
  };
})();
