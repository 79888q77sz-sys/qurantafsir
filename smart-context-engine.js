/* ═══════════════════════════════════════════════════════════════
 * SmartContext v2 — contextual scoring engine for the Smart Slider
 * ═══════════════════════════════════════════════════════════════
 *
 * Fully automated, zero-user-input model. Nothing here waits for the
 * user to declare a mood or situation — the slider decides from time,
 * calendar, weather, and a discovery rotation.
 *
 * Standalone module. smart-dhikr.js opts in via three hooks:
 *
 *   1. SCORING   — SmartContext.score(item, snapshot(), state)
 *   2. DISCOVERY — SmartContext.noteShown(id) after card-1 is chosen,
 *                  so the rotation decays what was just surfaced
 *   3. SCHEDULER — SmartContext.onBoundary(redrawFn) replaces polling:
 *                  ONE setTimeout armed to the next moment the context
 *                  can actually change (prayer edge, last-third start,
 *                  Baghdad midnight, signal expiry), re-armed on
 *                  visibilitychange/resume (Android freezes WebView
 *                  timers in background).
 *
 * Scoring model (additive layers over a time-scaled base):
 *
 *   score = base × timeFit                 // L1: 0 outside window, ramps
 *                                          //     0.55 → 1.15 → 0.55 across it
 *         + base × (calendarBoost − 1)     // L2: Friday/hijri bonuses
 *         + base × (signalBoost − 1)       // L3: automated env. signals
 *         + smartRandomBonus × DISCOVERY_W // L4: idle-time discovery
 *         − fatigue                        // completed −60 / opened −15
 *
 * L4 — SMART RANDOMIZATION & IDLE-TIME DISCOVERY:
 * discovery:true items (timeless/situational duas — distress, gratitude,
 * protection, house enter/exit, illness, dressing…) are ALWAYS eligible
 * (optionally narrowed by discoveryPhases). Their bonus is a per-item
 * hash of (hour slot, app session) scaled by a shown-decay factor, so:
 *   • every app open / hour surfaces a fresh situational card,
 *   • the same card never repeats back-to-back (heavy decay for ~1 h
 *     after being shown, linear recovery over ~6 h),
 *   • within one session/hour the pick is STABLE (no mid-view shuffle).
 * Discovery bases (~30) + max bonus (20) stay BELOW mid-window scores of
 * real time items (morning plateau ≈ 57), so morning/evening/after-prayer
 * always win their windows and discovery owns the idle gaps between them.
 *
 * SIGNALS are machine-raised only: weather signals derive automatically
 * from the majority-vote cache; requiresSignal remains supported solely
 * for future automated native triggers (geofence house enter/exit,
 * activity recognition). No UI ever asks the user how they feel.
 *
 * Item schema — superset of TIME_ITEMS in smart-dhikr.js. New fields:
 *   phase:           'morning'|'ishraq'|'midday'|'evening'|'night'|'lateNight'
 *   discovery:       true  — joins the idle-time rotation (L4)
 *   discoveryPhases: ['lateNight']  — narrows WHEN it may surface
 *   signals:         ['rain']      — env. signal multiplies score
 *   requiresSignal:  'geo_house_exit' — hidden until a NATIVE trigger fires
 *   calendarTags:    ['friday','ramadan'] — L2 bonuses
 *
 * categoryKey maps 1:1 to gencine_adhkar `category_key` exactly as today.
 */
(function(window) {
  'use strict';

  /* ─────────────────────────────────────────────
     CONTEXT SNAPSHOT
     One cheap object per decision — every scorer reads from it, nothing
     re-reads localStorage or Date mid-ranking.
  ───────────────────────────────────────────── */

  /* Injected providers — smart-dhikr.js passes its own battle-tested
     helpers at wire time so hijri/weather logic lives in ONE place.
     Defaults keep the module functional standalone (prayers + weather
     read the same caches; hijri degrades to null = L2 hijri off). */
  var _providers = {
    getPrayers: function() {
      try {
        var city   = localStorage.getItem('prayerCity') || 'Duhok';
        var today  = new Date();
        var mk = 'prayer-kurd2:' + city + ':' + today.getFullYear() + ':' + (today.getMonth() + 1);
        var monthly = JSON.parse(localStorage.getItem(mk));
        if (monthly && monthly.days && monthly.days[String(today.getDate())]) {
          return monthly.days[String(today.getDate())];
        }
      } catch (e) {}
      return null;
    },
    getHijri: function() { return null; },
    getDhulHijjahDay: function() { return -1; },
    getWeather: function() {
      /* read-only peek at smart-dhikr's majority-vote cache — this module
         never fetches; weather ownership stays in smart-dhikr.js */
      try {
        var c = JSON.parse(localStorage.getItem('sd_rain_v5'));
        if (c && (Date.now() - c.ts) < 45 * 60 * 1000) return c.cond || null;
      } catch (e) {}
      return null;
    }
  };

  function configure(overrides) {
    for (var k in overrides) {
      if (overrides.hasOwnProperty(k) && typeof overrides[k] === 'function') {
        _providers[k] = overrides[k];
      }
    }
  }

  function _toMin(t) {
    if (!t) return -1;
    var p = String(t).trim().split(' ')[0].split(':');
    return p.length < 2 ? -1 : parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }

  /* Prayer-anchored fallbacks (minutes) when no prayer cache exists yet —
     same convention as the fs/fe fallbacks in smart-dhikr.js. */
  var _FALLBACK = { Fajr: 5 * 60, Sunrise: 6 * 60 + 30, Dhuhr: 12 * 60 + 10,
                    Asr: 15 * 60 + 30, Maghrib: 19 * 60, Isha: 20 * 60 + 30 };

  /* snapshot(atMs?) — context at a given instant. No arg = now (all existing
     callers unchanged). A future atMs powers the widget timeline: phases,
     hour slots and calendar all shift; prayers/signals use today's caches
     (≤2 min/day drift, corrected on every re-push). */
  function snapshot(atMs) {
    var now     = atMs ? new Date(atMs) : new Date();
    var prayers = _providers.getPrayers();
    var min     = function(name) {
      var m = prayers ? _toMin(prayers[name]) : -1;
      return m >= 0 ? m : _FALLBACK[name];
    };
    var ctx = {
      now:        now,
      atMs:       atMs || Date.now(),
      nowMin:     now.getHours() * 60 + now.getMinutes(),
      dow:        now.getDay(),               /* 0=Sun … 4=Thu, 5=Fri */
      prayers:    prayers,
      fajrMin:    min('Fajr'),
      sunriseMin: min('Sunrise'),
      dhuhrMin:   min('Dhuhr'),
      asrMin:     min('Asr'),
      maghribMin: min('Maghrib'),
      ishaMin:    min('Isha'),
      hijri:      _providers.getHijri(),      /* {month, day} or null */
      dhulHijjahDay: _providers.getDhulHijjahDay(),
      weather:    _providers.getWeather(),    /* 'rain'|'snow'|'thunder'|'wind'|'clear'|null */
      signals:    _activeSignals()
    };
    ctx.phase = _resolvePhase(ctx);
    return ctx;
  }

  /* ─────────────────────────────────────────────
     LAYER 1 — DAY PHASES  (prayer-anchored, not clock hours)

     lateNight = last third of the night: night runs Maghrib → next Fajr;
     tahajjud tradition anchors to the final third, so
       lastThirdStart = fajr − (fajr + 1440 − maghrib) / 3   (mod 1440)
  ───────────────────────────────────────────── */
  function lastThirdStart(ctx) {
    var nightLen = (ctx.fajrMin + 1440 - ctx.maghribMin) % 1440;
    return ((ctx.fajrMin - Math.round(nightLen / 3)) + 1440) % 1440;
  }

  var PHASES = {
    morning:   function(c) { return { s: c.fajrMin,           e: c.dhuhrMin }; },
    ishraq:    function(c) { return { s: c.sunriseMin - 30,   e: c.sunriseMin + 30 }; },
    midday:    function(c) { return { s: c.dhuhrMin,          e: c.asrMin }; },
    evening:   function(c) { return { s: c.asrMin,            e: c.maghribMin }; },
    night:     function(c) { return { s: c.ishaMin,           e: lastThirdStart(c) }; },
    lateNight: function(c) { return { s: lastThirdStart(c),   e: c.fajrMin }; }
  };

  function _resolvePhase(ctx) {
    var order = ['ishraq', 'lateNight', 'night', 'morning', 'midday', 'evening'];
    for (var i = 0; i < order.length; i++) {
      var w = PHASES[order[i]](ctx);
      if (_inWin(ctx.nowMin, w)) return order[i];
    }
    return 'midday';
  }

  /* Wrap is INFERRED from s > e, never from a flag — a flagged window whose
     resolved times don't cross midnight (e.g. lateNight 01:40→05:00) must
     not degenerate into "always active". */
  function _inWin(cur, w) {
    if (w.s < 0 || w.e < 0) return false;
    return w.s > w.e ? (cur >= w.s || cur < w.e) : (cur >= w.s && cur < w.e);
  }

  /* Window for an item: phase name, or the timeWindow schema smart-dhikr
     already uses ({start:'Fajr', end:'Dhuhr', fs, fe}). */
  function _itemWindow(item, ctx) {
    if (item.phase && PHASES[item.phase]) return PHASES[item.phase](ctx);
    if (item.timeWindow) {
      var tw = item.timeWindow;
      var s = ctx.prayers && _toMin(ctx.prayers[tw.start]) >= 0 ? _toMin(ctx.prayers[tw.start]) : tw.fs;
      var e = ctx.prayers && _toMin(ctx.prayers[tw.end])   >= 0 ? _toMin(ctx.prayers[tw.end])   : tw.fe;
      return { s: s, e: e }; /* wrap inferred from s > e */
    }
    return null; /* always-eligible (discovery pool, signal-only items) */
  }

  /* timeFit — dynamic scaling across the window. Trapezoid: ramps in over
     the first 15 %, holds a 1.15 peak through the middle, ramps out over
     the last 25 %. Morning azkar therefore outrank generics right after
     Fajr, soften near Dhuhr, and hand over smoothly (often to a discovery
     card) instead of flipping at a hard boundary. */
  function timeFit(item, ctx) {
    var w = _itemWindow(item, ctx);
    if (!w) return 1;                              /* no window: neutral */
    if (!_inWin(ctx.nowMin, w)) return 0;          /* outside: ineligible */
    var len = w.s > w.e ? (w.e + 1440 - w.s) % 1440 : w.e - w.s;
    if (len <= 0) return 1;
    var pos = ((ctx.nowMin - w.s) + 1440) % 1440 / len;   /* 0..1 through window */
    var f;
    if      (pos < 0.15) f = 0.55 + (pos / 0.15) * 0.60;         /* ramp in  */
    else if (pos > 0.75) f = 0.55 + ((1 - pos) / 0.25) * 0.60;   /* ramp out */
    else                 f = 1.15;                               /* plateau  */
    return f;
  }

  /* ─────────────────────────────────────────────
     LAYER 2 — CALENDAR MULTIPLIERS
     Declarative tags instead of per-item boolean funcs; hijriCond items
     from smart-dhikr keep working (checked here too for compatibility).
  ───────────────────────────────────────────── */
  var CALENDAR_BOOSTS = {
    friday:        function(c) { return c.dow === 5 ? 1.5 : 1; },
    thursdayNight: function(c) { return (c.dow === 4 && c.nowMin >= c.maghribMin) ? 1.4 : 1; },
    ramadan:       function(c) { return (c.hijri && c.hijri.month === 9) ? 1.6 : 1; },
    dhulHijjah10:  function(c) { var d = c.dhulHijjahDay; return (d >= 1 && d <= 10) ? 1.5 : 1; },
    whiteDays:     function(c) {
      return (c.hijri && c.hijri.day >= 13 && c.hijri.day <= 15) ? 1.25 : 1;
    }
  };

  function calendarBoost(item, ctx) {
    var m = 1;
    var tags = item.calendarTags || [];
    for (var i = 0; i < tags.length; i++) {
      var fn = CALENDAR_BOOSTS[tags[i]];
      if (fn) m *= fn(ctx);
    }
    /* compat: smart-dhikr's imperative hijriCond gates eligibility */
    if (typeof item.hijriCond === 'function') {
      if (!item.hijriCond(ctx.hijri || {}, ctx.nowMin, ctx.fajrMin, ctx.maghribMin)) return 0;
      m *= 1.5; /* an active seasonal condition is a strong contextual match */
    }
    return m;
  }

  /* ─────────────────────────────────────────────
     LAYER 3 — AUTOMATED ENVIRONMENTAL SIGNALS
     Machine-raised only — the user is never asked anything:
       • weather signals ('rain'/'thunder'/'wind'/'snow') derive
         automatically from the majority-vote weather cache
       • future native triggers (geofence house enter/exit, activity
         recognition) call SmartContext.signal(name, {ttlMin}) from
         plugin code — same pipeline, still zero user input
     Signals persist in localStorage with a TTL and decay linearly to 0,
     so a boost fades instead of vanishing.
  ───────────────────────────────────────────── */
  var _SIG_KEY = 'sc_signals_v1';

  function _readSignals() {
    try { return JSON.parse(localStorage.getItem(_SIG_KEY)) || {}; }
    catch (e) { return {}; }
  }

  function signal(name, opts) {
    opts = opts || {};
    var all = _readSignals();
    var ttl = (opts.ttlMin || 120) * 60 * 1000;
    all[name] = { strength: opts.strength || 1, setAt: Date.now(),
                  expiresAt: Date.now() + ttl, data: opts.data || null };
    try { localStorage.setItem(_SIG_KEY, JSON.stringify(all)); } catch (e) {}
    _rearm(); /* a new signal may create a nearer boundary (its expiry) */
    _fireBoundary('signal:' + name);
  }

  function clearSignal(name) {
    var all = _readSignals();
    if (all[name]) {
      delete all[name];
      try { localStorage.setItem(_SIG_KEY, JSON.stringify(all)); } catch (e) {}
      _fireBoundary('signal-cleared:' + name);
    }
  }

  /* Active signals with freshness ∈ (0..1] — linear decay across the TTL. */
  function _activeSignals() {
    var all = _readSignals(), out = {}, now = Date.now(), dirty = false;
    for (var name in all) {
      if (!all.hasOwnProperty(name)) continue;
      var s = all[name];
      if (now >= s.expiresAt) { delete all[name]; dirty = true; continue; }
      out[name] = { strength: s.strength,
                    freshness: (s.expiresAt - now) / (s.expiresAt - s.setAt),
                    data: s.data };
    }
    if (dirty) { try { localStorage.setItem(_SIG_KEY, JSON.stringify(all)); } catch (e) {} }
    /* derived signals — free, computed from existing caches */
    var w = _providers.getWeather();
    if (w && w !== 'clear' && !out[w]) out[w] = { strength: 1, freshness: 1, derived: true };
    return out;
  }

  function signalBoost(item, ctx) {
    /* requiresSignal: hard gate — reserved for AUTOMATED native triggers
       (e.g. a geofence plugin raising 'geo_house_exit'). No current item
       uses it; general duas surface via discovery instead. */
    if (item.requiresSignal) {
      var req = ctx.signals[item.requiresSignal];
      if (!req) return 0;
      return 1 + 1.5 * req.strength * req.freshness; /* strong when fresh */
    }
    var subs = item.signals || [];
    var boost = 0;
    for (var i = 0; i < subs.length; i++) {
      var s = ctx.signals[subs[i]];
      if (s) boost += 0.8 * s.strength * s.freshness;
    }
    return 1 + boost;
  }

  /* ─────────────────────────────────────────────
     LAYER 4 — SMART RANDOMIZATION & IDLE-TIME DISCOVERY
     Proactive rotation through timeless/situational categories when no
     high-priority window dominates. Fully deterministic within an
     (hour-slot, app-session) pair — stable while the user looks at it,
     fresh on the next open/hour.
  ───────────────────────────────────────────── */
  var _DISCOVERY_WEIGHT = 20;      /* max additive bonus — keeps discovery
                                      peaks (~30+20=50) below mid-window
                                      time items (morning ≈ 57) */
  var _SHOWN_KEY = 'sc_shown_v1';
  /* per-page-load salt: reopening the app reshuffles the rotation even
     within the same hour slot */
  var _sessionSeed = ((Date.now() & 0xffff) ^ ((Math.random() * 0x10000) | 0)) >>> 0;

  function _hourSlot(atMs) { return Math.floor((atMs || Date.now()) / 3600000); }

  /* FNV-1a-style string hash mixed with two salts → [0, 1) */
  function _hash01(str, a, b) {
    var h = (2166136261 ^ a) >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    h = ((h ^ b) * 2246822519) >>> 0;
    return (h >>> 8) / 16777216;
  }

  function _readShown() {
    try { return JSON.parse(localStorage.getItem(_SHOWN_KEY)) || {}; }
    catch (e) { return {}; }
  }

  /* Record that card-1 surfaced this item — smart-dhikr calls this after
     picking the winner. Stored per hour slot; entries purge after 24 h. */
  function noteShown(id) {
    try {
      var m = _readShown(), slot = _hourSlot();
      if (m[id] === slot) return;
      m[id] = slot;
      for (var k in m) {
        if (m.hasOwnProperty(k) && slot - m[k] > 24) delete m[k];
      }
      localStorage.setItem(_SHOWN_KEY, JSON.stringify(m));
    } catch (e) {}
  }

  /* Controlled decay: full weight in the slot it was shown (stability —
     no mid-view shuffle), collapses to 0.15 the next hour (no sequential
     repeats), recovers linearly to full over ~6 h. */
  function _shownDecay(id, atMs) {
    var m = _readShown();
    if (!(id in m)) return 1;
    var ago = _hourSlot(atMs) - m[id];
    if (ago <= 0) return 1;
    return Math.min(1, 0.15 + (ago - 1) * 0.17);
  }

  function smartRandomBonus(item, ctx) {
    if (!item.discovery) return 0;
    var atMs = ctx && ctx.atMs;
    return _hash01(item.id, _hourSlot(atMs) >>> 0, _sessionSeed) * _shownDecay(item.id, atMs);
  }

  /* ─────────────────────────────────────────────
     SCORE + RANK
     score = base×timeFit + base×(calendar−1) + base×(signal−1)
           + smartRandomBonus×DISCOVERY_WEIGHT − fatigue
  ───────────────────────────────────────────── */
  function score(item, ctx, state) {
    var base = item.basePriority || 50;
    /* discoveryPhases narrows WHEN a discovery item may surface
       (e.g. nightmare dua only during night/lateNight) */
    if (item.discoveryPhases && item.discoveryPhases.indexOf(ctx.phase) < 0) {
      return { score: 0, eligible: false };
    }
    var tf = timeFit(item, ctx);
    if (tf <= 0) return { score: 0, eligible: false };
    var cal = calendarBoost(item, ctx);
    if (cal <= 0) return { score: 0, eligible: false };
    var sig = signalBoost(item, ctx);
    if (sig <= 0) return { score: 0, eligible: false };
    var rnd  = smartRandomBonus(item, ctx);
    var disc = rnd * _DISCOVERY_WEIGHT;
    var s = base * tf + base * (cal - 1) + base * (sig - 1) + disc;
    var fatigue = 0;
    if (state) {
      if (state.completed && state.completed.indexOf(item.id) >= 0) fatigue = 60;
      else if (state.opened && state.opened.indexOf(item.id) >= 0)  fatigue = 15;
    }
    return { score: s - fatigue, eligible: true,
             why: { base: base, timeFit: tf, calendar: cal, signal: sig,
                    discovery: disc, fatigue: fatigue } };
  }

  /* rank(items, ctx, state) → [{item, score, why}] best-first.
     Pass isDataAvailable to keep smart-dhikr's _catHasData gate. */
  function rank(items, ctx, state, isDataAvailable) {
    ctx = ctx || snapshot();
    var out = [];
    for (var i = 0; i < items.length; i++) {
      if (isDataAvailable && !isDataAvailable(items[i].categoryKey)) continue;
      var r = score(items[i], ctx, state);
      if (r.eligible && r.score > 0) out.push({ item: items[i], score: r.score, why: r.why });
    }
    out.sort(function(a, b) { return b.score - a.score; });
    return out;
  }

  /* console.table view of a ranking — debugging aid, call from devtools */
  function explain(items, isDataAvailable) {
    var ctx = snapshot();
    var rows = rank(items, ctx, null, isDataAvailable).map(function(r) {
      return { id: r.item.id, score: Math.round(r.score * 10) / 10,
               base: r.why.base, timeFit: r.why.timeFit.toFixed(2),
               calendar: r.why.calendar.toFixed(2), signal: r.why.signal.toFixed(2),
               discovery: r.why.discovery.toFixed(1) };
    });
    console.log('[SmartContext] phase=' + ctx.phase
      + ' signals=' + (Object.keys(ctx.signals).join(',') || 'none'));
    if (console.table) console.table(rows); else console.log(rows);
    return rows;
  }

  /* ─────────────────────────────────────────────
     BOUNDARY SCHEDULER — the battery answer.
     No polling. Compute the next instant the context CAN change and arm
     exactly one setTimeout for it:
       • next prayer-time crossing (phase edges are all prayer-derived)
       • next hour slot (discovery rotation)
       • last-third-of-night start
       • Baghdad midnight (daily seeds + hijri day roll)
       • earliest signal expiry
     Android freezes WebView timers in background, so the timeout may fire
     late or never while hidden — visibilitychange + Capacitor resume
     re-arm and fire a catch-up check, which is exactly when a redraw
     matters anyway (the user is looking again).
  ───────────────────────────────────────────── */
  var _boundaryCbs = [];
  var _boundaryTid = null;

  /* Delta (ms) from atMs to the next instant the context can change.
     Parametrized so the widget timeline can walk boundary→boundary. */
  function _nextBoundaryDeltaMs(atMs) {
    var base = atMs || Date.now();
    var ctx  = snapshot(base);
    var cand = [ctx.fajrMin, ctx.sunriseMin - 30, ctx.sunriseMin + 30, ctx.dhuhrMin,
                ctx.asrMin, ctx.maghribMin, ctx.maghribMin + 45, ctx.ishaMin,
                lastThirdStart(ctx)];
    var best = Infinity;
    for (var i = 0; i < cand.length; i++) {
      var d = (cand[i] - ctx.nowMin + 1440) % 1440;   /* minutes until edge */
      if (d > 0 && d * 60000 < best) best = d * 60000;
    }
    /* next hour slot — discovery rotation tick */
    var toSlot = 3600000 - (base % 3600000);
    if (toSlot < best) best = toSlot;
    /* Baghdad midnight (UTC+3 fixed) — daily cards + hijri roll */
    var bg = new Date(base + 3 * 3600000);
    var toMidnight = 86400000
      - (bg.getUTCHours() * 3600000 + bg.getUTCMinutes() * 60000 + bg.getUTCSeconds() * 1000);
    if (toMidnight < best) best = toMidnight;
    /* earliest signal expiry — boost fade-out should trigger a re-rank */
    var sigs = _readSignals();
    for (var name in sigs) {
      if (!sigs.hasOwnProperty(name)) continue;
      var left = sigs[name].expiresAt - base;
      if (left > 0 && left < best) best = left;
    }
    /* +2 s slack past the edge; clamp: never sooner than 30 s (storm
       protection), never later than 6 h (drift safety net) */
    return Math.min(Math.max(best + 2000, 30000), 6 * 3600000);
  }

  function _nextBoundaryMs() { return _nextBoundaryDeltaMs(Date.now()); }

  function _fireBoundary(reason) {
    for (var i = 0; i < _boundaryCbs.length; i++) {
      try { _boundaryCbs[i](reason); } catch (e) {}
    }
  }

  function _rearm() {
    if (_boundaryTid) clearTimeout(_boundaryTid);
    if (!_boundaryCbs.length) { _boundaryTid = null; return; }
    _boundaryTid = setTimeout(function() {
      _fireBoundary('boundary');
      _rearm();
    }, _nextBoundaryMs());
  }

  /* onBoundary(cb) — cb(reason) runs whenever the contextual answer may
     have changed. smart-dhikr registers its cache-bust + redraw here. */
  function onBoundary(cb) {
    _boundaryCbs.push(cb);
    _rearm();
  }

  document.addEventListener('visibilitychange', function() {
    if (!document.hidden && _boundaryCbs.length) {
      _rearm();
      _fireBoundary('visible'); /* catch-up: timers were frozen in background */
    }
  });
  if (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.App
      && Capacitor.Plugins.App.addListener) {
    Capacitor.Plugins.App.addListener('resume', function() {
      if (_boundaryCbs.length) { _rearm(); _fireBoundary('resume'); }
    });
  }

  /* ─────────────────────────────────────────────
     CONTEXT ITEMS — cards unlocked by this engine. Same schema as
     TIME_ITEMS; every categoryKey verified against live gencine_adhkar
     rows. fallbackAr keeps each card functional offline.

     tahajjud is TIME-anchored (last third). Everything else is the
     DISCOVERY pool: always eligible (optionally phase-narrowed), rotated
     by the L4 randomizer during idle windows — never user-triggered.
  ───────────────────────────────────────────── */
  var CONTEXT_ITEMS = [
    { /* last third of the night — qiyam/tahajjud. No dedicated gencine
         category yet; 'forgiveness' (pre-dawn istighfar) is the natural
         content for this window — flip the key if a tahajjud category
         is created in admin-gencine later. */
      id: 'tahajjud', categoryKey: 'forgiveness', icon: 'fas fa-star-and-crescent',
      labelKey: 'adhkar.tahajjud', labelFallback: 'نڤێژا شەڤێ',
      subtitleKey: 'gencine.smart.tahajjud_hint', subtitleFallback: 'سێیا دویماهیێ یا شەڤێ',
      fallbackAr: 'لَا إِلَهَ إِلَّا أَنْتَ سُبْحَانَكَ إِنِّي كُنْتُ مِنَ الظَّالِمِينَ',
      fallbackRepeat: 1, fallbackSource: 'الترمذي',
      timeTag: 'نڤێژا شەڤێ', basePriority: 66, phase: 'lateNight'
    },

    /* ── discovery pool — timeless/situational, fully automated ── */
    { /* comfort in distress — دلتەنگی */
      id: 'sadness', categoryKey: 'distress', icon: 'fas fa-hand-holding-heart',
      labelKey: 'adhkar.distress', labelFallback: 'دلتەنگی',
      subtitleKey: 'gencine.smart.distress_hint', subtitleFallback: 'دوعا لە کاتی زەحمەت',
      fallbackAr: 'اللَّهُمَّ إِنِّي عَبْدُكَ ابْنُ عَبْدِكَ نَاصِيَتِي بِيَدِكَ',
      fallbackRepeat: 1, fallbackSource: 'أحمد',
      timeTag: 'دەمێ دلتەنگیێ', basePriority: 32, discovery: true
    },
    { /* gratitude — سوپاسگوزاری */
      id: 'disc_gratitude', categoryKey: 'gratitude', icon: 'fas fa-star',
      labelKey: 'adhkar.gratitude', labelFallback: 'حەمد و سەنا',
      subtitleKey: 'gencine.smart.gratitude_hint', subtitleFallback: 'سوپاسا خواێ بکە',
      fallbackAr: 'الْحَمْدُ لِلَّهِ الَّذِي بِنِعْمَتِهِ تَتِمُّ الصَّالِحَاتُ',
      fallbackRepeat: 3, fallbackSource: 'ابن ماجه',
      timeTag: 'سوپاسگوزاری', basePriority: 32, discovery: true
    },
    { /* protection — پاراستن */
      id: 'disc_protection', categoryKey: 'protection', icon: 'fas fa-shield-halved',
      labelKey: 'adhkar.protection', labelFallback: 'پاراستنا موسلمانی',
      subtitleKey: 'gencine.smart.protection_hint', subtitleFallback: 'زکرێن پاراستن و حەمایەتێ',
      fallbackAr: 'بِسْمِ اللَّهِ الَّذِي لَا يَضُرُّ مَعَ اسْمِهِ شَيْءٌ فِي الْأَرْضِ وَلَا فِي السَّمَاءِ',
      fallbackRepeat: 3, fallbackSource: 'أبو داود والترمذي',
      timeTag: 'پاراستن', basePriority: 32, discovery: true
    },
    { /* healing — نەخۆشی */
      id: 'illness', categoryKey: 'illness', icon: 'fas fa-heart-pulse',
      labelKey: 'adhkar.illness', labelFallback: 'نەخۆشی',
      subtitleKey: 'gencine.smart.illness_hint', subtitleFallback: 'دوعایا شیفایێ',
      fallbackAr: 'اللَّهُمَّ رَبَّ النَّاسِ أَذْهِبِ الْبَأْسَ اشْفِ أَنْتَ الشَّافِي',
      fallbackRepeat: 3, fallbackSource: 'البخاري ومسلم',
      timeTag: 'دوعایا شیفایێ', basePriority: 30, discovery: true
    },
    { /* leaving the house — mornings/midday, when people actually leave */
      id: 'leaving_home', categoryKey: 'house_exit', icon: 'fas fa-door-open',
      labelKey: 'adhkar.leaving_home', labelFallback: 'دەرکەفتن ژ مالێ',
      subtitleKey: 'gencine.smart.leaving_home_hint', subtitleFallback: 'دوعایا دەرکەفتنێ',
      fallbackAr: 'بِسْمِ اللَّهِ تَوَكَّلْتُ عَلَى اللَّهِ وَلَا حَوْلَ وَلَا قُوَّةَ إِلَّا بِاللَّهِ',
      fallbackRepeat: 1, fallbackSource: 'أبو داود والترمذي',
      timeTag: 'دەرکەفتن ژ مالێ', basePriority: 33, discovery: true,
      discoveryPhases: ['morning', 'midday']
    },
    { /* returning home — evenings/nights */
      id: 'entering_home', categoryKey: 'house_enter', icon: 'fas fa-house-user',
      labelKey: 'adhkar.entering_home', labelFallback: 'ڤەگەڕیان بۆ مالێ',
      subtitleKey: 'gencine.smart.entering_home_hint', subtitleFallback: 'دوعایا کەتنا مالێ',
      fallbackAr: 'بِسْمِ اللَّهِ وَلَجْنَا وَبِسْمِ اللَّهِ خَرَجْنَا وَعَلَى اللَّهِ رَبِّنَا تَوَكَّلْنَا',
      fallbackRepeat: 1, fallbackSource: 'أبو داود',
      timeTag: 'کەتنا مالێ', basePriority: 33, discovery: true,
      discoveryPhases: ['evening', 'night']
    },
    { /* wearing clothes — mornings */
      id: 'dressing', categoryKey: 'dressing', icon: 'fas fa-shirt',
      labelKey: 'adhkar.dressing', labelFallback: 'لخۆکرنا جلکان',
      subtitleKey: 'gencine.smart.dressing_hint', subtitleFallback: 'دوعایا جلکێن نوی',
      fallbackAr: 'الْحَمْدُ لِلَّهِ الَّذِي كَسَانِي هَذَا وَرَزَقَنِيهِ مِنْ غَيْرِ حَوْلٍ مِنِّي وَلَا قُوَّةٍ',
      fallbackRepeat: 1, fallbackSource: 'أبو داود',
      timeTag: 'جلک لخۆکرن', basePriority: 30, discovery: true,
      discoveryPhases: ['morning']
    },
    { /* protection after a bad dream — surfaces only in the night
         rotation; no user report needed, no trigger, just relevance */
      id: 'bad_dream', categoryKey: 'nightmare', icon: 'fas fa-cloud-moon',
      labelKey: 'adhkar.bad_dream', labelFallback: 'خەوا خراب',
      subtitleKey: 'gencine.smart.bad_dream_hint', subtitleFallback: 'دوعایا پشتی خەوا خراب',
      fallbackAr: 'أَعُوذُ بِكَلِمَاتِ اللَّهِ التَّامَّاتِ مِنْ شَرِّ مَا خَلَقَ',
      fallbackRepeat: 3, fallbackSource: 'مسلم',
      timeTag: 'خەوا خراب', basePriority: 32, discovery: true,
      discoveryPhases: ['night', 'lateNight']
    }
  ];

  window.SmartContext = {
    /* wiring */
    configure:    configure,
    /* context */
    snapshot:     snapshot,
    PHASES:       PHASES,
    /* scoring */
    score:        score,
    rank:         rank,
    explain:      explain,
    /* L4 discovery */
    noteShown:    noteShown,
    /* L3 automated signal pipeline (weather-derived + future native) */
    signal:       signal,
    clearSignal:  clearSignal,
    /* battery-safe scheduling */
    onBoundary:   onBoundary,
    /* widget timeline support — delta ms from a given instant to the next
       context-change boundary (prayer edge / hour slot / midnight / signal) */
    nextBoundaryDeltaMs: _nextBoundaryDeltaMs,
    /* items to merge into the slider's card-1 pool */
    CONTEXT_ITEMS: CONTEXT_ITEMS
  };

}(window));
