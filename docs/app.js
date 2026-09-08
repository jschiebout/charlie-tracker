/* ==========================================================================
   Charlie Tracker — PWA
   --------------------------------------------------------------------------
   Talks to a Google Apps Script web app. Two constraints shape the transport:

     • Apps Script cannot set response headers and does not answer OPTIONS,
       so nothing may trigger a CORS preflight. GETs are simple by nature;
       writes go out as text/plain, which keeps them "simple requests".
     • GitHub Pages on a free plan serves from a PUBLIC repo, so no secret
       may live in this file. Credentials arrive once in an invite link's
       hash, are stored on the device, and the hash is stripped immediately.
   ========================================================================== */
'use strict';

(function () {

// ==========================================================================
// Store — localStorage with an in-memory fallback
// ==========================================================================

/**
 * Every write goes to memory first and to localStorage as a bonus, and every
 * read falls back to memory. That ordering matters: Safari can revoke storage
 * access part-way through a session, and a queued tap that reads back as
 * missing would look exactly like lost data. Once a throw is seen we stop
 * trusting localStorage for the rest of the session rather than throwing on
 * every subsequent call.
 */
var Store = (function () {
  var durable = probe();
  var mem = {};

  function probe() {
    try {
      localStorage.setItem('__probe__', '1');
      localStorage.removeItem('__probe__');
      return true;
    } catch (e) { return false; }
  }

  function readRaw(k) {
    if (durable) {
      try {
        var v = localStorage.getItem(k);
        if (v != null) return v;
      } catch (e) {
        durable = false;
      }
    }
    return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null;
  }

  return {
    isDurable: function () { return durable; },
    get: function (k, dflt) {
      var raw = readRaw(k);
      if (raw == null) return dflt;
      try { return JSON.parse(raw); } catch (e) { return dflt; }
    },
    set: function (k, v) {
      var raw = JSON.stringify(v);
      mem[k] = raw;                       // memory is the source of truth
      if (!durable) return;
      try { localStorage.setItem(k, raw); } catch (e) { durable = false; }
    },
    del: function (k) {
      delete mem[k];
      if (!durable) return;
      try { localStorage.removeItem(k); } catch (e) { durable = false; }
    }
  };
})();

// ==========================================================================
// Config — credentials from the invite link
// ==========================================================================

var Config = (function () {
  var KEY = 'charlie.config.v1';
  var cfg = Store.get(KEY, null);

  /** Accepts "#api=...&k=...&who=..." from a full URL or a bare hash. */
  function parseLink(str) {
    if (!str) return null;
    var hash = String(str);
    var i = hash.indexOf('#');
    if (i > -1) hash = hash.slice(i + 1);
    if (!hash) return null;

    var p = {};
    hash.split('&').forEach(function (pair) {
      var eq = pair.indexOf('=');
      if (eq < 1) return;
      try {
        p[decodeURIComponent(pair.slice(0, eq))] =
          decodeURIComponent(pair.slice(eq + 1));
      } catch (e) {}
    });

    if (!p.api || !p.k || !p.who) return null;
    if (!/^https:\/\/script\.google\.com\//.test(p.api)) return null;
    return { api: p.api, key: p.k, who: p.who };
  }

  return {
    parseLink: parseLink,
    get: function () { return cfg; },
    ready: function () { return !!(cfg && cfg.api && cfg.key && cfg.who); },
    adopt: function (parsed) {
      cfg = parsed;
      Store.set(KEY, cfg);
      return cfg;
    },
    setWho: function (who) {
      if (!cfg) return;
      cfg.who = who;
      Store.set(KEY, cfg);
    },
    /** Reads the invite hash if present, saves it, and scrubs the URL. */
    consumeHash: function () {
      var parsed = parseLink(location.hash);
      if (!parsed) return false;
      this.adopt(parsed);
      history.replaceState(null, '',
        location.pathname + location.search);
      return true;
    }
  };
})();

// ==========================================================================
// Api — every call is a "simple request"
// ==========================================================================

var Api = {
  get: function (name, params) {
    var cfg = Config.get();
    var qs = ['api=' + encodeURIComponent(name),
              'k=' + encodeURIComponent(cfg.key)];
    Object.keys(params || {}).forEach(function (k) {
      qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    });
    return fetch(cfg.api + '?' + qs.join('&'), {
      method: 'GET', redirect: 'follow', cache: 'no-store'
    }).then(readJson);
  },

  post: function (payload) {
    var cfg = Config.get();
    payload.k = cfg.key;
    // text/plain keeps this a simple request — Apps Script cannot answer the
    // OPTIONS preflight that application/json would provoke.
    return fetch(cfg.api, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow'
    }).then(readJson);
  }
};

function readJson(res) {
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text().then(function (txt) {
    var data;
    try {
      data = JSON.parse(txt);
    } catch (e) {
      throw new Error('The tracker replied with something unexpected. ' +
                      'Check that the web app is deployed to "Anyone with the link".');
    }
    if (data && data.ok === false) throw new Error(data.error || 'request failed');
    return data;
  });
}

// ==========================================================================
// Queue — offline-first writes
// ==========================================================================

var Queue = (function () {
  var KEY = 'charlie.queue.v1';
  var flushing = false;

  function all()      { return Store.get(KEY, []); }
  function save(list) { Store.set(KEY, list); }

  return {
    all: all,
    size: function () { return all().length; },
    add: function (item) { var q = all(); q.push(item); save(q); },
    drop: function (ids) {
      save(all().filter(function (it) { return ids.indexOf(it.clientId) === -1; }));
    },
    has: function (id) {
      return all().some(function (it) { return it.clientId === id; });
    },
    busy: function () { return flushing; },

    /** Sends everything pending. Anything not confirmed stays queued. */
    flush: function () {
      var items = all();
      if (flushing || !items.length || !navigator.onLine) {
        return Promise.resolve(null);
      }
      flushing = true;
      return Api.post({ items: items })
        .then(function (res) {
          Queue.drop(res.accepted || []);
          return res;
        })
        .catch(function (err) {
          console.warn('flush failed, will retry', err);
          return null;
        })
        .then(function (res) { flushing = false; return res; });
    }
  };
})();

// ==========================================================================
// Small helpers
// ==========================================================================

function $(id) { return document.getElementById(id); }
function el(tag, cls, txt) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
}
function uid() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
  });
}
function round(n, dp) { var f = Math.pow(10, dp); return Math.round(n * f) / f; }
function pad2(n) { return n < 10 ? '0' + n : String(n); }
function buzz(ms) { if (navigator.vibrate) navigator.vibrate(ms || 12); }

function fmtClock(d) {
  var h = d.getHours(), m = d.getMinutes();
  var ap = h < 12 ? 'AM' : 'PM';
  h = h % 12 === 0 ? 12 : h % 12;
  return h + ':' + pad2(m) + ' ' + ap;
}
function humanAgo(mins) {
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  var h = Math.floor(mins / 60), m = mins % 60;
  if (h < 24) return h + 'h' + (m ? ' ' + m + 'm' : '') + ' ago';
  return Math.floor(h / 24) + 'd ago';
}

var EVENT_ICON = {
  feed: '🍼', diaper: '💧', sleep: '😴', pump: '🥛',
  note: '📝', weight: '⚖️', milestone: '⭐'
};

function describe(it) {
  if (it.event === 'feed') {
    var side = (it.detail || '').indexOf('nursing') === 0;
    var label = side ? 'Nursing' + (it.detail.split('_')[1]
                  ? ' (' + it.detail.split('_')[1] + ')' : '') : 'Bottle';
    var extra = [];
    if (it.oz) extra.push(it.oz + ' oz');
    if (it.minutes) extra.push(it.minutes + ' min');
    return label + (extra.length ? ' · ' + extra.join(', ') : '');
  }
  if (it.event === 'diaper') {
    return { wet: 'Wet diaper', dirty: 'Dirty diaper',
             both: 'Wet + dirty diaper' }[it.detail] || 'Diaper';
  }
  if (it.event === 'sleep') return it.detail === 'start' ? 'Fell asleep' : 'Woke up';
  if (it.event === 'pump')  return 'Pumped' + (it.oz ? ' · ' + it.oz + ' oz' : '');
  if (it.event === 'note')  return it.notes || 'Note';
  return it.event;
}

function iconFor(entry) {
  if (entry.event === 'diaper') {
    return entry.detail === 'dirty' ? '💩' : (entry.detail === 'both' ? '🌊' : '💧');
  }
  if (entry.event === 'sleep') return entry.detail === 'end' ? '☀️' : '😴';
  return EVENT_ICON[entry.event] || '•';
}

// ==========================================================================
// UI — toast and modal
// ==========================================================================

var UI = (function () {
  var timer = null;

  function toast(msg, kind, undoFn) {
    var t = $('toast');
    t.className = 'toast on' + (kind ? ' ' + kind : '');
    t.innerHTML = '';
    t.appendChild(el('span', null, msg));
    if (undoFn) {
      var b = el('button', 'undo', 'Undo');
      b.onclick = function () { hide(); undoFn(); };
      t.appendChild(b);
    }
    clearTimeout(timer);
    timer = setTimeout(hide, 5000);
  }
  function hide() { $('toast').className = 'toast'; }

  function sheet(html, wire) {
    $('sheetBox').innerHTML = html;
    $('veil').hidden = false;
    if (wire) wire($('sheetBox'));
  }
  function close() { $('veil').hidden = true; }

  return { toast: toast, hideToast: hide, sheet: sheet, close: close };
})();

// ==========================================================================
// TimeWheel — hour / minute / meridiem, snapped
// ==========================================================================

var TimeWheel = (function () {
  var ITEM = 36;                 // must match .wheelCol .opt height in app.css
  var cols = {};
  var dayOffset = 0;             // 0 = today, 1 = yesterday
  var trackingNow = true;
  var tickTimer = null;
  var onChange = function () {};

  function build(colEl, values) {
    colEl.innerHTML = '';
    values.forEach(function (v) {
      colEl.appendChild(el('div', 'opt', v));
    });
    return { node: colEl, values: values, index: 0 };
  }

  function setIndex(col, i, smooth) {
    i = Math.max(0, Math.min(col.values.length - 1, i));
    col.index = i;
    col.node.scrollTo({ top: i * ITEM, behavior: smooth ? 'smooth' : 'auto' });
    mark(col);
  }

  function mark(col) {
    var kids = col.node.children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].classList.toggle('sel', i === col.index);
    }
  }

  function watch(col) {
    var t = null;
    col.node.addEventListener('scroll', function () {
      clearTimeout(t);
      t = setTimeout(function () {
        var i = Math.round(col.node.scrollTop / ITEM);
        if (i !== col.index) {
          stopTracking();
          col.index = Math.max(0, Math.min(col.values.length - 1, i));
          mark(col);
          buzz(6);
        }
        onChange();
      }, 90);
    }, { passive: true });
  }

  function startTracking() {
    trackingNow = true;
    $('nowBtn').classList.add('active');
    clearTimeout(tickTimer);
    tick();
  }
  function stopTracking() {
    if (!trackingNow) return;
    trackingNow = false;
    $('nowBtn').classList.remove('active');
    clearTimeout(tickTimer);
    onChange();
  }
  function tick() {
    if (!trackingNow) return;
    syncToNow(false);
    tickTimer = setTimeout(tick, 20000);
  }

  function syncToNow(smooth) {
    var d = new Date();
    var h = d.getHours();
    setIndex(cols.hour, (h % 12 === 0 ? 12 : h % 12) - 1, smooth);
    setIndex(cols.min, d.getMinutes(), smooth);
    setIndex(cols.mer, h < 12 ? 0 : 1, smooth);
    setDay(0);
    onChange();
  }

  function setDay(off) {
    dayOffset = off;
    Array.prototype.forEach.call($('daySeg').children, function (b) {
      b.classList.toggle('on', Number(b.dataset.day) === off);
    });
  }

  /** The moment currently shown on the wheel. */
  function value() {
    if (trackingNow) return new Date();
    var h12 = cols.hour.index + 1;
    var mins = cols.min.index;
    var pm = cols.mer.index === 1;
    var h24 = (h12 % 12) + (pm ? 12 : 0);

    var d = new Date();
    d.setDate(d.getDate() - dayOffset);
    d.setHours(h24, mins, 0, 0);
    return d;
  }

  function init(changed) {
    onChange = changed || function () {};

    var hours = [], mins = [];
    for (var h = 1; h <= 12; h++) hours.push(String(h));
    for (var m = 0; m < 60; m++) mins.push(pad2(m));

    cols.hour = build($('colHour'), hours);
    cols.min  = build($('colMin'), mins);
    cols.mer  = build($('colMer'), ['AM', 'PM']);
    Object.keys(cols).forEach(function (k) { watch(cols[k]); });

    $('nowBtn').addEventListener('click', function () {
      startTracking();
      syncToNow(true);
      buzz();
    });

    $('daySeg').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      stopTracking();
      setDay(Number(b.dataset.day));
      onChange();
    });

    startTracking();
    syncToNow(false);
  }

  return {
    init: init,
    value: value,
    isNow: function () { return trackingNow; },
    reset: function () { startTracking(); syncToNow(true); }
  };
})();

// ==========================================================================
// App state
// ==========================================================================

var state = {
  status: null,
  entries: null,
  series: null,
  view: 'log',
  histFilter: 'all',
  histDays: 7,
  chartDays: 7,
  lastSent: null,
  caregivers: ['Jessen', 'Laura', 'Annette', 'Mary Ann'],
  babyName: 'Charlie'
};

// ==========================================================================
// Logging
// ==========================================================================

function logEvent(event, detail, extra) {
  extra = extra || {};
  // Resolve the timestamp on the device: a queued entry must land at the
  // moment it was tapped, not whenever the phone regains signal.
  var when = TimeWheel.value();

  if (when.getTime() > Date.now() + 60000) {
    UI.toast('That time is in the future — check AM/PM', 'err');
    return;
  }

  var item = {
    clientId: uid(),
    event: event,
    detail: detail || '',
    caregiver: Config.get().who,
    oz: extra.oz == null ? '' : extra.oz,
    minutes: extra.minutes == null ? '' : extra.minutes,
    notes: extra.notes || '',
    at: when.toISOString(),
    source: 'phone'
  };

  UI.close();
  buzz();
  Queue.add(item);
  state.lastSent = item;
  optimistic(item);
  renderSync();

  if (!navigator.onLine) {
    UI.toast(Store.isDurable() ? 'Saved on this phone — waiting to sync' : 'Not synced — keep this app open', 'queued', undoLast);
    return;
  }

  UI.toast('Saving: ' + describe(item), 'queued');
  Queue.flush().then(function (res) {
    if (res && (res.accepted || []).indexOf(item.clientId) !== -1) {
      UI.toast('Synced: ' + describe(item), null, undoLast);
    } else if (Queue.has(item.clientId)) {
      UI.toast('Not synced yet — keep the app open or tap Retry', 'queued');
    }
    if (res && res.status) { state.status = res.status; renderStatus(); }
    renderSync();
    invalidateDerived();
  });
  TimeWheel.reset();
}

function undoLast() {
  if (Queue.busy()) {
    UI.toast('Still syncing — remove the entry from History after it finishes', 'queued');
    return;
  }
  var item = state.lastSent;
  if (!item) return;
  state.lastSent = null;

  if (Queue.has(item.clientId)) {
    Queue.drop([item.clientId]);
    renderSync();
    UI.toast('Removed');
    return;
  }

  // Address it by client id: the stored timestamp is reformatted into the
  // sheet's timezone and will not match the UTC string we sent.
  Api.post({ deleteEntry: { clientId: item.clientId } })
    .then(function () { UI.toast('Removed'); refresh(true); })
    .catch(function () {
      UI.toast('Could not undo — remove it from History', 'err');
    });
}

/** Nudges the visible counters so the app responds instantly and stays
    truthful while offline. Overwritten by the next successful refresh. */
function optimistic(item) {
  var s = state.status;
  if (!s) return;
  if (item.event === 'feed') {
    s.today.feeds++;
    if (item.oz) s.today.totalOz = round(s.today.totalOz + Number(item.oz), 1);
    s.lastFeed = { mins: 0, text: 'just now', by: item.caregiver, at: 'now' };
  } else if (item.event === 'diaper') {
    if (item.detail === 'wet'   || item.detail === 'both') s.today.wets++;
    if (item.detail === 'dirty' || item.detail === 'both') s.today.dirties++;
  } else if (item.event === 'sleep') {
    s.asleep = item.detail === 'start';
    if (s.asleep) s.nextSleep = null;
  }
  renderStatus();
}

function invalidateDerived() {
  state.entries = null;
  state.series = null;
  if (state.view === 'history') loadHistory();
  if (state.view === 'charts')  loadCharts();
}

// ==========================================================================
// Rendering — status
// ==========================================================================

function renderStatus() {
  var s = state.status;
  var box = $('status');
  if (!s) { box.innerHTML = '<div class="skel"></div>'; return; }

  box.classList.toggle('stale', !navigator.onLine);
  $('ageText').textContent = s.ageText || '';

  var h = '<div class="statusTop">' +
    '<span class="statNote">' + (s.asleep ? 'Sleeping' : 'Awake') + '</span>' +
    '<span class="statePill ' + (s.asleep ? 'asleep' : 'awake') + '">' +
      (s.asleep ? 'Asleep' : 'Awake') + '</span></div>';

  h += '<div class="tiles">' +
    tile(s.today.feeds + (s.today.totalOz ? '' : ''), 'Feeds 24h') +
    tile(s.today.wets + '/' + s.today.dirties, 'Wet / Dirty') +
    tile(s.today.sleepHrs + 'h', 'Sleep 24h') + '</div>';

  var lines = [];
  if (s.lastFeed) {
    lines.push('Last feed: <b>' + esc(s.lastFeed.text) + '</b> (' +
               esc(s.lastFeed.at) + ', ' + esc(s.lastFeed.by) + ')');
  }
  if (s.today.totalOz) lines.push('Volume today: <b>' + s.today.totalOz + ' oz</b>');
  if (s.lastSleep) {
    lines.push((s.asleep ? 'Asleep since: <b>' : 'Awake since: <b>') +
               esc(s.lastSleep.at) + '</b>');
  }
  if (s.lastDirty) lines.push('Last dirty: <b>' + esc(s.lastDirty.text) + '</b>');
  if (lines.length) h += '<div class="lastline">' + lines.join('<br>') + '</div>';

  if (s.lastFeed && s.lastFeed.mins >= s.feedIntervalHours * 60) {
    h += '<div class="nudge due">Feed is due — last one was ' +
         esc(s.lastFeed.text) + '.</div>';
  } else if (s.nextSleep) {
    var n = s.nextSleep;
    if (n.lowIn <= 0 && n.highIn >= -15) {
      h += '<div class="nudge">Sleep window is open now (awake ' + n.awakeMins +
           ' min). Good time to start wind-down.</div>';
    } else if (n.lowIn > 0) {
      h += '<div class="nudge">Next sleep in roughly <b>' + n.lowIn + '–' +
           Math.max(n.highIn, n.lowIn) + ' min</b> · window ' + esc(n.window) +
           '</div>';
    }
  }
  box.innerHTML = h;
}

function tile(n, label) {
  return '<div class="tile"><span class="n">' + esc(n) + '</span>' +
         '<span class="l">' + esc(label) + '</span></div>';
}

function renderSync() {
  var box = $('sync');
  var n = Queue.size();
  var offline = !navigator.onLine;

  if (!n && !offline) { box.hidden = true; return; }
  box.hidden = false;

  if (offline) {
    box.className = 'sync offline';
    box.innerHTML = '<span class="dot"></span><span>No connection' +
      (n ? ' — ' + n + ' waiting to send' : '') + '</span>' +
      (Store.isDurable() ? '' :
        '<span style="margin-left:auto;font-size:11px">keep this app open</span>');
  } else {
    box.className = 'sync pending';
    box.innerHTML = '<span class="dot"></span><span>' + n +
      ' waiting to send' + (Queue.busy() ? ' — sending…' : '') + '</span>';
    if (!Queue.busy()) {
      var b = el('button', 'retry', 'Retry');
      b.onclick = function () {
        Queue.flush().then(function () { renderSync(); refresh(true); });
      };
      box.appendChild(b);
    }
  }
}

function renderTimeEcho() {
  var d = TimeWheel.value();
  var echo = $('timeEcho');
  if (TimeWheel.isNow()) {
    echo.className = 'timeEcho';
    echo.innerHTML = 'Logging as <b>now</b> · ' + esc(fmtClock(d));
    return;
  }
  var mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < -1) {
    echo.className = 'timeEcho warn';
    echo.innerHTML = '<b>' + esc(fmtClock(d)) + '</b> is in the future — check AM/PM';
  } else {
    echo.className = 'timeEcho';
    echo.innerHTML = '<b>' + esc(fmtClock(d)) + '</b> · ' +
                     esc(humanAgo(Math.max(0, mins)));
  }
}

// ==========================================================================
// Rendering — history
// ==========================================================================

var FILTERS = {
  all:    function () { return true; },
  feed:   function (e) { return e.event === 'feed'; },
  diaper: function (e) { return e.event === 'diaper'; },
  sleep:  function (e) { return e.event === 'sleep'; },
  other:  function (e) { return ['feed','diaper','sleep'].indexOf(e.event) === -1; }
};

function loadHistory() {
  if (state.entries) { renderHistory(); return; }
  $('histList').innerHTML = '<div class="skel tall"></div>';
  Api.get('history', { days: state.histDays })
    .then(function (res) { state.entries = res.entries; renderHistory(); })
    .catch(function (err) {
      $('histList').innerHTML =
        '<div class="emptyState">Could not load history.<br>' +
        esc(err.message) + '</div>';
    });
}

function renderHistory() {
  var list = $('histList');
  var entries = (state.entries || []).filter(FILTERS[state.histFilter]);

  if (!entries.length) {
    list.innerHTML = '<div class="emptyState">Nothing logged in this range yet.</div>';
    return;
  }

  var groups = {};
  var order = [];
  entries.forEach(function (e) {
    if (!groups[e.date]) { groups[e.date] = []; order.push(e.date); }
    groups[e.date].push(e);
  });

  list.innerHTML = '';
  order.forEach(function (date) {
    var rows = groups[date];
    var g = el('div', 'dayGroup');

    var head = el('div', 'dayHead');
    head.appendChild(el('h3', null, dayLabel(date)));
    head.appendChild(el('span', null, summarize(rows)));
    g.appendChild(head);

    var box = el('div', 'entries');
    rows.forEach(function (e) {
      var b = el('button', 'entry');
      b.appendChild(el('span', 'eIco', iconFor(e)));

      var body = el('div', 'eBody');
      body.appendChild(el('div', 'eMain', describe(e)));
      var meta = e.caregiver + (e.source === 'snoo' ? ' · Snoo'
                : e.source === 'alexa' ? ' · Alexa' : '');
      if (e.event === 'note' && e.notes) { /* note text is already the main line */ }
      body.appendChild(el('div', 'eMeta', meta));
      b.appendChild(body);

      b.appendChild(el('span', 'eTime', e.time));
      b.onclick = function () { entrySheet(e); };
      box.appendChild(b);
    });
    g.appendChild(box);
    list.appendChild(g);
  });
}

function dayLabel(dateStr) {
  var today = new Date();
  var d = new Date(dateStr + 'T12:00:00');
  var diff = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate())
              - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined,
    { weekday: 'long', month: 'short', day: 'numeric' });
}

function summarize(rows) {
  var feeds = 0, oz = 0, wet = 0, dirty = 0;
  rows.forEach(function (e) {
    if (e.event === 'feed') { feeds++; if (e.oz) oz += e.oz; }
    if (e.event === 'diaper') {
      if (e.detail === 'wet' || e.detail === 'both') wet++;
      if (e.detail === 'dirty' || e.detail === 'both') dirty++;
    }
  });
  var bits = [];
  if (feeds) bits.push(feeds + ' feed' + (feeds === 1 ? '' : 's') +
                       (oz ? ' · ' + round(oz, 1) + ' oz' : ''));
  if (wet || dirty) bits.push(wet + 'W / ' + dirty + 'D');
  return bits.join('  ·  ');
}

function entrySheet(e) {
  UI.sheet(
    '<h3>' + esc(describe(e)) + '</h3>' +
    '<p style="margin:0 0 14px;font-size:13px;color:var(--dim);line-height:1.6">' +
      esc(dayLabel(e.date)) + ' at ' + esc(e.time) + '<br>' +
      'Logged by ' + esc(e.caregiver) +
      (e.source && e.source !== 'phone' ? ' via ' + esc(e.source) : '') +
      (e.notes ? '<br>' + esc(e.notes) : '') +
    '</p>' +
    '<div class="chips">' +
      '<button class="chip full danger" data-del="1">Delete this entry</button>' +
    '</div>' +
    '<button class="cancel" data-close="1">Close</button>',
    function (box) {
      box.querySelector('[data-close]').onclick = UI.close;
      box.querySelector('[data-del]').onclick = function () {
        UI.close();
        Api.post({ deleteEntry: e.clientId
                     ? { clientId: e.clientId }
                     : { iso: e.iso, event: e.event, caregiver: e.caregiver } })
          .then(function (res) {
            UI.toast('Deleted');
            if (res.status) { state.status = res.status; renderStatus(); }
            invalidateDerived();
          })
          .catch(function (err) { UI.toast(err.message, 'err'); });
      };
    }
  );
}

// ==========================================================================
// Rendering — charts (hand-drawn SVG so the app works offline)
// ==========================================================================

function loadCharts() {
  if (state.series) { renderCharts(); return; }
  $('chartList').innerHTML = '<div class="skel tall"></div>';
  Api.get('series', { days: state.chartDays })
    .then(function (res) { state.series = res.series; renderCharts(); })
    .catch(function (err) {
      $('chartList').innerHTML =
        '<div class="emptyState">Could not load charts.<br>' +
        esc(err.message) + '</div>';
    });
}

var COLORS = {
  feed: '#4a7dff', oz: '#7fa6ff',
  night: '#7b5cd6', day: '#b39ae8',
  wet: '#c48a2f', dirty: '#8a6420',
  streak: '#3fa96a'
};

function renderCharts() {
  var s = state.series || [];
  var list = $('chartList');

  if (!s.length || s.every(function (d) { return !d.feeds && !d.sleepHrs; })) {
    list.innerHTML = '<div class="emptyState">Not enough logged yet to chart.<br>' +
      'Come back after a day or two of entries.</div>';
    return;
  }

  list.innerHTML = '';

  list.appendChild(chartCard(
    'Feeds per day',
    'Bars are feed count. The line is total volume in ounces, where recorded.',
    comboChart(s, 'feeds', 'oz'),
    [['Feeds', COLORS.feed], ['Ounces', COLORS.oz]],
    [['Avg feeds/day', avg(s, 'feeds', 1)], ['Avg oz/day', avg(s, 'oz', 1)]]
  ));

  list.appendChild(chartCard(
    'Sleep per day',
    'Split by when each stretch began — night counts 7pm to 7am.',
    stackChart(s, ['nightHrs', 'dayHrs'], [COLORS.night, COLORS.day], 'h'),
    [['Night', COLORS.night], ['Day', COLORS.day]],
    [['Avg total', avg(s, 'sleepHrs', 1) + 'h'], ['Avg night', avg(s, 'nightHrs', 1) + 'h']]
  ));

  list.appendChild(chartCard(
    'Longest night stretch',
    'The single longest unbroken sleep that began overnight.',
    lineChart(s, 'longestNightHrs', COLORS.streak, 'h'),
    null,
    [['Best', max(s, 'longestNightHrs') + 'h'],
     ['Avg', avg(s, 'longestNightHrs', 1) + 'h']]
  ));

  list.appendChild(chartCard(
    'Diapers per day',
    'Wet and dirty counted separately; a combined change counts in both.',
    stackChart(s, ['wet', 'dirty'], [COLORS.wet, COLORS.dirty], ''),
    [['Wet', COLORS.wet], ['Dirty', COLORS.dirty]],
    [['Avg wet', avg(s, 'wet', 1)], ['Avg dirty', avg(s, 'dirty', 1)]]
  ));
}

function chartCard(title, sub, svg, legend, stats) {
  var card = el('div', 'chartCard');
  var head = el('div', 'chartHead');
  head.appendChild(el('h3', null, title));
  if (sub) head.appendChild(el('p', null, sub));
  card.appendChild(head);

  var wrap = el('div', 'chartWrap');
  wrap.innerHTML = svg;
  card.appendChild(wrap);

  if (legend) {
    var lg = el('div', 'legend');
    legend.forEach(function (pair) {
      var item = el('span');
      item.innerHTML = '<i style="background:' + pair[1] + '"></i>' + esc(pair[0]);
      lg.appendChild(item);
    });
    card.appendChild(lg);
  }
  if (stats) {
    var st = el('div', 'chartStat');
    stats.forEach(function (pair) {
      var d = el('div');
      d.innerHTML = '<b>' + esc(pair[1]) + '</b>' + esc(pair[0]);
      st.appendChild(d);
    });
    card.appendChild(st);
  }
  return card;
}

function avg(rows, key, dp) {
  if (!rows.length) return 0;
  var sum = rows.reduce(function (a, r) { return a + (Number(r[key]) || 0); }, 0);
  return round(sum / rows.length, dp);
}
function max(rows, key) {
  return rows.reduce(function (a, r) { return Math.max(a, Number(r[key]) || 0); }, 0);
}

/* Geometry shared by every chart. The viewBox leaves room for the axis
   labels on all four sides so nothing is clipped. */
var G = { w: 520, h: 200, padL: 34, padR: 12, padT: 12, padB: 26 };

function plotW() { return G.w - G.padL - G.padR; }
function plotH() { return G.h - G.padT - G.padB; }

function niceMax(v) {
  if (v <= 0) return 1;
  var mag = Math.pow(10, Math.floor(Math.log10(v)));
  var n = v / mag;
  var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

function yAxis(maxV, suffix) {
  var out = '';
  for (var i = 0; i <= 4; i++) {
    var val = (maxV / 4) * i;
    var y = G.padT + plotH() - (i / 4) * plotH();
    out += '<line x1="' + G.padL + '" y1="' + y + '" x2="' + (G.w - G.padR) +
           '" y2="' + y + '" stroke="#2f3343" stroke-width="1"/>' +
           '<text x="' + (G.padL - 6) + '" y="' + (y + 4) +
           '" text-anchor="end" font-size="10" fill="#9aa0b4">' +
           (Math.round(val * 10) / 10) + (suffix || '') + '</text>';
  }
  return out;
}

function xLabels(rows) {
  var n = rows.length;
  var step = n > 20 ? 5 : (n > 10 ? 2 : 1);
  var bw = plotW() / n;
  var out = '';
  rows.forEach(function (r, i) {
    if (i % step !== 0 && i !== n - 1) return;
    var x = G.padL + bw * i + bw / 2;
    out += '<text x="' + x + '" y="' + (G.h - 8) + '" text-anchor="middle" ' +
           'font-size="10" fill="#9aa0b4">' + esc(r.label) + '</text>';
  });
  return out;
}

function svgOpen() {
  return '<svg viewBox="0 0 ' + G.w + ' ' + G.h + '" ' +
         'preserveAspectRatio="xMidYMid meet" role="img">';
}

function stackChart(rows, keys, colors, suffix) {
  var totals = rows.map(function (r) {
    return keys.reduce(function (a, k) { return a + (Number(r[k]) || 0); }, 0);
  });
  var mx = niceMax(Math.max.apply(null, totals.concat([1])));
  var bw = plotW() / rows.length;
  var barW = Math.max(3, bw * 0.62);

  var body = '';
  rows.forEach(function (r, i) {
    var x = G.padL + bw * i + (bw - barW) / 2;
    var yBase = G.padT + plotH();
    keys.forEach(function (k, ki) {
      var v = Number(r[k]) || 0;
      if (v <= 0) return;
      var hgt = (v / mx) * plotH();
      yBase -= hgt;
      body += '<rect x="' + round(x, 1) + '" y="' + round(yBase, 1) +
              '" width="' + round(barW, 1) + '" height="' + round(hgt, 1) +
              '" fill="' + colors[ki] + '" rx="2"/>';
    });
  });

  return svgOpen() + yAxis(mx, suffix) + body + xLabels(rows) + '</svg>';
}

function comboChart(rows, barKey, lineKey) {
  var mxBar = niceMax(Math.max.apply(null,
    rows.map(function (r) { return Number(r[barKey]) || 0; }).concat([1])));
  var mxLine = niceMax(Math.max.apply(null,
    rows.map(function (r) { return Number(r[lineKey]) || 0; }).concat([1])));

  var bw = plotW() / rows.length;
  var barW = Math.max(3, bw * 0.62);
  var body = '';

  rows.forEach(function (r, i) {
    var v = Number(r[barKey]) || 0;
    if (v <= 0) return;
    var hgt = (v / mxBar) * plotH();
    var x = G.padL + bw * i + (bw - barW) / 2;
    body += '<rect x="' + round(x, 1) + '" y="' + round(G.padT + plotH() - hgt, 1) +
            '" width="' + round(barW, 1) + '" height="' + round(hgt, 1) +
            '" fill="' + COLORS.feed + '" rx="2"/>';
  });

  var pts = [];
  rows.forEach(function (r, i) {
    var v = Number(r[lineKey]) || 0;
    var x = G.padL + bw * i + bw / 2;
    var y = G.padT + plotH() - (v / mxLine) * plotH();
    pts.push([x, y, v]);
  });

  var path = pts.map(function (p, i) {
    return (i ? 'L' : 'M') + round(p[0], 1) + ' ' + round(p[1], 1);
  }).join(' ');

  var dots = pts.filter(function (p) { return p[2] > 0; }).map(function (p) {
    return '<circle cx="' + round(p[0], 1) + '" cy="' + round(p[1], 1) +
           '" r="2.6" fill="' + COLORS.oz + '"/>';
  }).join('');

  return svgOpen() + yAxis(mxBar, '') + body +
         '<path d="' + path + '" fill="none" stroke="' + COLORS.oz +
         '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
         dots + xLabels(rows) + '</svg>';
}

function lineChart(rows, key, color, suffix) {
  var mx = niceMax(Math.max.apply(null,
    rows.map(function (r) { return Number(r[key]) || 0; }).concat([1])));
  var bw = plotW() / rows.length;

  var pts = rows.map(function (r, i) {
    var v = Number(r[key]) || 0;
    return [G.padL + bw * i + bw / 2, G.padT + plotH() - (v / mx) * plotH(), v];
  });

  var path = pts.map(function (p, i) {
    return (i ? 'L' : 'M') + round(p[0], 1) + ' ' + round(p[1], 1);
  }).join(' ');

  var area = path + ' L' + round(pts[pts.length - 1][0], 1) + ' ' +
             (G.padT + plotH()) + ' L' + round(pts[0][0], 1) + ' ' +
             (G.padT + plotH()) + ' Z';

  var dots = pts.filter(function (p) { return p[2] > 0; }).map(function (p) {
    return '<circle cx="' + round(p[0], 1) + '" cy="' + round(p[1], 1) +
           '" r="2.6" fill="' + color + '"/>';
  }).join('');

  return svgOpen() + yAxis(mx, suffix) +
    '<path d="' + area + '" fill="' + color + '" fill-opacity="0.16"/>' +
    '<path d="' + path + '" fill="none" stroke="' + color +
    '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
    dots + xLabels(rows) + '</svg>';
}

// ==========================================================================
// Modals for the log view
// ==========================================================================

var SHEETS = {
  bottle: function () {
    var amounts = [1, 1.5, 2, 2.5, 3, 3.5, 4, 5];
    UI.sheet(
      '<h3>Bottle — how much?</h3><div class="chips">' +
      amounts.map(function (a) {
        return '<button class="chip" data-oz="' + a + '">' + a +
               '<small>oz</small></button>';
      }).join('') + '</div>' +
      '<div class="chips">' +
        '<button class="chip wide" data-oz="">Unsure</button>' +
        '<button class="chip wide" data-custom="1">Other…</button>' +
      '</div><button class="cancel" data-close="1">Cancel</button>',
      wireSheet(function (b) {
        if (b.dataset.custom) {
          var v = prompt('Ounces (for example 2.75)');
          if (v && !isNaN(parseFloat(v))) logEvent('feed', 'bottle', { oz: parseFloat(v) });
          else UI.close();
          return;
        }
        logEvent('feed', 'bottle', b.dataset.oz ? { oz: Number(b.dataset.oz) } : {});
      })
    );
  },

  nursing: function () {
    UI.sheet(
      '<h3>Nursing — which side?</h3><div class="chips">' +
      ['left', 'right', 'both'].map(function (s) {
        return '<button class="chip wide" data-side="' + s + '">' +
               s.charAt(0).toUpperCase() + s.slice(1) + '</button>';
      }).join('') +
      '<button class="chip wide" data-skip="1">Skip</button>' +
      '</div><button class="cancel" data-close="1">Cancel</button>',
      wireSheet(function (b) {
        if (b.dataset.skip) { logEvent('feed', 'nursing'); return; }
        nursingMinutes(b.dataset.side);
      })
    );
  },

  pump: function () {
    var amounts = [1, 2, 3, 4, 5, 6, 7, 8];
    UI.sheet(
      '<h3>Pumped — how much total?</h3><div class="chips">' +
      amounts.map(function (a) {
        return '<button class="chip" data-oz="' + a + '">' + a +
               '<small>oz</small></button>';
      }).join('') + '</div>' +
      '<button class="cancel" data-close="1">Cancel</button>',
      wireSheet(function (b) { logEvent('pump', 'total', { oz: Number(b.dataset.oz) }); })
    );
  },

  note: function () {
    UI.sheet(
      '<h3>Quick note</h3>' +
      '<textarea id="noteTxt" rows="3" placeholder="Spit up, fussy, temperature, medication…"></textarea>' +
      '<div class="chips" style="margin-top:11px">' +
        '<button class="chip wide" data-save="1">Save</button>' +
        '<button class="chip wide" data-close="1">Cancel</button>' +
      '</div>',
      function (box) {
        box.querySelector('[data-close]').onclick = UI.close;
        box.querySelector('[data-save]').onclick = function () {
          var t = $('noteTxt');
          if (t && t.value.trim()) logEvent('note', '', { notes: t.value.trim() });
          else UI.close();
        };
        setTimeout(function () { var t = $('noteTxt'); if (t) t.focus(); }, 120);
      }
    );
  }
};

function nursingMinutes(side) {
  var mins = [5, 10, 15, 20, 25, 30, 35, 40];
  UI.sheet(
    '<h3>Nursing (' + esc(side) + ') — how long?</h3><div class="chips">' +
    mins.map(function (m) {
      return '<button class="chip" data-min="' + m + '">' + m +
             '<small>min</small></button>';
    }).join('') + '</div>' +
    '<div class="chips"><button class="chip full" data-min="">Not timed</button></div>' +
    '<button class="cancel" data-close="1">Cancel</button>',
    wireSheet(function (b) {
      logEvent('feed', 'nursing_' + side,
               b.dataset.min ? { minutes: Number(b.dataset.min) } : {});
    })
  );
}

function wireSheet(onPick) {
  return function (box) {
    box.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.close != null) { UI.close(); return; }
      onPick(b);
    });
  };
}

// ==========================================================================
// Views and navigation
// ==========================================================================

function showView(name) {
  state.view = name;
  ['log', 'history', 'charts'].forEach(function (v) {
    $('view-' + v).hidden = (v !== name);
  });
  Array.prototype.forEach.call($('tabs').children, function (b) {
    var on = b.dataset.view === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  window.scrollTo(0, 0);
  if (name === 'history') loadHistory();
  if (name === 'charts')  loadCharts();
}

function whoSheet() {
  UI.sheet(
    '<h3>Who is logging?</h3><div class="chips">' +
    state.caregivers.map(function (c) {
      return '<button class="chip wide" data-who="' + esc(c) + '">' + esc(c) +
             '</button>';
    }).join('') + '</div>' +
    '<p style="margin:2px 0 0;font-size:12px;color:var(--dim);line-height:1.6">' +
    'Entries are tagged with this name so everyone can see who logged what.</p>' +
    '<button class="cancel" data-close="1">Cancel</button>',
    wireSheet(function (b) {
      Config.setWho(b.dataset.who);
      $('whoName').textContent = b.dataset.who;
      UI.close();
      UI.toast('Now logging as ' + b.dataset.who);
    })
  );
}

// ==========================================================================
// Refresh
// ==========================================================================

var refreshing = false;

function refresh(force) {
  if (!Config.ready() || refreshing) return Promise.resolve();
  if (!navigator.onLine) { renderStatus(); renderSync(); return Promise.resolve(); }
  refreshing = true;

  return Api.get('bootstrap')
    .then(function (res) {
      state.status = res.status;
      state.babyName = res.babyName || state.babyName;
      if (res.caregivers && res.caregivers.length) state.caregivers = res.caregivers;
      $('babyName').textContent = state.babyName;
      renderStatus();
      if (force) invalidateDerived();
    })
    .catch(function (err) {
      console.warn('refresh failed', err);
      $('status').classList.add('stale');
    })
    .then(function () { refreshing = false; renderSync(); });
}

// ==========================================================================
// Boot
// ==========================================================================

function showGate(msg) {
  $('gate').hidden = false;
  $('app').hidden = true;
  if (msg) $('gateMsg').textContent = msg;

  $('showManual').onclick = function () {
    $('gateManual').hidden = false;
    $('showManual').hidden = true;
    $('manualLink').focus();
  };
  $('manualGo').onclick = function () {
    var parsed = Config.parseLink($('manualLink').value.trim());
    if (!parsed) {
      $('gateErr').hidden = false;
      $('gateErr').textContent =
        'That does not look like a valid setup link. It should start with ' +
        'https:// and contain a # near the end.';
      return;
    }
    Config.adopt(parsed);
    location.reload();
  };
}

function boot() {
  // Someone already looking at the setup screen who then taps their invite
  // link changes only the hash, which does not reload the page — so boot()
  // would never re-run and nothing would appear to happen.
  window.addEventListener('hashchange', function () {
    if (Config.consumeHash()) location.reload();
  });

  Config.consumeHash();

  if (!Config.ready()) { showGate(); return; }

  $('gate').hidden = true;
  $('app').hidden = false;
  $('whoName').textContent = Config.get().who;

  TimeWheel.init(renderTimeEcho);
  renderTimeEcho();
  renderSync();

  $('view-log').addEventListener('click', function (e) {
    var b = e.target.closest('button.log');
    if (!b) return;
    if (b.dataset.open) { SHEETS[b.dataset.open](); return; }
    logEvent(b.dataset.ev, b.dataset.dt);
  });

  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (b) showView(b.dataset.view);
  });

  $('whoChip').addEventListener('click', whoSheet);

  $('veil').addEventListener('click', function (e) {
    if (e.target === this) UI.close();
  });

  $('histFilters').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    state.histFilter = b.dataset.f;
    Array.prototype.forEach.call(this.children, function (x) {
      x.classList.toggle('on', x === b);
    });
    renderHistory();
  });

  $('histRange').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    state.histDays = Number(b.dataset.d);
    state.entries = null;
    Array.prototype.forEach.call(this.children, function (x) {
      x.classList.toggle('on', x === b);
    });
    loadHistory();
  });

  $('chartRange').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    state.chartDays = Number(b.dataset.d);
    state.series = null;
    Array.prototype.forEach.call(this.children, function (x) {
      x.classList.toggle('on', x === b);
    });
    loadCharts();
  });

  window.addEventListener('online', function () {
    renderSync();
    Queue.flush().then(function () { renderSync(); refresh(true); });
  });
  window.addEventListener('offline', function () { renderSync(); renderStatus(); });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    refresh();
    Queue.flush().then(renderSync);
  });

  refresh();
  Queue.flush().then(renderSync);
  setInterval(function () {
    refresh();
    Queue.flush().then(renderSync);
  }, 60000);
  setInterval(renderTimeEcho, 15000);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function (e) {
      console.warn('service worker registration failed', e);
    });
  }
}

// Expose a small surface for the test harness; harmless in the browser.
window.CharlieTracker = {
  Store: Store, Config: Config, Queue: Queue, Api: Api,
  TimeWheel: TimeWheel, state: state,
  describe: describe, humanAgo: humanAgo, fmtClock: fmtClock, esc: esc,
  niceMax: niceMax, avg: avg, max: max,
  stackChart: stackChart, lineChart: lineChart, comboChart: comboChart,
  dayLabel: dayLabel, summarize: summarize, iconFor: iconFor,
  logEvent: logEvent, boot: boot
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

})();
