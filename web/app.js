'use strict';
// app.js — PacketForge frontend logic: state, API, palette, inspector, console, simulation.
(function () {
  const TOPO = 'default';
  let catalog = { specs: [], categories: {} };
  let topo = null;
  let selectedId = null;
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
    router: 'Routers', switch: 'Switches', 'l3-switch': 'L3 Switches', firewall: 'Firewalls', ont: 'ONT / CPE',
    host: 'End Devices', server: 'Servers', wireless: 'Wireless APs', ptp: 'PTP Radios', cloud: 'Cloud / WAN'
  };
  const CAT_ORDER = ['router', 'switch', 'l3-switch', 'firewall', 'ont', 'host', 'server', 'wireless', 'ptp', 'cloud'];
  const BADGE_LABELS = {
    router: 'Router', switch: 'Switch', 'l3-switch': 'L3 Switch', firewall: 'Firewall',
    ont: 'ONT', host: 'Host', server: 'Server', wireless: 'AP', ptp: 'PTP', cloud: 'WAN'
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
    const m = { router: '🧭', switch: '🔀', 'l3-switch': '🔀', host: '🖥️', server: '🗄️', firewall: '🛡️', wireless: '📶', ptp: '📻', cloud: '☁️', ont: '📡', ap: '📶' };
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
  PFCanvas.on.dblclick = function (id) { select(id); switchTab('console'); };

  // ---------- selection + inspector ----------
  function select(id) {
    selectedId = id;
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

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-tab') === name); });
    document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.toggle('active', p.id === 'tab-' + name); });
  }

  function renderDeviceTab() {
    const wrap = $('#tab-device');
    const d = deviceById(selectedId);
    if (!d) {
      wrap.innerHTML = '<div class="field-label">No device selected</div><div style="color:var(--muted);font-size:13px">Click a device on the canvas to inspect and configure it.</div>';
      return;
    }
    const vendorColor = d.color || '#3f7cff';
    let html = '';
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
      '<span class="vendor-badge" style="background:' + vendorColor + '">' + d.vendor.toUpperCase() + '</span>' +
      '<strong>' + d.name + '</strong></div>';
    html += '<div class="kv"><span class="k">Model</span><span>' + d.model + ' (' + d.label + ')</span></div>';
    html += '<div class="kv"><span class="k">Category</span><span>' + d.category + '</span></div>';
    html += '<div class="kv"><span class="k">ID</span><span style="font-family:var(--mono)">' + d.id + '</span></div>';
    html += '<div class="field-label">Capabilities</div><div>';
    for (const c of (d.capabilities || [])) html += '<span class="chip">' + c + '</span>';
    html += '</div>';

    // hostname editor
    html += '<div class="field-label">Hostname</div>';
    html += '<input type="text" id="hostname-input" style="width:100%;background:var(--bg-2);border:1px solid var(--border-2);color:var(--text);border-radius:5px;padding:6px 8px" value="' + (d.name || '') + '">';

    // interfaces
    html += '<div class="field-label">Interfaces</div>';
    html += '<table class="iface-table"><thead><tr><th>Port</th><th>IP</th><th>Mask</th><th>Link</th></tr></thead><tbody>';
    for (const i of d.interfaces) {
      const connected = i.peer || (topo.links || []).some(function (l) {
        return (l.a.deviceId === d.id && l.a.iface === i.name) || (l.b.deviceId === d.id && l.b.iface === i.name);
      });
      html += '<tr>' +
        '<td style="font-family:var(--mono)">' + i.name + '</td>' +
        '<td><input type="text" data-iface="' + i.name + '" data-field="ip" value="' + (i.ip || '') + '" placeholder="—"></td>' +
        '<td><input type="text" data-iface="' + i.name + '" data-field="mask" value="' + (i.mask || '') + '" placeholder="255.255.255.0"></td>' +
        '<td><span class="port-toggle" data-iface="' + i.name + '" data-field="toggle" title="Toggle admin state" style="color:' + (i.enabled ? 'var(--green)' : 'var(--red)') + '">' + (i.enabled ? '▲ up' : '▼ down') + '</span>' +
        (connected ? '<span style="color:var(--green);font-size:10px"> ●</span>' : '') + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    html += '<div class="hint" style="margin-top:6px">Set IP + mask then press Enter. Toggle ▲/▼ to shutdown an interface.</div>';

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

    // wire interface editors
    wrap.querySelectorAll('input[data-field]').forEach(function (inp) {
      inp.addEventListener('change', function () { applyInterfaceEdit(d.id, inp.getAttribute('data-iface'), inp.getAttribute('data-field'), inp.value); });
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

  async function applyInterfaceEdit(devId, iface, field, value) {
    try {
      const d = deviceById(devId);
      const cur = d.interfaces.find(function (i) { return i.name === iface; });
      const body = { ip: cur.ip, mask: cur.mask };
      if (field === 'ip') {
        if (!value.trim()) body.ip = null;
        else { body.ip = value.trim(); if (!body.mask) body.mask = '255.255.255.0'; }
      } else if (field === 'mask') {
        if (!value.trim()) body.mask = null;
        else body.mask = value.trim();
      }
      const r = await api('POST', '/topologies/' + TOPO + '/interfaces/' + devId + '/' + iface, body);
      topo = r.state; PFCanvas.setTopology(topo); renderDeviceTab();
      toast('Updated ' + devId + '/' + iface);
    } catch (e) { toast(e.message); }
  }

  // ---------- console ----------
  function consoleState(devId) {
    if (!consoleLog[devId]) consoleLog[devId] = { lines: [], prompt: '>' };
    return consoleLog[devId];
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
      } catch (e) {}
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
})();
