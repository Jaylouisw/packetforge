'use strict';
// app.js — PacketForge frontend logic: state, API, palette, inspector, console, simulation.
(function () {
  const TOPO = 'default';
  let catalog = { specs: [], categories: {} };
  // Open hardware requests from the forge, as [ {number, subject, url} ]. Empty until
  // /api/requests answers, and empty forever if the forge is unreachable — the palette
  // works from the catalogue either way.
  let openRequests = [];
  let topo = null;
  let selectedId = null;
  let selectedLink = null;
  let placing = null;
  const consoleLog = {}; // deviceId -> { lines: [], prompt: '>' }

  const $ = function (s) { return document.querySelector(s); };

  // ---------- bug reports ----------
  // The one link a user needs when something is wrong must not depend on them
  // first working out where the repository lives, then which of six templates to
  // pick, then what to write in it. The report is pre-filled with the half only
  // the running app knows - build, Node, browser, page, catalogue size - so the
  // person filing it only has to say what they did and what they saw.
  const ISSUE_NEW = 'https://git.jayw.uk/jaylouisw/packetforge/issues/new';

  // ---------- what the app saw go wrong ----------
  //
  // The most expensive part of a bug report is the part the reporter cannot possibly know:
  // what the app was doing when it broke. The browser hands that over for free - message,
  // file, line, stack - and it is discarded unless something is listening, which is why the
  // reports this project used to receive said "it doesn't work" and nothing else.
  //
  // Bounded on purpose: five entries, four stack frames each. A page that throws in a loop
  // must not turn its own bug report into a 2 MB issue body.
  const MAX_ERRORS = 5;
  const recentErrors = [];

  function recordError(kind, message, extra) {
    const e = extra || {};
    const entry = {
      kind: or2(kind, 'error'),
      message: or2(message, 'unknown error'),
      where: or2(e.where, ''),
      detail: String(e.detail || '').split('\n').slice(0, 4).join('\n'),
      at: new Date().toISOString()
    };
    recentErrors.push(entry);
    while (recentErrors.length > MAX_ERRORS) recentErrors.shift();
    return entry;
  }

  function or2(v, fallback) {
    return (v === undefined || v === null || v === '') ? fallback : String(v);
  }

  /**
   * Render the caught errors for a report body. Always returns at least one line, because an
   * empty section reads like the app forgot to fill it in - and "none since the page loaded"
   * is itself a useful fact when the bug is a visual one.
   */
  function describeErrors(list) {
    const items = (list || []).slice(-MAX_ERRORS);
    if (!items.length) {
      return ['- None since the page loaded. If something looked wrong without an error, the',
              '  screenshot is the useful part.'];
    }
    const out = [];
    for (const e of items) {
      out.push('- `' + or2(e.kind, 'error') + '`: ' + or2(e.message, 'unknown error')
        + (e.where ? ' (' + e.where + ')' : ''));
      if (e.detail) {
        out.push('  ```');
        for (const line of String(e.detail).split('\n')) out.push('  ' + line);
        out.push('  ```');
      }
    }
    return out;
  }

  /**
   * What was on the canvas, in the form a maintainer needs it.
   *
   * The second most expensive part of a bug report is the part only the running app knows and the
   * reporter would have to type out: which devices were on screen and what was cabled to what. "My
   * link won't come up" costs three round trips to establish that the link is 1000base-t between an
   * eth0 and a Fa0/1 on a switch that does not have Fa0/1.
   *
   * Bounded like the error list: 12 model lines and 15 links, then a count of what was left out.
   * A 200-device campus in an issue URL is how a report turns into a 414.
   */
  const TOPO_MAX_MODELS = 12;
  const TOPO_MAX_LINKS = 15;

  function describeTopology(topo, opts) {
    const t = topo || {};
    const devices = Array.isArray(t.devices) ? t.devices.filter(Boolean) : [];
    const links = Array.isArray(t.links) ? t.links.filter(Boolean) : [];
    const out = [];

    if (!devices.length) {
      // Honest rather than blank: an empty canvas is a fact, and it changes what the bug can be.
      out.push('Canvas: no devices.');
      return out;
    }

    out.push('Devices on the canvas (' + devices.length + '):');
    const byModel = new Map();
    for (const d of devices) {
      const key = or2(d.vendor, '?') + '/' + or2(d.model, d.label || '?');
      if (!byModel.has(key)) byModel.set(key, { n: 0, labels: [] });
      const slot = byModel.get(key);
      slot.n++;
      const label = or2(d.label, d.name || '');
      if (label && slot.labels.length < 3) slot.labels.push(label);
    }
    let shown = 0;
    for (const [key, slot] of byModel) {
      if (shown === TOPO_MAX_MODELS) {
        out.push('- ... and ' + (byModel.size - shown) + ' more model(s)');
        break;
      }
      out.push('- ' + key + (slot.n > 1 ? ' x' + slot.n : '')
        + (slot.labels.length ? ' (' + slot.labels.join(', ') + ')' : ''));
      shown++;
    }

    // Internal ids ("d4:GE0/0/2") are precise but unreadable; the canvas names are both. Fall back
    // to the id when a device has no name, which is what a freshly placed device looks like.
    const nameOf = new Map();
    for (const d of devices) {
      if (!d || !d.id) continue;
      // Names are minted as "<label>-<id>" (PC1-d6). The id is already in the report's own
      // vocabulary, so the suffix is noise on every line; strip it when it is exactly that.
      let name = or2(d.name, d.label || '');
      const suffix = '-' + d.id;
      if (name.length > suffix.length && name.slice(-suffix.length) === suffix) {
        name = name.slice(0, -suffix.length);
      }
      nameOf.set(d.id, name || d.id);
    }
    function side(ref) {
      const r = ref || {};
      const who = nameOf.get(r.deviceId) || or2(r.deviceId, '?');
      return who + ':' + or2(r.iface, '?');
    }

    if (links.length) {
      out.push('Links (' + links.length + '):');
      const cap = Math.min(links.length, TOPO_MAX_LINKS);
      for (let i = 0; i < cap; i++) {
        const l = links[i];
        const a = l.a || {}, b = l.b || {};
        const speed = l.speedMbps ? ' ' + l.speedMbps + 'M' : '';
        const media = l.mediaId ? ' ' + l.mediaId : '';
        out.push('- ' + side(a) + ' -- ' + side(b) + media + speed);
      }
      if (links.length > cap) out.push('- ... and ' + (links.length - cap) + ' more link(s)');
    } else {
      out.push('Links: none.');
    }

    const sel = opts && opts.selected;
    if (sel) {
      const who = sel.deviceId || sel.id;
      out.push('Selected: ' + (nameOf.get(who) || or2(who, '?')) + (sel.iface ? ':' + sel.iface : ''));
    }
    return out;
  }

  function bugReportBody(env) {
    const e = env || {};
    function or(v) { return (v === undefined || v === null || v === '') ? 'unknown' : String(v); }
    const topology = Array.isArray(e.topology) && e.topology.length
      ? e.topology
      : ['Not captured - the app was not able to read the canvas when the report was made.'];
    return [
      '### What happened',
      '',
      '<!-- What you saw, and what you expected to happen instead. -->',
      '',
      '### Steps to reproduce',
      '',
      '1. ',
      '2. ',
      '3. ',
      '',
      '### Errors the app caught',
      '',
      '<!-- Recorded automatically while the app was running. Paste nothing here. -->',
      ''
    ].concat(describeErrors(e.errors)).concat([
      '',
      '### What was on screen',
      '',
      '<!-- Recorded automatically from the canvas. Paste nothing here. -->',
      '',
      '```'
    ]).concat(topology).concat([
      '```',
      '',
      '### Where it happened',
      '',
      '- PacketForge: ' + or(e.version),
      '- Node: ' + or(e.node),
      '- Browser: ' + or(e.browser),
      '- Page: ' + or(e.page),
      '- Catalogue: ' + (e.devices === undefined || e.devices === null ? 'unknown' : e.devices + ' models'),
      '',
      '<!-- Everything above was filled in by the app. Correct anything that is wrong. -->',
      ''
    ]).join('\n');
  }

  function bugReportUrl(env) {
    const title = (env && env.title) ? env.title : '[Bug]: ';
    return ISSUE_NEW
      + '?title=' + encodeURIComponent(title)
      + '&body=' + encodeURIComponent(bugReportBody(env));
  }

  async function openBugReport() {
    const env = {
      title: '[Bug]: ',
      version: 'unknown',
      node: 'unknown',
      browser: (typeof navigator !== 'undefined' && navigator && navigator.userAgent) || 'unknown',
      page: (typeof location !== 'undefined' && location && location.href) || '',
      devices: (catalog && catalog.specs && catalog.specs.length) || null,
      // What the app caught, not what the reporter has to remember.
      errors: recentErrors.slice(),
      // And what was on the canvas - the half of the picture only this window has.
      topology: describeTopology(topo, { selected: selectedId ? { deviceId: selectedId } : null })
    };
    try {
      const v = await api('GET', '/version');
      if (v && v.version) env.version = v.version + (v.commit ? ' (' + v.commit + ')' : '');
      if (v && v.node) env.node = v.node + ' on ' + (v.platform || 'unknown');
    } catch (e) {
      // The server not answering is itself worth reporting; say so rather than
      // dropping the field, and still open the form.
      env.version = 'unknown (GET /api/version failed: ' + e.message + ')';
    }
    // Built once: the window that is opened and the link that is reported when the
    // window is blocked must be the same report, not two calls that could differ.
    const url = bugReportUrl(env);
    let opened = null;
    try { opened = window.open(url, '_blank', 'noopener'); } catch (e) { opened = null; }
    if (!opened) {
      // A popup blocker turned "report a bug" into nothing at all. Say where the
      // report went, and actually put it there - the toast used to promise a
      // console entry that nothing wrote.
      try { console.warn('PacketForge bug report (popup blocked): ' + url); } catch (e) {}
      toast('Popup blocked — the finished report is in the browser console as a link');
    }
    return url;
  }

  // ---------- API ----------
  async function api(method, path, body) {
    const opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    let res;
    try {
      res = await fetch('/api' + path, opts);
    } catch (e) {
      // The server not answering is the single most common failure this app has, and it used
      // to leave no trace anywhere. Record it before rethrowing.
      recordError('network', method + ' /api' + path + ' failed: ' + ((e && e.message) || e));
      throw e;
    }
    if (!res.ok) {
      let msg = res.status + ' ' + res.statusText;
      try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) {}
      recordError('http ' + res.status, method + ' /api' + path + ': ' + msg);
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
    tap: 'Taps & packet brokers',
    splitter: 'PON Splitters (passive)',
    modem: 'Modems (DOCSIS / DSL)', powerline: 'Powerline / MoCA',
    host: 'End Devices', server: 'Servers', nas: 'NAS', desktop: 'Desktops', laptop: 'Laptops',
    phone: 'Phones', tablet: 'Tablets', printer: 'Printers', camera: 'IP Cameras',
    nvr: 'NVR / DVR', iot: 'IoT / Smart Home', cloud: 'Cloud / WAN'
  };
  // Network gear first, then the things that plug into it.
  const CAT_ORDER = ['router', 'switch', 'l3-switch', 'firewall', 'tap', 'wireless', 'ptp',
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

  // ---------- palette search ----------
  // Hardware names carry their punctuation inconsistently: the box says MC220L, the
  // datasheet says "MC 220L", an issue report says mc-220l, and the MikroTik SKU is
  // CRS326-24S+2Q+RM. Comparing raw substrings missed hardware that was sitting right
  // there in the catalogue, so both sides are folded to lowercase alphanumerics before
  // matching. That folding is the only fuzziness allowed on purpose: no edit distance
  // and no subsequence matching, because a typo should return nothing rather than a
  // page of unrelated devices.
  const SEARCH_NOISE = /[^a-z0-9]+/g;
  function searchKey(s) {
    return String(s == null ? '' : s).toLowerCase().replace(SEARCH_NOISE, '');
  }

  // Does the query appear as a whole word in this string? Word boundaries matter: a
  // category is a name someone chose, whereas a substring is usually an accident.
  function hasWord(str, q) {
    if (!q) return false;
    const parts = String(str == null ? '' : str).toLowerCase().split(/[^a-z0-9]+/);
    for (let i = 0; i < parts.length; i++) { if (parts[i] && parts[i] === q) return true; }
    return false;
  }

  // Lower is better: 0 exact model, 1 model prefix, 2 category word, 3 model substring,
  // 4 vendor(+model) hit, 5 some other field, 6 every whitespace token present
  // somewhere. -1 = no match.
  //
  // The category tier sits above the substring tier because a substring is far too easy
  // to hit by accident. "ont" is the project's own name for fibre CPE, and it is a
  // substring of "Controller" - so searching for an ONT returned 150 devices led by an
  // Aruba Mobility Controller and an ExtremeCloud IQ Controller, with the real ONTs
  // buried behind them. A whole word in a category is a deliberate name; ranking it
  // above accidental substrings is the difference between a search box and a lottery.
  // The keys a spec is searched by, computed once per spec object.
  //
  // Every keystroke used to rebuild them for all 2,015 specs: six lower-case-and-strip passes over
  // vendor, model, label, description, category and each alias, plus the concatenations. Measured at
  // ~10 ms per keystroke on this machine, which is 10% of a 100 Hz frame budget spent re-deriving
  // strings that cannot have changed - the catalogue is immutable for the life of the page.
  //
  // A WeakMap keyed on the spec object is the right shape: entries disappear with the specs, so a
  // reload that replaces the catalogue cannot leave stale keys behind, and nothing has to be
  // invalidated by hand.
  const keyCache = (typeof WeakMap === 'function') ? new WeakMap() : null;

  function specKeys(s) {
    if (keyCache) {
      const hit = keyCache.get(s);
      if (hit) return hit;
    }
    const model = searchKey(s.model);
    const vendor = searchKey(s.vendor);
    const aliases = (s.aliases || []).map(searchKey).filter(function (a) { return !!a; });
    const fields = [s.vendor, s.label, s.description, s.category].map(searchKey).join('\u0000');
    const keys = {
      model: model,
      vm: vendor + model,
      aliases: aliases,
      fields: fields,
      hay: model + '\u0000' + vendor + model + '\u0000' + aliases.join('\u0000') + '\u0000' + fields
    };
    if (keyCache) keyCache.set(s, keys);
    return keys;
  }

  function searchRank(s, q, tokens) {
    if (!q) return 6;                       // punctuation-only query: keep everything
    const k = specKeys(s);
    if (k.model === q) return 0;
    if (k.model.indexOf(q) === 0) return 1;
    // A declared alias ranks with a model prefix, not with a substring. An alias is somebody
    // typing the name they actually use: the board in the shelf ("B1LDCD"), the model without its
    // card complement ("E6616"), the short form of a long family name ("M1D-B"). A deliberate name
    // should not sit below an accident of spelling in a description. Aliases come from the spec,
    // so a device that declares none behaves exactly as before.
    for (const a of k.aliases) {
      if (a === q || a.indexOf(q) === 0) return 1;
    }
    if (hasWord(s.category, q)) return 2;
    if (k.model.indexOf(q) !== -1) return 3;
    if (k.vm.indexOf(q) !== -1) return 4;
    if (k.fields.indexOf(q) !== -1) return 5;
    for (const t of tokens) { if (k.hay.indexOf(t) === -1) return -1; }
    return tokens.length ? 6 : -1;
  }

  // Fabric capacity, when a device declares one: the cages a box has against the bits it can
  // actually move. The E6608 is the case that made this worth showing - 24x 100GE client cages
  // behind an 800G cross-connect is 3x the fabric, and the port list alone says only "100G"
  // twenty-four times. Pure, so the wording is testable without a DOM.
  function fabricGlob(name, glob) {
    const n = String(name || ''), g = String(glob || '');
    if (!g) return false;
    return g.charAt(g.length - 1) === '*' ? n.indexOf(g.slice(0, -1)) === 0 : n === g;
  }
  function fabricRate(speed) {
    const m = String(speed == null ? '' : speed).trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?)B?$/i);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    switch ((m[2] || '').toUpperCase()) {
      case 'K': return n / 1000;
      case 'M': return n;
      case 'G': return n * 1000;
      case 'T': return n * 1000000;
      default: return n;
    }
  }
  function humanRate(mbps) {
    if (mbps >= 1000000) return (mbps / 1000000).toFixed(mbps % 1000000 ? 1 : 0) + ' Tbit/s';
    if (mbps >= 1000) return (mbps / 1000).toFixed(mbps % 1000 ? 1 : 0) + ' Gbit/s';
    return mbps + ' Mbit/s';
  }
  function fabricSummary(spec) {
    if (!spec || !spec.fabric || typeof spec.fabric !== 'object') return null;
    const capacity = Number(spec.fabric.capacityMbps);
    if (!isFinite(capacity) || capacity <= 0) return null;
    const excludes = Array.isArray(spec.fabric.excludes) ? spec.fabric.excludes : [];
    let offered = 0;
    for (const i of spec.interfaces || []) {
      if (!i) continue;
      const type = i.type || 'ethernet';
      if (['ethernet', 'pon'].indexOf(type) === -1) continue;
      if (excludes.some(function (g) { return fabricGlob(i.name, g); })) continue;
      offered += fabricRate(i.speed);
    }
    const ratio = offered / capacity;
    return {
      capacityMbps: capacity,
      offeredMbps: offered,
      ratio: ratio,
      exceeds: offered > capacity,
      kind: spec.fabric.kind || 'fabric',
      text: humanRate(capacity) + ' ' + (spec.fabric.kind || 'fabric') +
        (ratio > 1 ? ' · ' + humanRate(offered) + ' of cages (' + ratio.toFixed(1) + '× oversubscribed)' : '')
    };
  }

  // Palette filter: vendor/type facets first, then search, best matches first. Ties
  // keep catalogue order (the sort is stable and the index breaks ties explicitly).
  function filterDevices(query, specs, filters) {
    const f = filters || {};
    const q = searchKey(query);
    const tokens = String(query == null ? '' : query).trim().toLowerCase()
      .split(/\s+/).map(searchKey).filter(function (t) { return !!t; });
    const ranked = [];
    const list = specs || [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s) continue;
      if (f.vendor && s.vendor !== f.vendor) continue;
      if (f.type && s.category !== f.type) continue;
      const rank = searchRank(s, q, tokens);
      if (rank < 0) continue;
      ranked.push({ spec: s, rank: rank, at: i });
    }
    ranked.sort(function (a, b) { return a.rank - b.rank || a.at - b.at; });
    return ranked.map(function (r) { return r.spec; });
  }

  // What the empty state should say. Pure, so the wording can be tested without a
  // DOM, and specific, so it names the thing that has to change rather than blaming
  // "your search / filters" in general.
  function describeEmptyState(f) {
    const q = String((f && f.q) || '').trim();
    const vendor = (f && f.vendor) || '';
    const type = (f && f.type) || '';
    const parts = [];
    if (q) parts.push('"' + q + '"');
    if (vendor) parts.push('vendor ' + vendor);
    if (type) parts.push('type ' + type);
    if (!parts.length) return 'The catalogue is empty - that is a bug, not a filter.';
    if (parts.length === 1) return 'Nothing matches ' + parts[0] + '.';
    return 'Nothing matches ' + parts.slice(0, -1).join(', ') + ' with ' + parts[parts.length - 1] + '.';
  }

  // Undo every narrowing control at once, and put the DOM back in step with the
  // state so the search box does not keep showing a query that is no longer applied.
  function clearPaletteFilter() {
    paletteFilter = { q: '', vendor: '', type: '' };
    ['#pf-search', '#pf-vendor', '#pf-type'].forEach(function (sel) {
      const el = $(sel);
      if (el) el.value = '';
    });
    renderPalette();
  }

  // ---------- palette keyboard ----------
  // The palette is the only way into a 1,700-model catalogue, and it was pointer-only:
  // type a query, get a ranked list, then reach for the mouse. Arrow keys and Enter are
  // what a search box is expected to do — and for anyone who cannot use a pointer they
  // are the difference between this catalogue being usable and being unavailable.
  let paletteActiveIndex = -1;

  // Pure, so the wrap behaviour is testable without a DOM. -1 means "nothing selected
  // yet", and the first ArrowDown from there selects the first card, not the second.
  function nextPaletteIndex(current, count, delta) {
    if (count <= 0) return -1;
    if (current < 0) return delta > 0 ? 0 : count - 1;
    const next = current + delta;
    if (next < 0) return count - 1;
    if (next >= count) return 0;
    return next;
  }

  function paletteCards() {
    return document.querySelectorAll('#palette-list .device-card');
  }

  function setPaletteActive(i) {
    const cards = paletteCards();
    for (let k = 0; k < cards.length; k++) cards[k].classList.remove('kbd-active');
    paletteActiveIndex = (i >= 0 && i < cards.length) ? i : -1;
    if (paletteActiveIndex < 0) return -1;
    const card = cards[paletteActiveIndex];
    card.classList.add('kbd-active');
    // The list scrolls; a highlight you cannot see is not a highlight.
    if (typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest' });
    const search = $('#pf-search');
    if (search && typeof search.setAttribute === 'function' && card.id) {
      search.setAttribute('aria-activedescendant', card.id);
    }
    return paletteActiveIndex;
  }

  function bindPaletteKeyboard() {
    const search = $('#pf-search');
    if (!search || typeof search.addEventListener !== 'function') return false;
    search.addEventListener('keydown', function (e) {
      const cards = paletteCards();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!cards.length) return;
        e.preventDefault();
        setPaletteActive(nextPaletteIndex(paletteActiveIndex, cards.length, e.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      if (e.key === 'Enter') {
        // Enter with nothing highlighted commits the only result. That is the common
        // case: people type until the list is one item long, then expect Enter to do
        // what clicking it would. With several results and no highlight, doing nothing
        // is right — picking one for them would be a guess.
        const target = paletteActiveIndex >= 0
          ? cards[paletteActiveIndex]
          : (cards.length === 1 ? cards[0] : null);
        if (!target) return;
        e.preventDefault();
        target.click();
        return;
      }
      if (e.key === 'Escape' && paletteActiveIndex >= 0) {
        e.preventDefault();
        setPaletteActive(-1);
      }
    });
    return true;
  }

  function renderPalette() {
    const list = $('#palette-list');
    list.innerHTML = '';
    // Every re-render is a new list, so any highlight from the previous one is stale.
    paletteActiveIndex = -1;
    const specs = catalog.specs || [];
    buildFilterControls();

    const q = searchKey(paletteFilter.q);
    const filtered = filterDevices(paletteFilter.q, specs, paletteFilter);

    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'palette-empty';
      const why = document.createElement('p');
      why.className = 'palette-empty-why';
      why.textContent = describeEmptyState(paletteFilter);
      empty.appendChild(why);
      // A search that can only ever say "no" is a dead end. Whatever the person
      // typed, they got here by narrowing, so offer the way back out rather than
      // making them find and undo three separate controls.
      if (paletteFilter.q || paletteFilter.vendor || paletteFilter.type) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'btn btn-quiet';
        clear.id = 'palette-clear';
        clear.textContent = 'Clear search and filters';
        clear.addEventListener('click', function () { clearPaletteFilter(); });
        empty.appendChild(clear);
      }
      list.appendChild(empty);
      return;
    }

    // group by manufacturer (vendor), collapsible. With no query the groups are
    // alphabetical; with a query they keep rank order, so the vendor that owns the
    // exact hit is the section at the top instead of being buried under A–M.
    const groups = {};
    const vendorNames = [];
    for (const s of filtered) {
      if (!groups[s.vendor]) { groups[s.vendor] = []; vendorNames.push(s.vendor); }
      groups[s.vendor].push(s);
    }
    if (!q) vendorNames.sort(function (a, b) { return vendorLabel(a).localeCompare(vendorLabel(b)); });

    // A palette that renders the whole catalogue with every vendor group expanded is not
    // a palette. Measured on the current catalogue: 1498 cards, 243 open groups, 115,115 px
    // of scroll inside a 289 px viewport - about 400 screens - and 11,358 DOM nodes built
    // before anyone asked to see them. Groups now start collapsed unless something is
    // narrowing the list (a query or a facet), and a group's cards are built the first time
    // it is opened. Searching still expands everything that matched, because then the list
    // is short and the ranking is the point.
    const narrowing = !!q || !!paletteFilter.vendor || !!paletteFilter.type;

    function buildCards(items, body) {
      for (const s of items) {
        const card = document.createElement('div');
        card.className = 'device-card';
        card.setAttribute('data-vendor', s.vendor);
        card.setAttribute('data-model', s.model);
        // A stable id so the search box can point at the highlighted card with
        // aria-activedescendant instead of moving focus into the list.
        card.id = 'pf-card-' + String(s.vendor).replace(/[^a-z0-9]+/gi, '-').toLowerCase() +
          '-' + String(s.model).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
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
    }

    // How much of the catalogue is on screen, stated rather than implied.
    const summary = document.createElement('div');
    summary.className = 'palette-summary';
    summary.textContent = narrowing
      ? filtered.length + ' of ' + specs.length + ' devices'
      : specs.length + ' devices in ' + vendorNames.length + ' vendor groups';
    list.appendChild(summary);

    for (const v of vendorNames) {
      const items = groups[v];
      const sec = document.createElement('div');
      sec.className = 'vendor-group' + (narrowing ? ' open' : '');
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'vendor-head';
      head.innerHTML = '<span class="vh-caret">' + (narrowing ? '▾' : '▸') + '</span><span class="vh-name">' + vendorLabel(v) + '</span><span class="vh-count">' + items.length + '</span>';
      const body = document.createElement('div');
      body.className = 'vendor-body';
      let built = false;
      head.addEventListener('click', function () {
        sec.classList.toggle('open');
        const isOpen = sec.classList.contains('open');
        head.querySelector('.vh-caret').textContent = isOpen ? '▾' : '▸';
        if (isOpen && !built) { buildCards(items, body); built = true; }
      });
      if (narrowing) { buildCards(items, body); built = true; }
      sec.appendChild(head);
      sec.appendChild(body);
      list.appendChild(sec);
    }

    // Hardware people have asked for that the catalogue does not have. Same list, same
    // search, so "is this supported?" gets an answer even when the answer is "not yet,
    // but it is on the list". Only while narrowing: at rest the palette is a catalogue,
    // not a changelog.
    if (q) {
      const asked = renderRequestedSection(q, specs);
      if (asked) list.appendChild(asked);
    }
  }

  // Requests whose subject matches the query and which the catalogue does not already
  // have. Pure, so the matching rules can be tested without a DOM or a network.
  //
  // Words are split here rather than with searchKey: searchKey strips separators
  // entirely (it exists to compare whole haystacks), so "hEX Refresh (E50UG)" comes back
  // as one run of letters and there is nothing to compare word by word.
  function searchWords(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }

  // "Already have" is judged generously, and deliberately so: a request titled
  // "Mikrotik hEX Refresh Router (E50UG)" is the device modelled as "hEX Refresh (E50UG)"
  // plus the word "Router". Requiring the strings to be equal would leave the card and
  // the request for the same box on screen together, which reads as "we have it and we
  // don't". So a request counts as modelled when every word of some catalogue key
  // appears in it.
  let modelledWordsCache = null;
  let modelledWordsFor = null;

  function modelledWords(specs) {
    if (modelledWordsFor === specs && modelledWordsCache) return modelledWordsCache;
    const out = [];
    for (const s2 of specs || []) {
      const w = searchWords(s2.vendor + ' ' + s2.model);
      if (w.length) out.push(w);
    }
    modelledWordsFor = specs;
    modelledWordsCache = out;
    return out;
  }

  function matchingRequests(q, requests, specs) {
    const qWords = searchWords(q);
    if (!qWords.length) return [];
    const models = modelledWords(specs);
    const out = [];
    for (const r of requests || []) {
      const hay = searchWords(r.subject);
      if (!hay.length) continue;
      // Prefix matching, so "e50" finds "e50ug" — people type the start of a model code.
      const found = qWords.every(function (qt) {
        return hay.some(function (ht) { return ht.indexOf(qt) === 0; });
      });
      if (!found) continue;
      const asked = new Set(hay);
      let isModelled = false;
      for (const modelWords of models) {
        if (modelWords.every(function (w) { return asked.has(w); })) { isModelled = true; break; }
      }
      if (isModelled) continue;
      out.push(r);
    }
    return out;
  }

  function renderRequestedSection(q, specs) {
    const asked = matchingRequests(q, openRequests, specs).slice(0, 5);
    if (!asked.length) return null;
    const sec = document.createElement('div');
    sec.className = 'requested-group';
    const head = document.createElement('div');
    head.className = 'requested-head';
    head.textContent = 'Requested, not yet modelled';
    sec.appendChild(head);
    for (const r of asked) {
      const a = document.createElement('a');
      a.className = 'requested-item';
      a.href = r.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.innerHTML = '<span class="rq-name">' + esc(String(r.subject || '')) + '</span>' +
        '<span class="rq-num">#' + esc(String(r.number)) + '</span>';
      sec.appendChild(a);
    }
    return sec;
  }

  function iconFor(s) {
    const m = {
      router: '🧭', switch: '🔀', 'l3-switch': '🔀', firewall: '🛡️', tap: '🔍', wireless: '📶', ptp: '📻',
      olt: '🏢', ont: '📡', splitter: '🔀', modem: '📞', powerline: '🔌',
      host: '🖥️', server: '🗄️', nas: '💾', desktop: '🖥️', laptop: '💻',
      phone: '📱', tablet: '📲', printer: '🖨️', camera: '📷', nvr: '🎥', iot: '🏠',
      cloud: '☁️', ap: '📶'
    };
    return m[s.category] || m[s.icon] || '📦';
  }

  // ---------- cable-colour legend ----------
  // The canvas draws nine cable families in nine colours (MEDIUM_RULES in canvas.js,
  // styled by the .link-* rules here) and nothing in the UI said which colour was
  // which, so a copper patch lead and a fibre uplink were only tellable apart if you
  // already knew the answer. The key lives in the palette rather than floating over
  // the drawing, so it can never sit on top of a device, and it collapses - remembered
  // in localStorage, because a preference that resets on every reload is not one.
  const CABLE_FAMILIES = [
    { id: 'copper', label: 'Copper — Cat5e/6/6a patch lead' },
    { id: 'fiber', label: 'Fibre — LC or MPO optic' },
    { id: 'dac', label: 'DAC — twinax, in-cabinet' },
    { id: 'aoc', label: 'AOC — active optical' },
    { id: 'pon', label: 'PON — shared splitter drop' },
    { id: 'coax', label: 'Coax — DOCSIS / MoCA' },
    { id: 'dsl', label: 'DSL — one twisted pair' },
    { id: 'powerline', label: 'Powerline — G.hn / HomePlug' },
    { id: 'wireless', label: 'Wireless — over the air' }
  ];
  const LEGEND_KEY = 'pf.cableLegend.collapsed';

  function legendStore() {
    // Private-mode browsers throw on access, and a UI preference is not worth a crash.
    try { if (typeof localStorage !== 'undefined' && localStorage) return localStorage; }
    catch (e) { return null; }
    return null;
  }

  function legendCollapsed() {
    const s = legendStore();
    try { return !!(s && s.getItem(LEGEND_KEY) === '1'); } catch (e) { return false; }
  }

  // One row per family, carrying the very class the canvas puts on the cable
  // (link-copper, link-pon, ...), so the swatch and the drawn line cannot drift apart.
  function cableLegendHTML() {
    return CABLE_FAMILIES.map(function (f) {
      return '<div class="lg-row link-' + f.id + '" data-family="' + f.id + '">' +
        '<span class="lg-chip" aria-hidden="true"></span>' +
        '<span class="lg-name">' + f.label + '</span></div>';
    }).join('');
  }

  function renderCableLegend() {
    const body = $('#legend-body');
    if (body) body.innerHTML = cableLegendHTML();
    const collapsed = legendCollapsed();
    const box = $('#cable-legend');
    if (box && box.classList) box.classList.toggle('collapsed', collapsed);
    const btn = $('#legend-toggle');
    if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    const caret = $('#legend-caret');
    if (caret) caret.textContent = collapsed ? '▸' : '▾';
    return collapsed;
  }

  function setLegendCollapsed(collapsed) {
    const s = legendStore();
    try { if (s) s.setItem(LEGEND_KEY, collapsed ? '1' : '0'); } catch (e) { /* quota, private mode */ }
    return renderCableLegend();
  }

  function bindLegend() {
    const btn = $('#legend-toggle');
    if (!btn || !btn.addEventListener) return;
    btn.addEventListener('click', function () {
      const box = $('#cable-legend');
      const isCollapsed = !!(box && box.classList && box.classList.contains('collapsed'));
      setLegendCollapsed(!isCollapsed);
    });
  }

  $('#pf-search').addEventListener('input', function () { paletteFilter.q = this.value; renderPalette(); });
  $('#pf-vendor').addEventListener('change', function () { paletteFilter.vendor = this.value; renderPalette(); });
  $('#pf-type').addEventListener('change', function () { paletteFilter.type = this.value; renderPalette(); });

  // ---------- canvas callbacks ----------
  PFCanvas.on.place = async function (x, y, spec) {
    try {
      const r = await api('POST', '/topologies/' + TOPO + '/devices', { vendor: spec.vendor, model: spec.model, x: Math.round(x), y: Math.round(y) });
      topo = r.state || topo;
      placing = null;
      document.querySelectorAll('.device-card').forEach(function (c) { c.classList.remove('active'); });
      PFCanvas.setPlacing(null);
      PFCanvas.setTopology(topo);
      select(r.device.id);
      setStatus('Placed ' + r.device.label);
    } catch (e) { toast(e.message); }
  };

  // A placement aimed at a point covered by a floating overlay - the toolbar, which sits
  // on top of the canvas at bottom-left. Placing there would create a device underneath
  // the panel: on the server, on the drawing, and impossible to click, drag or delete
  // (#33). canvas.js refuses and tells us; say why rather than leaving the click silent,
  // and stay in placing mode so the next click on the canvas works (#33).
  PFCanvas.on.placeBlocked = function (x, y, spec) {
    const what = spec && (spec.label || spec.model) ? (spec.label || spec.model) : 'The device';
    toast(what + ' was not placed: that spot is under the toolbar. Click the canvas.');
  };

  // ---------------------------------------------------------------------------
  // Create-link mode (issue #68)
  // ---------------------------------------------------------------------------
  //
  // Cabling was port-first: name the socket, and only then does the engine tell you whether
  // it works. The order people actually build in is "these two boxes need to talk" - so this
  // takes two device clicks, asks the engine for every legal cable between them, and shows
  // the link types with their port pairs underneath. The refusals come back grouped by code,
  // because "nothing fits" is a diagnosis and a technician needs to know which one.
  const linkMode = { armed: false, a: null };
  let linkBtn = null;

  function setLinkHint(msg) {
    // Same selector helper the rest of the app uses, so the stub DOM in the UI tests -
    // which implements querySelector but not getElementById - can load this file.
    const hint = $('#canvas-hint');
    if (hint) hint.textContent = msg;
  }

  function armLinkMode(on) {
    linkMode.armed = !!on;
    linkMode.a = null;
    if (linkBtn) linkBtn.classList.toggle('active', linkMode.armed);
    if (linkMode.armed) {
      setLinkHint('Create link: click the first device  ·  Esc to cancel');
    } else {
      setLinkHint('Scroll to zoom · drag to pan · click a device or cable to inspect · click a port to cable');
    }
  }

  async function openLinkOptions(aId, bId) {
    const resp = await api('POST', '/topologies/' + TOPO + '/link-options', { a: aId, b: bId });
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box lo-box';

    const an = (resp.a && resp.a.name) || 'device A';
    const bn = (resp.b && resp.b.name) || 'device B';

    if (!resp.ok) {
      box.innerHTML =
        '<div class="modal-title">Cannot cable ' + esc(an) + ' to ' + esc(bn) + '</div>' +
        '<div class="modal-sub">' + esc(resp.reason || 'no legal cable between these devices') + '</div>' +
        '<div class="lo-code">' + esc(resp.code || '') + '</div>' +
        (resp.refusals && Object.keys(resp.refusals).length
          ? '<div class="lo-refusals">' + Object.keys(resp.refusals).map(function (k) {
              return '<div><code>' + esc(k) + '</code> &times;' + resp.refusals[k] + '</div>';
            }).join('') + '</div>'
          : '') +
        '<div class="modal-actions"><button class="btn" data-act="close">Close</button></div>';
    } else {
      let html = '<div class="modal-title">Cable ' + esc(an) + ' &rarr; ' + esc(bn) + '</div>' +
        '<div class="modal-sub">' + resp.options.length + ' link type(s) available &middot; ' +
        resp.free.a + ' free port(s) on ' + esc(an) + ', ' + resp.free.b + ' on ' + esc(bn) + '</div>';
      html += '<div class="lo-list">';
      resp.options.forEach(function (o, oi) {
        html += '<div class="lo-opt' + (oi === 0 ? ' sel' : '') + '" data-oi="' + oi + '">' +
          '<div class="lo-head">' +
            '<span class="lo-media">' + esc(o.mediaName) + '</span>' +
            '<span class="lo-speed">' + (o.speedMbps ? fmtSpeed(o.speedMbps) : '') + '</span>' +
            '<span class="lo-ports">' + o.ports + ' port pair(s)</span>' +
          '</div>' +
          (o.warnings && o.warnings.length
            ? '<div class="lo-warn">' + o.warnings.map(function (w) { return esc(w.message || w.code); }).join('; ') + '</div>'
            : '') +
          '<div class="lo-pairs">' + o.pairs.map(function (pr, pi) {
            return '<button class="lo-pair" data-oi="' + oi + '" data-pi="' + pi + '">' +
              esc(pr.a.label || pr.a.iface) + ' <span class="lo-arrow">&harr;</span> ' +
              esc(pr.b.label || pr.b.iface) + '</button>';
          }).join('') + '</div>' +
          '</div>';
      });
      html += '</div>';
      html += '<div class="modal-actions"><button class="btn" data-act="close">Cancel</button></div>';
      box.innerHTML = html;
    }

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    return new Promise(function (resolve) {
      function done(v) { overlay.remove(); resolve(v); }
      overlay.addEventListener('click', async function (e) {
        if (e.target === overlay) return done(null);
        const act = e.target.closest('[data-act]');
        if (act) return done(null);
        const pairBtn = e.target.closest('.lo-pair');
        if (pairBtn) {
          const o = resp.options[Number(pairBtn.dataset.oi)];
          const pr = o.pairs[Number(pairBtn.dataset.pi)];
          let made = null;
          try {
            made = await api('POST', '/topologies/' + TOPO + '/links', {
              a: { deviceId: aId, iface: pr.a.iface },
              b: { deviceId: bId, iface: pr.b.iface },
              mediaId: o.mediaId || undefined,
              lengthM: lengthChoicesFor(o.family, o.maxRangeM)[0]
            });
          } catch (err) {
            // The engine refused at commit time. That should be rare - the list only offers
            // pairs that validated - so it means something changed underneath us, and the
            // message is the useful part.
            setLinkHint('Could not cable: ' + err.message);
            return done(null);
          }
          if (made && made.error) {
            setLinkHint('Could not cable: ' + (made.reason || made.error));
          } else {
            await refresh();
            setLinkHint('Cabled ' + (pr.a.label || pr.a.iface) + ' <-> ' + (pr.b.label || pr.b.iface));
          }
          return done(made);
        }
        const opt = e.target.closest('.lo-opt');
        if (opt) {
          box.querySelectorAll('.lo-opt').forEach(function (n) { n.classList.remove('sel'); });
          opt.classList.add('sel');
        }
      });
    });
  }

  // The second click of the pair. Kept separate from select() so the ordinary
  // click-to-inspect path is untouched when the mode is off.
  async function linkModeSelect(id) {
    if (!linkMode.a) {
      linkMode.a = id;
      const d = deviceById(id);
      setLinkHint('Create link: first device is ' + ((d && d.name) || 'selected') + '  ·  click the second device  ·  Esc to cancel');
      // Highlighting is a nicety; the pairing is the job. If rendering the inspector throws
      // on some device, the two-click flow must still work.
      try { select(id); } catch (e) { /* pairing does not depend on the panel */ }
      return;
    }
    if (linkMode.a === id) {
      linkMode.a = null;
      setLinkHint('Create link: click the first device  ·  Esc to cancel');
      return;
    }
    const aId = linkMode.a;
    linkMode.a = null;
    // Disarm before opening the panel, not after: openLinkOptions() only settles when the
    // panel is dismissed, so waiting would leave the canvas armed behind a modal - and a
    // stray select() would start a second pairing nobody asked for.
    armLinkMode(false);
    await openLinkOptions(aId, id);
  }

  function wireLinkButton() {
    linkBtn = $('#btn-link');
    if (linkBtn) {
      linkBtn.addEventListener('click', function () {
        armLinkMode(!linkMode.armed);
      });
    }
  }
  // app.js may be loaded with defer, in which case DOMContentLoaded has already fired by
  // the time this runs and the listener would never be called - the button would be inert.
  if (typeof document.readyState === 'string' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireLinkButton);
  } else {
    wireLinkButton();
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && linkMode.armed) { armLinkMode(false); return; }
    // C arms the mode, unless the user is typing into a field.
    const el = document.activeElement;
    const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    if (!typing && (e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      armLinkMode(!linkMode.armed);
    }
  });

  PFCanvas.on.select = function (id) {
    if (linkMode.armed) return linkModeSelect(id);
    select(id);
  };
  PFCanvas.on.selectLink = function (id) { selectLink(id); };

  // The canvas abandoned an in-flight cable because the user clicked empty space.
  // The canvas owns the state; this only owns the sentence the user reads.
  PFCanvas.on.connectCancel = function () { setStatus('Ready'); };

  PFCanvas.on.move = async function (id, x, y) {
    if (!topo.layout) topo.layout = {};
    topo.layout[id] = { x: x, y: y };
    try { await api('POST', '/topologies/' + TOPO + '/layout', { positions: { [id]: { x: x, y: y } } }); } catch (e) {}
  };

  // Modal that lets the user choose the physical medium for a new cable.
  // Lengths people actually buy.
  //
  // A DAC is a lead of a specific length, not a medium with a reach: "7 m" is the far
  // edge of what passive 10G copper will do, and the picker was printing it where the
  // photograph of the part number belongs. So a 3 m 10G DAC - the most ordinary part in
  // the rack - could not be expressed at all, and every DAC in a lab was silently made
  // at its maximum length (issue #31).
  const DAC_LENGTHS = [0.5, 1, 1.5, 2, 3, 5, 7, 10, 15, 20];
  const COPPER_LENGTHS = [0.5, 1, 2, 3, 5, 10, 15, 20, 30, 50, 75, 100];
  const FIBRE_LENGTHS = [0.5, 1, 2, 3, 5, 10, 20, 50, 100, 300, 550, 1000, 2000, 10000, 40000];

  function lengthChoicesFor(family, maxRangeM) {
    const table = family === 'dac' ? DAC_LENGTHS
      : (family === 'copper' ? COPPER_LENGTHS
      : (family === 'fiber' || family === 'fibre' ? FIBRE_LENGTHS : null));
    if (!table) return [];
    const ceiling = Number(maxRangeM) || 0;
    const within = ceiling > 0 ? table.filter(function (m) { return m <= ceiling; }) : table.slice();
    if (!within.length) within.push(ceiling || 1);
    return within;
  }

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
          '<span class="mo-meta">' + esc(o.family || '') +
            (o.maxRangeM ? ' &middot; up to ' + o.maxRangeM + ' m' : '') + '</span>' +
          '</label>';
      }
      html += '</div>';
      // Length. The ceiling above says how far the technology reaches; this says how long
      // the lead is, which is the thing you can actually buy.
      html += '<div class="modal-sub" style="margin-top:10px">Length</div>' +
        '<div class="length-row"><select id="pf-length"></select>' +
        '<input type="number" id="pf-length-other" min="0.1" step="0.1" placeholder="other (m)" ' +
        'style="width:110px;background:var(--bg-2);border:1px solid var(--border-2);color:var(--text);' +
        'border-radius:5px;padding:6px 8px"></div>';
      html += '<div class="modal-actions">' +
        '<button class="btn" data-act="cancel">Cancel</button>' +
        '<button class="btn primary" data-act="ok">Connect</button></div>';
      box.innerHTML = html;
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const lengthSel = box.querySelector('#pf-length');
      const lengthOther = box.querySelector('#pf-length-other');

      function selectedOption() {
        const chosen = box.querySelector('input[name=pf-media]:checked');
        if (!chosen) return null;
        for (const o of options) if (o.id === chosen.value) return o;
        return null;
      }

      function refreshLengths() {
        if (!lengthSel) return;
        const o = selectedOption();
        const choices = o ? lengthChoicesFor(o.family, o.maxRangeM) : [];
        lengthSel.innerHTML = '';
        for (const m of choices) {
          const opt = document.createElement('option');
          opt.value = String(m);
          opt.textContent = m + ' m';
          lengthSel.appendChild(opt);
        }
        // Default to the short lead: it is what is in the rack, and defaulting to the
        // maximum quietly made every cable as long as the technology allows.
        lengthSel.disabled = !choices.length;
        if (lengthSel.parentNode && !choices.length) lengthSel.parentNode.style.display = 'none';
      }

      if (box.querySelectorAll) {
        const radios = box.querySelectorAll('input[name=pf-media]');
        for (const r of radios) r.addEventListener('change', refreshLengths);
      }
      refreshLengths();

      function chosenLength() {
        if (!lengthSel || lengthSel.disabled) return null;
        const other = lengthOther && String(lengthOther.value || '').trim();
        if (other) {
          const n = parseFloat(other);
          return isFinite(n) && n > 0 ? n : null;
        }
        const v = parseFloat(lengthSel.value);
        return isFinite(v) && v > 0 ? v : null;
      }

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
          done(chosen ? { mediaId: chosen.value, lengthM: chosenLength() } : null);
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
  //
  // This is the ONE code path that makes a cable with the mouse, and it is reached both
  // by the first click (no pending connection → remember this end) and by the second
  // (pending connection → finish it). The canvas calls it for a port click in every
  // mode, including while the ghost cable is being dragged, so completing a link is the
  // same operation as starting one - there is no separate "drop" handler to get out of
  // step with this one (issues #61/#66).
  // Does this refusal come with an actionable fix? (issue #92)
  //
  // The engine answers a UPC-against-APC pair with E_POLISH_MISMATCH and a sentence naming
  // the hybrid cord that joins them. A sentence is not something an interface can act on,
  // so validateLink also returns `patchCordOptions` and marks the error with
  // `suggestion: { code: 'S_PATCH_CORD_REQUIRED', field: 'patchCord', value: 'SMSCSX' }`.
  // This function is the whole of the UI's opinion about that: hand back the offer, or null.
  function cordOfferFor(verdict) {
    if (!verdict || verdict.ok !== false) return null;
    const errors = verdict.errors || [];
    for (let i = 0; i < errors.length; i++) {
      const s = errors[i] && errors[i].suggestion;
      if (s && s.code === 'S_PATCH_CORD_REQUIRED' && s.value) {
        return { field: s.field || 'patchCord', value: s.value,
          lossDb: s.lossDb, label: s.message || ('Add ' + s.value) };
      }
    }
    // Fall back to the options list: an older server sends the parts but not the marker.
    const opts = verdict.patchCordOptions || [];
    if (opts.length && opts[0] && opts[0].patchCord) {
      return { field: 'patchCord', value: opts[0].patchCord, lossDb: opts[0].lossDb,
        label: 'Add ' + (opts[0].label || opts[0].patchCord) };
    }
    return null;
  }

  // "This run needs a part - add it?" Returns true if the user said yes.
  function askAddCord(offer) {
    return new Promise(function (resolve) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML =
        '<div class="modal" role="dialog" aria-label="Hybrid patch cord required">' +
        '<h2 style="margin:0 0 8px;font-size:15px">This run needs a hybrid patch cord</h2>' +
        '<div style="color:var(--text-dim);font-size:12px;line-height:1.5;margin-bottom:12px">' +
        'These two ports take the same connector with different polish, so they only join ' +
        'through a factory-terminated lead with one endface of each. The catalogue has one:' +
        '<div class="mono" style="margin:8px 0;color:var(--text)">' +
        String(offer.label) + '</div>' +
        (offer.lossDb !== undefined && offer.lossDb !== null
          ? '<div>Insertion loss ' + offer.lossDb + ' dB, which counts against the optical budget.</div>'
          : '') +
        '</div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end">' +
        '<button class="btn" data-act="cancel">Leave it disconnected</button>' +
        '<button class="btn primary" data-act="add">Add the cord</button></div></div>';
      function close(v) { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(v); }
      function onKey(e) { if (e.key === 'Escape') close(false); }
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) { close(false); return; }
        const act = e.target.getAttribute && e.target.getAttribute('data-act');
        if (act === 'cancel') close(false);
        if (act === 'add') close(true);
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
    });
  }

  PFCanvas.on.portClick = async function (deviceId, iface) {
    const c = PFCanvas.getConnecting();
    if (!c) {
      PFCanvas.setConnecting({ deviceId: deviceId, iface: iface });
      setStatus('Now click the destination port (Esc or an empty spot on the canvas to cancel)');
      return;
    }
    if (c.deviceId === deviceId) {
      // Same box twice: not a cable. Treated as "never mind", not as an error.
      PFCanvas.setConnecting(null);
      setStatus('Ready');
      return;
    }

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

    // A refusal that names a part is a refusal you can act on (issue #92). Before this,
    // the engine explained that an SC/UPC port and an SC/APC port are joined by a hybrid
    // cord and named the part number - and the interface could do nothing with it, so the
    // only way to build that run was to hand-edit the topology file. If the verdict carries
    // a suggestion, offer to apply it rather than printing a wall of text at the user.
    let patchCord = null;
    const offer = cordOfferFor(verdict);
    if (offer) {
      const accepted = await askAddCord(offer);
      if (accepted) {
        patchCord = offer.value;
        // Re-ask the engine with the cord declared. The cord is what makes the pair legal,
        // so the verdict is expected to flip rather than be overridden locally.
        try {
          verdict = await api('POST', '/topologies/' + TOPO + '/validate-link', {
            a: { deviceId: c.deviceId, iface: c.iface },
            b: { deviceId: deviceId, iface: iface },
            patchCord: patchCord
          });
          options = (verdict && verdict.mediaOptions) || options;
        } catch (e) { /* fall through to the refusal below */ }
      }
    }

    if (verdict && verdict.ok === false) {
      const err = (verdict.errors && verdict.errors[0]) || null;
      toast('Impossible: ' + (err ? err.message : 'incompatible ports'));
      PFCanvas.setConnecting(null);
      setStatus('Blocked: ' + (err ? err.code : 'E_LINK'));
      return;
    }

    // 2. Choose the medium
    let mediaId = verdict ? verdict.mediaId : null;
    let lengthM = null;
    if (options.length > 1) {
      const picked = await pickLinkMedia(options, verdict,
        devName(c.deviceId) + '/' + c.iface, devName(deviceId) + '/' + iface);
      if (!picked) { PFCanvas.setConnecting(null); setStatus('Ready'); return; }
      mediaId = picked.mediaId;
      lengthM = picked.lengthM;
    }

    // 3. Connect
    try {
      const r = await api('POST', '/topologies/' + TOPO + '/links', {
        a: { deviceId: c.deviceId, iface: c.iface },
        b: { deviceId: deviceId, iface: iface },
        mediaId: mediaId,
        lengthM: lengthM,
        patchCord: patchCord || undefined
      });
      topo = r.state || topo;
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
  PFCanvas.on.contextLink = function (id, x, y) { showLinkContextMenu(id, x, y); };

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

  // A port's own verdict, from the one rule in faceplate.js (#1238): "administratively down",
  // "down (no cable)", "down (peer shut down)", "up". The status bar used to print
  // "administratively down" or nothing at all, so an unplugged port read as healthy in the one view you
  // are looking at when a link will not come up.
  function portVerdict(dev, ifaceName) {
    const lib = (typeof window !== 'undefined' && window.PFFaceplate) || null;
    if (!lib || typeof lib.portState !== 'function') return null;
    const list = (dev && dev.interfaces) || [];
    const iface = Array.isArray(list) ? list.find(function (i) { return i.name === ifaceName; }) : list[ifaceName];
    if (!iface) return null;
    const links = (topo && topo.links) || [];
    const link = links.find(function (l) {
      if (!l || !l.a || !l.b) return false;
      return (l.a.deviceId === dev.id && l.a.iface === ifaceName) ||
             (l.b.deviceId === dev.id && l.b.iface === ifaceName);
    });
    let peerEnabled;
    if (link) {
      const other = link.a.deviceId === dev.id ? link.b : link.a;
      const peerDev = ((topo && topo.devices) || []).find(function (x) { return x.id === other.deviceId; });
      const plist = (peerDev && peerDev.interfaces) || [];
      const pi = Array.isArray(plist) ? plist.find(function (i) { return i.name === other.iface; }) : plist[other.iface];
      if (pi) peerEnabled = pi.enabled !== false;
    }
    const facts = { enabled: iface.enabled, cabled: !!link, peerEnabled: peerEnabled,
      linkDown: !!(link && link.state === 'down') };
    const verdict = lib.portState(facts);
    verdict.text = lib.portStateText(facts);
    return verdict;
  }

  // The inspector's Routes table, in the console's own terms (#1301).
  //
  // It used to print `code | dest/len | gw` straight out of runtime state, which meant three things the console
  // says were missing from the panel: the code the table actually prints (`S*` for the installed default rather
  // than a bare `S`), the administrative distance that decides which route wins, and - the one that mattered -
  // the sentence saying a row cannot carry a packet. On a router whose only uplink was down, the console marked
  // every row `(down: link down)` while the panel drew a perfectly healthy table.
  //
  // The verdict is computed once, in `Device.routesTable(topo)`; this only formats it. `unusable` drives the
  // styling, so a row that cannot be used does not look like one that can.
  function routesRows(d) {
    const rows = (topo.runtime && topo.runtime[d.id] && topo.runtime[d.id].routes) || [];
    return rows.map(function (r) {
      const connected = r.type === 'connected';
      let via;
      if (connected) {
        via = 'is directly connected, ' + (r.iface && r.iface !== '-' ? r.iface : '-');
      } else {
        via = 'via ' + (r.gw && r.gw !== '-' ? r.gw : '-') +
          (r.iface && r.iface !== '-' ? '  ' + r.iface : '') +
          (typeof r.distance === 'number' ? '  [' + r.distance + '/0]' : '');
      }
      // A payload from an older server carries no verdict. Saying "not checked" is honest; printing nothing
      // would put the panel back where it started, implying every row is fine because nobody looked.
      const unchecked = typeof r.unusable !== 'boolean' && r.checked !== true;
      return {
        code: r.displayCode || r.code,
        network: r.dest + '/' + maskBits(r.mask),
        via: via,
        note: r.note || (unchecked ? '(not checked)' : ''),
        unusable: !!r.unusable
      };
    });
  }

  // The interface header summarises the rows underneath it, and it used to count `enabled` - so a device
  // with nothing plugged in read "28 ports · 28 up" while the front panel two lines above painted every socket
  // `notconnect` and the console said `down (no cable)` for all 28 (#1299). A summary that disagrees with the
  // rows it summarises is worse than no summary: it is the line people read.
  //
  // So the count comes from the same `portVerdict()` the rows and the front panel use, and every port that is
  // not up is accounted for by reason rather than dropped.
  function interfacesHeader(d) {
    const total = (d.interfaces || []).length;
    const groups = [];
    let up = 0;
    for (const i of d.interfaces) {
      const v = portVerdict(d, i.name);
      // No verdict means the shared rule is not loaded (or the row is not in the hardware list). Say that,
      // rather than falling back to `enabled`, which is the guess that caused this defect in the first place:
      // an administratively enabled port with no cable is not up.
      const label = v ? (v.state === 'up' ? 'up' : v.text)
        : (i.enabled === false ? 'administratively down' : 'unknown (no state rule loaded)');
      if (label === 'up') { up++; continue; }
      const g = groups.filter(function (x) { return x.label === label; })[0];
      if (g) g.count++;
      else groups.push({ label: label, count: 1 });
    }
    groups.sort(function (a, b) { return b.count - a.count; });
    let text = total + ' port' + (total === 1 ? '' : 's') + ' · ' + up + ' up';
    for (const g of groups) text += ' · ' + g.count + ' ' + g.label;
    return { total: total, up: up, groups: groups, text: text };
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

    // The aliases are shown, not just searchable: if somebody found this device by typing
    // "B1LDCD", the panel should say why it appeared rather than leaving the match unexplained.
    const aliases = (d.spec && d.spec.aliases) || [];
    if (aliases.length) {
      html += '<div class="kv"><span class="k">Also known as</span><span>' + aliases.join(' · ') + '</span></div>';
    }
    // A device can have far more cage capacity than its fabric can move. Saying so in the
    // inspector is the difference between a reader discovering it in a lab and reading it here.
    const fab = fabricSummary(d.spec || {});
    if (fab) {
      html += '<div class="kv"><span class="k">' + (fab.kind.charAt(0).toUpperCase() + fab.kind.slice(1)) +
        '</span><span' + (fab.exceeds ? ' title="the ports offer more than the fabric can switch at once"' : '') +
        '>' + fab.text + '</span></div>';
    }

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
    const ifHdr = interfacesHeader(d);
    html += '<div class="field-label">Interfaces <span class="iface-count">' + ifHdr.text + '</span></div>';
    html += '<input id="iface-filter" class="iface-filter" type="search" placeholder="filter ports by name, media or IP…" autocomplete="off" spellcheck="false">';
    html += '<div class="iface-list" id="iface-list">';
    for (const i of d.interfaces) html += ifaceRowHTML(d, i);
    html += '</div>';
    html += '<div class="hint" style="margin-top:6px">Click a port to edit its IP and admin state, and to see its real hardware. Toggle ▲/▼ to shut it down.</div>';

    // routes
    html += '<div class="field-label">Routes</div>';
    const routeRows = routesRows(d);
    if (routeRows.length) {
      html += '<table class="iface-table"><thead><tr><th>Type</th><th>Network</th><th>Via</th></tr></thead><tbody>';
      for (const r of routeRows) {
        html += '<tr class="' + (r.unusable ? 'route-dead' : '') + '"><td>' + r.code + '</td><td>' + r.network +
          '</td><td>' + r.via + (r.note ? ' <span class="route-note">' + r.note + '</span>' : '') + '</td></tr>';
      }
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
    // render - same as the interface editors below. Both of them: a cable's Delete is
    // generated by the cable inspector, which renders into the same panel.
    bindDeviceDelete();
    bindLinkDelete();

    // Clicking a port on the panel reports it in the status bar: the panel answers
    // "where is it", this answers "what is it".
    if (typeof window !== 'undefined' && window.PFFaceplate && typeof window.PFFaceplate.bind === 'function') {
      const fp = wrap.querySelector('.fp-wrap');
      if (fp) {
        try {
          window.PFFaceplate.bind(fp, function (hit) {
            const name = hit && (hit.port || hit.name);
            const iface = name ? d.interfaces && (d.interfaces[name] || d.interfaces.find(function (i) { return i.name === name; })) : null;
            if (iface) {
              const verdict = portVerdict(d, name);
              const why = verdict && verdict.state !== 'up' && verdict.state !== 'cabled'
                ? ' (' + verdict.text + ')'
                : '';
              setStatus(name + ' - ' + (iface.cage || 'connector unknown') + why);
            }
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
          topo = r.state || topo; PFCanvas.setTopology(topo); renderDeviceTab();
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
          topo = r.state || topo; PFCanvas.setTopology(topo); renderDeviceTab();
          toast(iface + ' is now a ' + next.toUpperCase() + ' port');
        } catch (e) { toast(e.message); }
      });
    });
    const hn = wrap.querySelector('#hostname-input');
    if (hn) hn.addEventListener('change', async function () {
      try {
        const r = await api('POST', '/topologies/' + TOPO + '/config/' + d.id, { commands: ['configure terminal', 'hostname ' + hn.value.trim()] });
        topo = r.state || topo; PFCanvas.setTopology(topo); select(d.id);
      } catch (e) { toast(e.message); }
    });
  }

  function maskBits(mask) {
    // The same rule the engine uses (#1249): a bare number is a prefix length, a dotted mask is its run
    // of leading ones, and anything that is not a run of ones then zeros has no prefix length at all -
    // '?' is honest, where counting every set bit gave a confident wrong answer (255.0.255.0 counted as
    // /16). The engine refuses to configure such a mask; a lab saved before it did still has to render.
    if (!mask) return '?';
    const text = String(mask).trim();
    if (/^\d{1,2}$/.test(text)) {
      const bits = Number(text);
      return bits >= 0 && bits <= 32 ? String(bits) : '?';
    }
    const parts = text.split('.');
    if (parts.length !== 4) return '?';
    let ones = 0;
    let zeros = 0;
    for (const part of parts) {
      const n = Number(part);
      if (!Number.isInteger(n) || n < 0 || n > 255) return '?';
      for (let i = 7; i >= 0; i--) {
        if ((n >> i) & 1) { if (zeros) return '?'; ones++; } else zeros++;
      }
    }
    return String(ones);
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
          topo = r.state || topo; PFCanvas.setTopology(topo); renderDeviceTab();
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
        topo = r.state || topo; PFCanvas.setTopology(topo); renderDeviceTab();
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

  // Mirror of engine/vlan.js `switchportSentence()`, which the console prints after "switchport: " in
  // `show interfaces <port>`. The browser cannot require the engine, so the rule exists twice on purpose and
  // test/switchport-agreement.test.js compares the two across a matrix of port states. They had already
  // drifted: the panel said `access 1` for a port the console reported as staged for a trunk, because only the
  // console knew about stored-but-not-in-use parameters.
  function switchportSentence(v) {
    const raw = (v && typeof v === 'object') ? v : {};
    const mode = raw.mode === 'trunk' ? 'trunk' : 'access';
    const int = function (x, dflt) {
      const n = Number(x);
      return Number.isFinite(n) && n > 0 ? n : dflt;
    };
    const accessVlan = int(raw.accessVlan, 1);
    const nativeVlan = (raw.nativeVlan === undefined || raw.nativeVlan === null)
      ? (mode === 'trunk' ? 1 : accessVlan) : int(raw.nativeVlan, 1);
    // An empty list is a trunk that allows nothing, so it reads `none` - the same answer `classifyEgress`
    // gives. Only an unset field means all.
    let allowed = 'all';
    if (Array.isArray(raw.allowedVlans)) {
      allowed = raw.allowedVlans.length ? raw.allowedVlans.join(',') : 'none';
    } else if (typeof raw.allowedVlans === 'string' && raw.allowedVlans.trim() &&
      raw.allowedVlans.trim().toLowerCase() !== 'all') {
      allowed = raw.allowedVlans.trim();
    }
    if (mode === 'trunk') {
      return 'trunk · native ' + nativeVlan + ' · allowed ' + allowed;
    }
    let line = 'access VLAN ' + accessVlan;
    const staged = [];
    if (raw.nativeVlan !== undefined && raw.nativeVlan !== null && Number(raw.nativeVlan) !== 1) {
      staged.push('native ' + Number(raw.nativeVlan));
    }
    if (Array.isArray(raw.allowedVlans) && raw.allowedVlans.length) {
      staged.push('allowed ' + raw.allowedVlans.join(','));
    } else if (typeof raw.allowedVlans === 'string' && raw.allowedVlans.trim() &&
      raw.allowedVlans.trim().toLowerCase() !== 'all') {
      staged.push('allowed ' + raw.allowedVlans.trim());
    }
    if (staged.length) line += ' · trunk staged: ' + staged.join(', ') + ' (not in use)';
    return line;
  }

  function vlanSummary(i) {
    return switchportSentence(i && i.vlan);
  }

  // Display mirror of Simulator.computePoe(): a PSE serves powered devices in
  // port-name order until its budget runs out. ui-render.test.js asserts this
  // agrees with the engine, so the two cannot drift apart silently.
  function poeSummary(d) {
    // Only a port that is administratively up can power anything: `Simulator.computePoe()` walks
    // `activeInterfaces()`, so a shut-down PSE port serves no power and is not in its table at all. The panel
    // walked every port, so a shut-down port was reported as powering a device the engine was not powering -
    // the panel inventing 12.95 W that was not being drawn. `psePorts` above stays a hardware count (the ports
    // exist whether or not they are enabled); the power accounting follows the engine.
    const psePorts = d.interfaces
      .filter(function (i) { return i.poeOut && i.enabled; })
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

    // The cable peer and the LLDP neighbour both describe this same port, and they
    // are allowed to disagree - the cable record is wiring, the LLDP one is what the
    // far end claims. Neither may hide the other (issue #25: as bare grid children of
    // .iface-head they were auto-placed into the 10px dot column, where two nowrap
    // labels at different offsets drew on top of each other and neither was legible).
    // They get their own line under the port, and they can wrap.
    const portLabels = (peerText || lldpText)
      ? '<div class="port-labels">' + peerText + lldpText + '</div>'
      : '';

    let html = '<div class="iface-row" data-iface="' + i.name + '">';
    html += '<div class="iface-head">' +
      '<span class="dot ' + (i.enabled ? 'up' : 'down') + '"></span>' +
      '<span class="port-name">' + i.name + '</span>' +
      '<span class="port-media">' + hw + '</span>' +
      '<span class="port-ip' + (i.ip ? ' has' : '') + '">' + ipText + '</span>' +
      portLabels +
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

  // ---------- catalogue parts for a medium ----------
  // "10gbase-lr" is a standard, not a part. The link inspector used to stop there, so a
  // cable told you what it was called and nothing about what you would actually order:
  // SFP-10G-LR reaches 10 km, terminates in an LC/UPC ferrule and transmits at 1310 nm.
  // Those numbers live in catalogue/optics/transceivers.json, which is outside the static
  // root (the server serves web/ only), so the browser cannot fetch it: hence this
  // snapshot, one line per part, in this order -
  //
  //   part number | form factor | standard implemented | line rate Mbps | reach m | ferrule | wavelength nm
  //
  // test/link-parts.test.js diffs it field by field against the JSON, so an edited
  // catalogue fails the build instead of the UI quietly quoting a reach nobody sells.
  const PART_ROWS = [
    'GLC-SX-MMD|sfp|1000BASE-SX|1000|550|LC/UPC|850',
    'GLC-LH-SMD|sfp|1000BASE-LX/LH|1000|10000|LC/UPC|1310',
    'GLC-TE|sfp|1000BASE-T|1000|100|RJ45|',
    'GLC-ZX-SMD|sfp|1000BASE-ZX|1000|70000|LC/UPC|1550',
    'SFP-10G-SR|sfp+|10GBASE-SR|10000|400|LC/UPC|850',
    'SFP-10G-LR|sfp+|10GBASE-LR|10000|10000|LC/UPC|1310',
    'SFP-10G-ER|sfp+|10GBASE-ER|10000|40000|LC/UPC|1550',
    'SFP-10G-T-X|sfp+|10GBASE-T|10000|30|RJ45|',
    'SFP-10G-BXU-I|sfp+|10GBASE-BX10-U|10000|10000|LC/UPC|1270',
    'SFP-10G-BXD-I|sfp+|10GBASE-BX10-D|10000|10000|LC/UPC|1330',
    'GLC-BX-U|sfp|1000BASE-BX10-U|1000|10000|LC/UPC|1310',
    'GLC-BX-D|sfp|1000BASE-BX10-D|1000|10000|LC/UPC|1490',
    'CWDM-SFP10G-40L|sfp+|10GBASE-ER/EW (CWDM)|10000|40000|LC/UPC|1470',
    'SFP-25G-SR-S|sfp28|25GBASE-SR|25000|100|LC/UPC|850',
    'SFP-10/25G-LR-S|sfp28|25GBASE-LR|25000|10000|LC/UPC|1310',
    'QSFP-40G-SR4-S|qsfp+|40GBASE-SR4|40000|150|MPO/UPC|850',
    'QSFP-40G-LR4-S|qsfp+|40GBASE-LR4|40000|10000|LC/UPC|1310',
    'QSFP-40G-SR-BD|qsfp+|40GBASE-SR-BiDi|40000|150|LC/UPC|850',
    'QSFP-100G-SR4-S|qsfp28|100GBASE-SR4|100000|100|MPO/UPC|850',
    'QSFP28-LR4-100G|qsfp28|100GBASE-LR4|100000|10000|LC/UPC|1310',
    'QSFP28-IR4-100G|qsfp28|100GBASE-CWDM4|100000|2000|LC/UPC|1310',
    'GSFP-43-20C|sfp|GPON OLT Class C+ (ITU-T G.984.2)|2488|20000|SC/UPC|1490',
    'XGS-SFP-52-20N2I|sfp+|XGS-PON OLT Class N2 (ITU-T G.9807.1)|9953|20000|SC/UPC|1577',
    'GSFP-34-20B-I|sfp|GPON ONU Class B+ (ITU-T G.984.2)|2488|20000|SC/UPC|1310',
    'XGS-SFP-25-20I|sfp+|XGS-PON ONU Class N1/N2 (ITU-T G.9807.1)|9953|20000|SC/APC|1270',
    // Huawei 10GE SFP+ family (#237). Part names in Huawei's own datasheet carry the
    // facts - "Optical Transceiver,SFP+,10G,Single-mode Module(1310nm,10km,LC)" - so the
    // reach and wavelength here are read off the part name, not inferred from the rate.
    // The two eKit rows are the same optics sold through a different channel; they are
    // listed separately because a lab ordering parts needs the part number it will receive.
    'OMXD30000|sfp+|10GBASE-SR|10000|300|LC/UPC|850',
    'OSX010000|sfp+|10GBASE-LR|10000|10000|LC/UPC|1310',
    'OSX040N01|sfp+|10GBASE-ER|10000|40000|LC/UPC|1550',
    'SFP-10G-ZR|sfp+|10GBASE-ZR|10000|80000|LC/UPC|1550',
    'SFP-10G-SR-eKit|sfp+|10GBASE-SR|10000|300|LC/UPC|850',
    'SFP-10G-LR-eKit|sfp+|10GBASE-LR|10000|10000|LC/UPC|1310',
    'SFP-10G-BXU1|sfp+|10GBASE-BX10-U|10000|10000|LC/UPC|1270',
    'SFP-10G-BXD1|sfp+|10GBASE-BX10-D|10000|10000|LC/UPC|1330',
    'SFP-10GBaseT-SR|sfp+|10GBASE-T|10000|30|RJ45|'
  ];

  // "10GBASE-ER/EW (CWDM)" -> "10gbase-er": the first token is the medium the part
  // serves, and it is the only part of the standard that maps onto a mediaId.
  function standardKey(standard) {
    return String(standard || '').toLowerCase().split(/[\s/()]+/)[0];
  }

  const OPTIC_PARTS = PART_ROWS.map(function (row) {
    const f = row.split('|');
    return {
      partNumber: f[0], formFactor: f[1], standard: f[2],
      speedMbps: Number(f[3]), reachM: Number(f[4]), ferrule: f[5],
      wavelengthNm: f[6] ? Number(f[6]) : null,
      standardKey: standardKey(f[2])
    };
  });

  function reachLabel(m) {
    const n = Number(m);
    if (!isFinite(n) || n <= 0) return 'reach not stated';
    return n >= 1000 ? (Math.round(n / 100) / 10) + ' km' : n + ' m';
  }

  function partsForMedia(mediaId) {
    const id = String(mediaId || '').toLowerCase().trim();
    if (!id) return [];
    const exact = [], prefixed = [];
    for (const p of OPTIC_PARTS) {
      if (p.standardKey === id) { exact.push(p); continue; }
      // A PON module implements a whole family ("GPON") while the medium names the
      // connector too ("gpon-sc-apc"), so extend a match only on a word boundary. That
      // keeps 10GBASE-LR off a 10GBASE-LR4 run: "-lr" prefixes "-lr4" mid-word.
      if (id.length > p.standardKey.length + 1 && id.indexOf(p.standardKey) === 0 &&
          /[-_.\/ ]/.test(id.charAt(p.standardKey.length))) prefixed.push(p);
    }
    // An exact hit is a statement about this medium; a prefix hit only places the part
    // in the family, so it must never outrank one that names the medium itself.
    return exact.length ? exact : prefixed;
  }

  function partsHTML(mediaId) {
    const parts = partsForMedia(mediaId);
    if (!parts.length) {
      // Say it out loud. An empty box reads as a broken inspector; "the catalogue has
      // no part" is an answer, and it is the honest one for coax, DSL or wireless.
      return '<div class="parts-none">The catalogue has no part for this medium - ' +
        'catalogue/optics/transceivers.json lists no transceiver that implements ' +
        '<span class="mono">' + esc(String(mediaId || 'unknown')) + '</span>, so there ' +
        'is no part number, reach or ferrule to quote.</div>';
    }
    let h = '<div class="parts-list">';
    for (const p of parts) {
      const spec = [cageLabel(p.formFactor), reachLabel(p.reachM),
        p.wavelengthNm ? p.wavelengthNm + ' nm' : null, p.ferrule]
        .filter(Boolean).join(' · ');
      h += '<div class="part-row" data-part="' + esc(p.partNumber) + '">' +
        '<span class="part-no mono">' + esc(p.partNumber) + '</span>' +
        '<span class="part-spec">' + spec + '</span></div>';
    }
    return h + '</div>';
  }

  // Inspector for a selected cable: media, negotiated rate, both ends.
  function renderLinkInspector(wrap) {
    // topo is null until boot() has fetched it, and the stub environments the render tests
    // use never fire DOMContentLoaded at all. A missing topology is "no such cable", not a
    // TypeError halfway through painting the panel.
    const links = (topo && topo.links) || [];
    const link = links.find(function (l) { return l.id === selectedLink; });
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
    // Length is editable, because it belongs to the lead and not to the wiring job: the
    // run you pulled is whatever length it is. It could previously only be set while the
    // cable was being created, so a link that already existed could never be given a
    // length at all (issue #31).
    html += '<div class="kv"><span class="k">Length</span><span>' +
      '<input type="number" id="link-length" min="0.1" step="0.1" value="' +
        (link.lengthM === null || link.lengthM === undefined ? '' : link.lengthM) +
        '" placeholder="not recorded" style="width:88px;background:var(--bg-2);' +
        'border:1px solid var(--border-2);color:var(--text);border-radius:5px;padding:3px 6px"> m ' +
      '<button class="btn" id="link-length-save" style="margin-left:6px">Set</button>' +
      '</span></div>';
    if (link.lagId) html += '<div class="kv"><span class="k">LAG</span><span>group ' + link.lagId + '</span></div>';
    html += '<div class="kv"><span class="k">State</span><span>' + (link.state || 'up') + '</span></div>';

    // What a medium is called is not what you order. Name the parts the catalogue
    // says implement it, with the reach and the ferrule that go with them.
    const mediaKey = link.mediaId || link.media || '';
    html += '<div class="field-label">Catalogue parts</div>';
    html += partsHTML(mediaKey);

    html += '<div class="field-label">Endpoints</div>';
    html += endpointHTML(da, link.a.iface, ia);
    html += endpointHTML(db, link.b.iface, ib);

    html += '<div class="verdict">Cages mate and the media is supported at both ends — ' +
      'this cable passed the physical-layer check when it was created. An impossible ' +
      'combination is refused at that moment, not silently accepted.</div>';

    // A cable could not be removed from the UI at all before this (issue #86): the engine
    // had disconnect() and the server had DELETE /links/:id, and nothing reached either.
    // Deleting a device took its cables with it, so the only way out of a mis-dragged run
    // was to destroy a device and rebuild both ends.
    html += '<div style="display:flex;gap:8px;margin-top:10px">' +
      '<button id="btn-delete-link" class="btn danger" style="padding:4px 10px;font-size:12px" ' +
      'title="Remove this cable and leave both devices in place">Delete cable</button></div>';

    wrap.innerHTML = html;

    const lenBox = wrap.querySelector('#link-length');
    const lenSave = wrap.querySelector('#link-length-save');
    if (lenBox && lenSave) {
      const commit = async function () {
        const raw = String(lenBox.value || '').trim();
        const value = raw === '' ? null : parseFloat(raw);
        try {
          const r = await api('PATCH', '/topologies/' + TOPO + '/links/' + link.id, { lengthM: value });
          topo = r.state || topo;
          PFCanvas.setTopology(topo);
          renderLinkInspector(wrap);
          const warn = (r.warnings || [])[0];
          if (warn) { toast(warn.message); setStatus('Cable length set, with a warning'); }
          else setStatus('Cable length set to ' + (value === null ? 'not recorded' : value + ' m'));
        } catch (e) {
          toast('Could not set the length: ' + e.message);
        }
      };
      lenSave.addEventListener('click', commit);
      lenBox.addEventListener('keydown', function (e) { if (e.key === 'Enter') commit(); });
    }
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
      topo = r.state || topo; PFCanvas.setTopology(topo);
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

  // The same menu for a cable (issue #86). A cable had no delete affordance at all: the
  // engine's disconnect() and DELETE /links/:id both existed and nothing in the UI reached
  // them, so a mis-dragged cable could only be removed by deleting one of the devices it
  // touched - which is the complaint in the issue, and it made a whole class of lab
  // unrecoverable without discarding work.
  function showLinkContextMenu(id, x, y) {
    const menu = $('#context-menu');
    if (!menu) { setStatus('Context menu unavailable - use Delete cable in the inspector'); return; }
    const link = (topo.links || []).filter(function (l) { return l.id === id; })[0];
    const down = link && link.state && link.state !== 'up';
    menu.innerHTML =
      '<div class="cm-item" data-act="inspect">Inspect cable</div>' +
      // Pulling a cable and deleting one are different operations: the ports stay patched, the
      // hardware stays as it is, and only the link dies - which is what actually happens.
      (down ? '<div class="cm-item" data-act="up">Bring link up</div>'
            : '<div class="cm-item" data-act="down">Take link down</div>') +
      '<div class="cm-item danger" data-act="delete">Delete cable</div>';
    menu.style.display = 'block';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.onclick = async function (e) {
      const act = e.target.getAttribute('data-act');
      menu.style.display = 'none';
      if (act === 'inspect') selectLink(id);
      else if (act === 'down') await setLinkState(id, 'down');
      else if (act === 'up') await setLinkState(id, 'up');
      else if (act === 'delete') await deleteLink(id);
    };
    document.addEventListener('click', function hide() { menu.style.display = 'none'; document.removeEventListener('click', hide); });
  }

  /**
   * Take a cable down (or put it back) and let the network re-converge from that instant.
   *
   * The simulator re-runs every control-plane timer from the moment of the change, so the answer
   * comes back with the time at which the lab is whole again - which the status line shows,
   * because "it will work in thirty seconds" is the useful half of the answer.
   */
  async function setLinkState(id, state) {
    if (!topo) return;
    try {
      const res = await fetch('/api/topologies/' + encodeURIComponent(topo.id) + '/links/' +
        encodeURIComponent(id) + '/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: state, atMs: Date.now() % 100000 })
      });
      if (!res.ok) {
        setStatus('Could not change the link: ' + ((await res.json()).error || res.status));
        return;
      }
      const body = await res.json();
      await refresh();
      setStatus(state === 'down'
        ? 'Link down. The network converges again at ' + body.reconvergeAtMs + ' ms.'
        : 'Link up. Convergence re-based; whole again at ' + body.reconvergeAtMs + ' ms.');
    } catch (e) {
      setStatus('Could not change the link: ' + e.message);
    }
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

  function bindLinkDelete() {
    // Same defensive lookup as bindDeviceDelete: the render tests drive this against a
    // stub DOM, and a missing element must degrade rather than throw.
    let btn = null;
    try {
      btn = (typeof document.getElementById === 'function')
        ? document.getElementById('btn-delete-link')
        : document.querySelector('#btn-delete-link');
    } catch (e) { btn = null; }
    if (!btn || !btn.addEventListener) return;
    btn.addEventListener('click', function () {
      if (selectedLink) deleteLink(selectedLink);
    });
  }

  async function deleteDevice(id) {
    try {
      const r = await api('DELETE', '/topologies/' + TOPO + '/devices/' + id);
      topo = r.state || topo;
      if (selectedId === id) selectedId = null;
      PFCanvas.setTopology(topo); PFCanvas.setSelected(null);
      renderDeviceTab(); renderSimulateTab();
      setStatus('Deleted device ' + id);
    } catch (e) { toast(e.message); }
  }

  // Delete one cable and nothing else (issue #86). Deliberately not "delete the selected
  // thing": a cable and a device are different objects with different consequences, and the
  // endpoint is already the narrower one (DELETE /links/:id removes exactly one link).
  async function deleteLink(id) {
    if (!id) return;
    try {
      const r = await api('DELETE', '/topologies/' + TOPO + '/links/' + id);
      topo = r.state || topo;
      if (selectedLink === id) selectedLink = null;
      PFCanvas.setTopology(topo);
      if (PFCanvas.setSelectedLink) PFCanvas.setSelectedLink(null);
      renderDeviceTab(); renderSimulateTab();
      setStatus('Deleted cable ' + id);
    } catch (e) { toast(e.message); }
  }

  // What Delete/Backspace would act on, given the current selection. Kept as its own
  // function so the rule is stated once and can be asserted without a browser: a cable
  // selection wins, because selecting a cable clears the device selection.
  function deleteTarget() {
    if (selectedLink) return 'link';
    if (selectedId) return 'device';
    return null;
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
          topo = r.state || topo; selectedId = null;
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
        topo = r.state || topo; selectedId = null;
        PFCanvas.setTopology(topo); PFCanvas.setSelected(null);
        renderDeviceTab(); renderSimulateTab();
        setStatus('New empty topology');
      } catch (e) { toast(e.message); }
    });

    $('#btn-reset').addEventListener('click', async function () {
      try { await api('POST', '/topologies/' + TOPO + '/reset'); toast('ARP/MAC tables cleared'); } catch (e) { toast(e.message); }
    });

    // One click to a pre-filled report. Deliberately in the top bar rather than
    // behind a menu: a bug that is hard to report is a bug that goes unreported.
    const bugBtn = $('#btn-bug');
    if (bugBtn) bugBtn.addEventListener('click', function (ev) {
      // #btn-bug is an anchor with a working static href, so reporting survives a
      // bundle that fails to run. When the app is alive, take over and open the
      // richer report instead of letting the anchor fire as well.
      if (ev && ev.preventDefault) ev.preventDefault();
      openBugReport();
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
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && deleteTarget()) {
      // Backspace is also "navigate back" in some browsers; a deletion here is
      // deliberate, so stop the default.
      e.preventDefault();
      if (deleteTarget() === 'link') deleteLink(selectedLink);
      else deleteDevice(selectedId);
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
  //
  // This used to open a socket once, with no onclose, no onerror and no retry. When the
  // server went away the tab kept drawing its own copy of the board forever, showing
  // devices the server had never heard of, and nothing on screen said so (issue #24).
  // A client that cannot tell it is stale is worse than one that fails loudly.
  let ws = null;
  let wsRetryMs = 500;
  let wsTimer = null;

  function setConnected(state) {
    const el = document.getElementById('conn-state');
    if (el) {
      el.textContent = state === 'connected' ? 'connected'
        : (state === 'connecting' ? 'reconnecting' : 'disconnected');
      el.className = 'conn-badge conn-' + (state === 'connected' ? 'ok' : 'bad');
      el.title = state === 'connected'
        ? 'Live: the board on screen is the copy the server holds'
        : 'Not receiving updates from the server';
    }
    if (state === 'disconnected') setStatus('Disconnected from the server - reconnecting...');
  }

  // Re-fetch the server's copy and re-render. Called after a reconnect, because the
  // only safe assumption is that the tab's copy is stale.
  async function syncTopology(reason) {
    const beforeDevices = (topo && topo.devices) ? topo.devices.length : 0;
    const beforeLinks = (topo && topo.links) ? topo.links.length : 0;
    const t = await api('GET', '/topologies/' + TOPO);
    topo = t;
    PFCanvas.setTopology(topo);
    if (selectedId && !deviceById(selectedId)) { selectedId = null; PFCanvas.setSelected(null); }
    if (selectedLink && !(topo.links || []).some(function (l) { return l.id === selectedLink; })) {
      selectedLink = null;
    }
    renderDeviceTab();
    renderSimulateTab();
    setStatus('Ready - ' + topo.devices.length + ' device(s), ' + topo.links.length + ' link(s)');

    // A transition the user must not have to work out for themselves: work disappeared.
    if (reason === 'reconnect' && topo.devices.length < beforeDevices) {
      const lost = beforeDevices - topo.devices.length;
      toast('The server came back with ' + lost + ' fewer device(s) - the board you were ' +
        'looking at was not saved');
    }
    if (reason === 'reconnect' && topo.devices.length === 0 && beforeLinks > 0) {
      toast('The server has an empty board now - your devices were not persisted');
    }
    return topo;
  }

  function scheduleReconnect() {
    if (wsTimer) return;
    const wait = wsRetryMs;
    wsRetryMs = Math.min(Math.round(wsRetryMs * 1.7), 10000);
    wsTimer = setTimeout(function () { wsTimer = null; connectWS(); }, wait);
  }

  function connectWS() {
    if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let socket;
    try { socket = new WebSocket(proto + '://' + location.host + '/'); }
    catch (e) { setConnected('disconnected'); scheduleReconnect(); return; }
    ws = socket;
    setConnected('connecting');

    socket.onopen = function () {
      wsRetryMs = 500;
      setConnected('connected');
      // Converge on the server rather than keeping a private copy.
      syncTopology('reconnect').catch(function (e) {
        console.error('resync failed', e);
        setStatus('Connected, but the board could not be reloaded: ' + e.message);
      });
    };

    socket.onmessage = function (ev) {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'topology') {
          // A socket frame without a state is not a board: adopting it would
          // blank the canvas exactly the way issue #38 did.
          topo = m.state || topo;
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

    socket.onclose = function () {
      setConnected('disconnected');
      scheduleReconnect();
    };

    socket.onerror = function () {
      // onclose follows an error in every browser worth supporting; closing here makes
      // sure a socket that errors without closing still reaches the retry path.
      try { socket.close(); } catch (e) { setConnected('disconnected'); scheduleReconnect(); }
    };
  }

  // ---------- boot ----------
  // Start listening before anything else can fail, or the first error - the interesting one -
  // is the one nobody catches.
  function installErrorCapture() {
    const w = (typeof window !== 'undefined' && window) ? window : null;
    if (!w || typeof w.addEventListener !== 'function') return false;
    w.addEventListener('error', function (event) {
      const t = event && event.target;
      if (t && t !== w && (t.tagName === 'IMG' || t.tagName === 'SCRIPT' || t.tagName === 'LINK')) {
        // A resource that failed to load is a real bug - the asset is missing - but it has no
        // message or stack, so record what was being fetched.
        recordError('resource', 'failed to load ' + String(t.tagName).toLowerCase(),
          { where: t.src || t.href || '' });
        return;
      }
      const err = event && event.error;
      recordError('error', (event && event.message) || (err && err.message) || 'unknown error', {
        where: [event && event.filename, event && event.lineno, event && event.colno]
          .filter(function (x) { return x !== undefined && x !== null && x !== ''; }).join(':'),
        detail: (err && err.stack) || ''
      });
    });
    w.addEventListener('unhandledrejection', function (event) {
      const r = event && event.reason;
      recordError('unhandled rejection', (r && r.message) || r || 'unknown rejection',
        { detail: (r && r.stack) || '' });
    });
    return true;
  }

  async function boot() {
    installErrorCapture();
    bindTopbar();
    // Static content: draw it before the first API call so a slow or failed
    // /api/catalog does not leave the canvas colours unexplained.
    renderCableLegend();
    bindLegend();
    switchTab('device');
    try {
      const cat = await api('GET', '/catalog');
      catalog = cat;
      renderPalette();
      // Enrichment, not a dependency: if this never arrives the palette is unchanged.
      api('GET', '/requests').then(function (r) {
        openRequests = (r && r.requests) || [];
        if (openRequests.length) renderPalette();
      }).catch(function () { openRequests = []; });
      bindPaletteKeyboard();
      await syncTopology('boot');
      PFCanvas.fitView();
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
    maskBits: maskBits,
    lengthChoicesFor: lengthChoicesFor,
    connectWS: connectWS,
    syncTopology: syncTopology,
    setConnected: setConnected,
    getTopology: function () { return topo; },
    connectionState: function () {
      const el = document.getElementById('conn-state');
      return el ? el.textContent : null;
    },
    // Create-link mode, exposed for the UI tests (issue #68): the two device clicks are the
    // whole feature, and a test cannot click a stub DOM.
    linkMode: { arm: armLinkMode, select: linkModeSelect, state: linkMode },
    selectDevice: function (id) { selectedId = id; selectedLink = null; },
    selectLink: function (id) { selectedLink = id; selectedId = null; },
    deleteTarget: deleteTarget,
    deleteLink: deleteLink,
    cordOfferFor: cordOfferFor,
    renderDeviceTab: renderDeviceTab,
    interfacesHeader: interfacesHeader,
    routesRows: routesRows,
    renderLinkInspector: renderLinkInspector,
    ifaceRowHTML: ifaceRowHTML,
    poeSummary: poeSummary,
    fmtSpeed: fmtSpeed,
    cageLabel: cageLabel,
    vlanSummary: vlanSummary,
    switchportSentence: switchportSentence,
    filterDevices: filterDevices,
    searchKey: searchKey,
    fabricSummary: fabricSummary,
    // The palette render is exposed so a test can assert what it builds: the whole point
    // of the collapse change is how many cards exist in the DOM, and that is not visible
    // through filterDevices.
    renderPalette: renderPalette,
    setCatalog: function (cat) { catalog = cat; },
    // The report builder is pure, so a test can assert what a report contains
    // without opening a window.
    bugReportBody: bugReportBody,
    describeTopology: describeTopology,
    specKeys: specKeys,
    bugReportUrl: bugReportUrl,
    recordError: recordError,
    describeErrors: describeErrors,
    installErrorCapture: installErrorCapture,
    recentErrors: recentErrors,
    openBugReport: openBugReport,
    issueUrl: ISSUE_NEW,
    renderCableLegend: renderCableLegend,
    describeEmptyState: describeEmptyState,
    clearPaletteFilter: clearPaletteFilter,
    // Keyboard navigation of the palette: the wrap arithmetic is pure, and the rest is
    // reachable so a test can drive the handler the way a keyboard would.
    matchingRequests: matchingRequests,
    renderRequestedSection: renderRequestedSection,
    setOpenRequests: function (list) { openRequests = list || []; },
    openRequests: function () { return openRequests; },
    nextPaletteIndex: nextPaletteIndex,
    bindPaletteKeyboard: bindPaletteKeyboard,
    setPaletteActive: setPaletteActive,
    paletteActiveIndex: function () { return paletteActiveIndex; },
    bindLegend: bindLegend,
    setLegendCollapsed: setLegendCollapsed,
    legendCollapsed: legendCollapsed,
    cableLegendHTML: cableLegendHTML,
    cableFamilies: CABLE_FAMILIES,
    partsForMedia: partsForMedia,
    partsHTML: partsHTML,
    reachLabel: reachLabel,
    standardKey: standardKey,
    opticParts: OPTIC_PARTS,
    portVerdict: portVerdict
  };
})();
