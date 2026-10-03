import { createStateOps } from "./stateOps.js";

/**
 * Injected into every tab page. Gives the page `window.scribe`:
 *
 * - state: `scribe.state`, `scribe.update(ops)`, `scribe.set(partial)` (diffed into ops),
 *   `scribe.onChange`, `scribe.bind`. Writes apply locally at once, go to the daemon as ops, and
 *   are rebased onto other writers' deltas, so concurrent edits to different items both survive.
 * - `scribe.local` / `scribe.setLocal`: this viewer's own state (filters, open panels, drafts).
 * - `scribe.signal(name, data)` and `data-scribe-signal`: events agents wait on.
 * - `scribe.action(name, args)`: the page template's actions.
 * - blobs (`scribe.saveAsset` …), links (`scribe.open`, `scribe.resolve`, `data-scribe-open`),
 *   `scribe.preview` for Scribe's file viewer, and `scribe.agent` for chat threads the page starts.
 *
 * Boot data is inlined ahead of this script so `scribe.state` is readable synchronously.
 * The ops engine is the daemon's own (stateOps.ts), embedded by source.
 */
const ENGINE_SRC = createStateOps.toString();

/**
 * An expression that builds the engine in the page. Under tsx (dev mode), esbuild's keepNames
 * wraps functions in `__name(fn, "name")`, a helper the page doesn't have, so give it a no-op one.
 */
export const ENGINE_JS = `(function () {
  var __name = function (fn) { return fn; };
  return (${ENGINE_SRC})();
})()`;

export const BOARD_BRIDGE_JS = `
(function () {
  var boot = window.__SCRIBE_BOOT__ || {};
  try { delete window.__SCRIBE_BOOT__; } catch (err) { window.__SCRIBE_BOOT__ = undefined; }

  var engine = ${ENGINE_JS};

  var IDLE_MS = 250;
  var MAX_WAIT_MS = 1000;

  var tabId = boot.id || "";
  var client = "c_" + Math.random().toString(36).slice(2, 10);
  var writeSeq = 0;

  // base: the daemon's state at revision. current: base plus the writes it hasn't confirmed yet.
  var base = boot.state && typeof boot.state === "object" ? boot.state : {};
  var revision = typeof boot.stateRevision === "number" ? boot.stateRevision : 0;
  var current = engine.clone(base);
  var pending = [];          // ops not sent yet
  var inFlight = null;       // { writeId, ops } sent, not confirmed
  var pendingSince = 0;
  var timer = null;
  var queuedSignals = [];
  var resyncing = false;
  var heldDeltas = [];

  var listeners = [];
  var bindings = [];

  function warn(message, detail) {
    console.warn("[scribe] " + message, detail === undefined ? "" : detail);
  }

  function readEl(el) {
    return el.type === "checkbox" ? el.checked : el.value;
  }

  function writeEl(el, value) {
    if (el.type === "checkbox") {
      el.checked = Boolean(value);
      return;
    }
    el.value = value == null ? "" : String(value);
  }

  function sameEl(el, value) {
    if (el.type === "checkbox") {
      return el.checked === Boolean(value);
    }
    return el.value === (value == null ? "" : String(value));
  }

  function notify() {
    for (var i = 0; i < listeners.length; i += 1) {
      try {
        listeners[i](current);
      } catch (err) {
        console.error("[scribe] onChange handler failed", err);
      }
    }
  }

  function sourceOf(binding) {
    return binding.local ? local : current;
  }

  function applyBindings() {
    for (var i = 0; i < bindings.length; i += 1) {
      var el = bindings[i].el;
      var key = bindings[i].key;
      var source = sourceOf(bindings[i]);
      if (!(key in source) || sameEl(el, source[key])) {
        el.classList.remove("scribe-stale");
        continue;
      }
      if (document.activeElement === el) {
        el.classList.add("scribe-stale");
        continue;
      }
      el.classList.remove("scribe-stale");
      writeEl(el, source[key]);
    }
  }

  /**
   * A field deferred while focused is normally reconciled by its blur handler, but focus
   * events are suppressed while the window is unfocused. Re-checking after any interaction
   * keeps a stale field from being stuck once the caret has moved on.
   */
  function reconcileSoon() {
    setTimeout(applyBindings, 0);
  }

  /** Rebuild current from base and the unconfirmed writes. Ops that no longer apply are dropped. */
  function rebase() {
    var mine = (inFlight ? inFlight.ops : []).concat(pending);
    var result = engine.apply(base, mine, { lenient: true });
    current = result.state;
    if (result.skipped.length) {
      warn("dropped edits that no longer apply after another change", result.skipped);
    }
  }

  function schedule() {
    if (!pendingSince) {
      pendingSince = Date.now();
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(flush, Math.min(IDLE_MS, Math.max(0, pendingSince + MAX_WAIT_MS - Date.now())));
  }

  function post(path, method, body) {
    return fetch("/api/tabs/" + encodeURIComponent(tabId) + path, {
      method: method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          throw new Error((data && data.error) || "request failed (" + res.status + ")");
        }
        return data;
      });
    });
  }

  function nextWrite() {
    writeSeq += 1;
    return client + ":" + writeSeq;
  }

  /** Send pending ops; one write is in flight at a time so they reach the daemon in order. */
  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (inFlight || !tabId) {
      return;
    }
    if (queuedSignals.length) {
      sendSignal();
      return;
    }
    if (!pending.length) {
      return;
    }
    inFlight = { writeId: nextWrite(), ops: pending };
    pending = [];
    pendingSince = 0;
    var sent = inFlight.writeId;
    post("/state", "PUT", { ops: inFlight.ops, lenient: true, client: client, writeId: sent })
      .then(function (data) {
        confirm(sent, data);
      })
      .catch(function (err) {
        console.error("[scribe] save failed", err);
        // Keep the edits: put them back in front of anything typed since, and try again soon.
        if (inFlight && inFlight.writeId === sent) {
          pending = inFlight.ops.concat(pending);
          inFlight = null;
        }
        setTimeout(schedule, 2000);
      });
  }

  function sendSignal() {
    if (inFlight || !tabId || !queuedSignals.length) {
      return;
    }
    var next = queuedSignals.shift();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // The event carries the edits made before it, so an agent woken by it reads them.
    inFlight = { writeId: nextWrite(), ops: pending };
    pending = [];
    pendingSince = 0;
    var sent = inFlight.writeId;
    var body = { name: next.name, client: client, writeId: sent };
    if (next.data !== undefined) {
      body.data = next.data;
    }
    if (inFlight.ops.length) {
      body.ops = inFlight.ops;
    }
    post("/events", "POST", body)
      .then(function (data) {
        confirm(sent, data);
      })
      .catch(function (err) {
        console.error("[scribe] signal failed", err);
        if (inFlight && inFlight.writeId === sent) {
          pending = inFlight.ops.concat(pending);
          inFlight = null;
        }
        afterWrite();
      });
  }

  /** The daemon answered our write. Its delta may already have arrived; otherwise apply it now. */
  function confirm(writeId, data) {
    if (!inFlight || inFlight.writeId !== writeId) {
      afterWrite();
      return;
    }
    if (data && typeof data.stateRevision === "number" && data.stateRevision > revision) {
      if (data.fromRevision === revision && Array.isArray(data.applied)) {
        base = engine.apply(base, data.applied, { lenient: true }).state;
        revision = data.stateRevision;
      } else {
        // Someone else's delta is still on its way; the full state settles it.
        inFlight = null;
        resync();
        afterWrite();
        return;
      }
    }
    var skipped = data && Array.isArray(data.skipped) ? data.skipped : [];
    inFlight = null;
    if (skipped.length) {
      warn("Scribe skipped edits that no longer apply", skipped);
      rebase();
      applyBindings();
      notify();
    }
    afterWrite();
  }

  function afterWrite() {
    if (queuedSignals.length) {
      sendSignal();
    } else if (pending.length) {
      schedule();
    }
  }

  /** Change state with ops (see the scribe skill). Applies at once; throws if an op can't apply. */
  function update(ops) {
    var list = Array.isArray(ops) ? ops : [ops];
    if (!list.length) {
      return;
    }
    current = engine.apply(current, list).state;
    for (var i = 0; i < list.length; i += 1) {
      pending.push(list[i]);
    }
    schedule();
  }

  /** Replace top-level keys. Arrays of items with ids are diffed, so only what changed is sent. */
  function set(partial) {
    if (!partial || typeof partial !== "object") {
      return;
    }
    var next = {};
    var key;
    for (key in current) {
      next[key] = current[key];
    }
    var keys = [];
    for (key in partial) {
      next[key] = partial[key];
      keys.push(key);
    }
    var ops = engine.diff(current, next, keys);
    if (ops.length) {
      update(ops);
    }
  }

  function bind(el, key, options) {
    if (!el || !key) {
      return;
    }
    var binding = { el: el, key: key, local: Boolean(options && options.local) };
    var write = binding.local ? setLocal : set;
    bindings.push(binding);
    var source = sourceOf(binding);
    if (key in source) {
      writeEl(el, source[key]);
    } else if (readEl(el)) {
      write(single(key, readEl(el)));
    }
    function onEdit() {
      write(single(key, readEl(el)));
    }
    el.addEventListener("input", onEdit);
    el.addEventListener("change", onEdit);
    el.addEventListener("blur", function () {
      el.classList.remove("scribe-stale");
      if (!binding.local && pending.length) {
        flush();
        return;
      }
      var now = sourceOf(binding);
      if (key in now && !sameEl(el, now[key])) {
        writeEl(el, now[key]);
      }
    });
  }

  function single(key, value) {
    var one = {};
    one[key] = value;
    return one;
  }

  /** A delta from the daemon (relayed by Scribe). In order: apply. A gap: fetch the whole state. */
  function applyDelta(message) {
    if (resyncing) {
      heldDeltas.push(message);
      return;
    }
    if (typeof message.stateRevision !== "number" || message.stateRevision <= revision) {
      return;
    }
    if (message.fromRevision !== revision || !Array.isArray(message.ops)) {
      resync();
      return;
    }
    base = engine.apply(base, message.ops, { lenient: true }).state;
    revision = message.stateRevision;
    var own = Boolean(inFlight && message.writeId && message.writeId === inFlight.writeId);
    // Our own write comes back as is unless the daemon skipped some of it; only then is there news.
    var news = !own || message.ops.length !== inFlight.ops.length;
    if (own) {
      inFlight = null;
    }
    rebase();
    if (news) {
      applyBindings();
      notify();
    }
    if (own) {
      afterWrite();
    }
  }

  function resync() {
    if (resyncing || !tabId) {
      return;
    }
    resyncing = true;
    fetch("/api/tabs/" + encodeURIComponent(tabId) + "/state")
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        resyncing = false;
        if (data && data.state && typeof data.stateRevision === "number" && data.stateRevision >= revision) {
          base = data.state;
          revision = data.stateRevision;
        }
        var held = heldDeltas;
        heldDeltas = [];
        rebase();
        applyBindings();
        notify();
        for (var i = 0; i < held.length; i += 1) {
          applyDelta(held[i]);
        }
      })
      .catch(function (err) {
        resyncing = false;
        console.error("[scribe] could not reload state", err);
      });
  }

  /* ---------- local state: this viewer's own, never shared ---------- */

  var viewer = typeof boot.viewer === "string" ? boot.viewer : "";
  var local = boot.local && typeof boot.local === "object" ? boot.local : {};
  var localTimer = null;

  function setLocal(partial) {
    if (!partial || typeof partial !== "object") {
      return;
    }
    var next = {};
    var key;
    for (key in local) {
      next[key] = local[key];
    }
    for (key in partial) {
      if (partial[key] === undefined) {
        delete next[key];
      } else {
        next[key] = partial[key];
      }
    }
    local = next;
    if (!viewer || !tabId) {
      return;
    }
    if (localTimer) {
      clearTimeout(localTimer);
    }
    localTimer = setTimeout(saveLocal, IDLE_MS);
  }

  function saveLocal() {
    localTimer = null;
    if (!viewer || !tabId) {
      return;
    }
    post("/local?viewer=" + encodeURIComponent(viewer), "PUT", { state: local }).catch(function (err) {
      console.error("[scribe] could not save local state", err);
    });
  }

  /* ---------- events and actions ---------- */

  function signal(name, data) {
    var next = name == null ? "" : String(name).trim();
    if (!next) {
      console.error("[scribe] signal name is required");
      return;
    }
    queuedSignals.push(data === undefined ? { name: next } : { name: next, data: data });
    if (!inFlight) {
      sendSignal();
    }
  }

  /** Run one of the page template's actions; resolves with its result. State changes arrive as a delta. */
  function action(name, args) {
    flush();
    return post("/action", "POST", { action: String(name || ""), args: args || {} }).then(function (data) {
      return data.result;
    });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) {
      return;
    }
    var data = event.data;
    if (!data || data.type !== "scribe-state" || data.id !== tabId) {
      return;
    }
    applyDelta(data);
  });

  var lastActivityPing = 0;
  function pingActivity() {
    var now = Date.now();
    if (now - lastActivityPing < 400) {
      return;
    }
    lastActivityPing = now;
    try {
      parent.postMessage({ type: "scribe-activity", id: tabId }, "*");
    } catch (err) {}
  }

  document.addEventListener("pointerdown", reconcileSoon, true);
  document.addEventListener("keyup", reconcileSoon, true);
  document.addEventListener("input", pingActivity, true);
  document.addEventListener("change", pingActivity, true);
  document.addEventListener("keydown", pingActivity, true);
  document.addEventListener("pointerdown", pingActivity, true);

  function flushAll() {
    flush();
    if (localTimer) {
      clearTimeout(localTimer);
      saveLocal();
    }
  }

  window.addEventListener("pagehide", flushAll);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      flushAll();
      return;
    }
    applyBindings();
  });

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) {
      return;
    }
    var src = target.closest("[data-scribe-signal]");
    if (!src) {
      return;
    }
    var name = src.getAttribute("data-scribe-signal");
    if (!name) {
      return;
    }
    var tag = (src.tagName || "").toLowerCase();
    var type = (src.getAttribute("type") || (tag === "button" ? "submit" : "")).toLowerCase();
    if (tag === "a" || tag === "button" || type === "submit" || type === "button" || type === "image") {
      event.preventDefault();
    }
    signal(name);
  }, false);

  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form || !form.getAttribute) {
      return;
    }
    var name = form.getAttribute("data-scribe-signal");
    if (!name) {
      return;
    }
    event.preventDefault();
    signal(name);
  }, false);

  /* ---------- page links: scribe.open, data-scribe-open, external hrefs ---------- */

  var LINK_MODES = { tab: true, peek: true, split: true };
  var embedded = window.parent !== window;
  var boardOrigin = location.protocol + "//127.0.0.1" + (location.port ? ":" + location.port : "");
  var linkRequests = {};
  var linkSeq = 0;

  /** Ctrl/Cmd navigates, Shift splits, Alt peeks. Null when no modifier picks a mode. */
  function modeFromEvent(event) {
    if (event.ctrlKey || event.metaKey) {
      return "tab";
    }
    if (event.shiftKey) {
      return "split";
    }
    if (event.altKey) {
      return "peek";
    }
    return null;
  }

  function cleanMode(value) {
    var mode = value == null ? "" : String(value).trim().toLowerCase();
    if (mode === "navigate") {
      mode = "tab";
    }
    return LINK_MODES[mode] ? mode : null;
  }

  /** An http(s) URL outside Scribe, or null. Everything else is a page key or id. */
  function externalUrl(raw) {
    var text = raw == null ? "" : String(raw).trim();
    if (!/^https?:/i.test(text)) {
      return null;
    }
    var url;
    try {
      url = new URL(text);
    } catch (err) {
      return null;
    }
    if (url.origin === location.origin || url.origin === boardOrigin) {
      return null;
    }
    return url.href;
  }

  function hasGesture() {
    var activation = navigator.userActivation;
    return !activation || activation.isActive;
  }

  function openInBrowser(href) {
    window.open(href, "_blank", "noopener,noreferrer");
  }

  function askBoard(message, timeoutMs) {
    return new Promise(function (resolve) {
      if (!embedded) {
        resolve({ ok: false, error: "no_board" });
        return;
      }
      linkSeq += 1;
      var reqId = client + ":" + linkSeq;
      linkRequests[reqId] = resolve;
      message.reqId = reqId;
      message.id = tabId;
      try {
        parent.postMessage(message, "*");
      } catch (err) {
        delete linkRequests[reqId];
        resolve({ ok: false, error: "no_board" });
        return;
      }
      setTimeout(function () {
        if (linkRequests[reqId]) {
          delete linkRequests[reqId];
          resolve({ ok: false, error: "timeout" });
        }
      }, timeoutMs || 5000);
    });
  }

  /**
   * Open a Scribe page (by key or id) or an http(s) URL as a tab, a peek, or a split.
   * Without a mode, a page follows the Settings default and a URL opens in the browser.
   */
  function open(target, options) {
    var opts = options || {};
    var raw = target == null ? "" : String(target).trim();
    if (!raw) {
      return Promise.resolve({ ok: false, error: "not_found" });
    }
    if (!hasGesture()) {
      console.warn("[scribe] scribe.open needs a click or key press; ignored " + raw);
      return Promise.resolve({ ok: false, error: "no_gesture" });
    }
    var mode = cleanMode(opts.mode);
    var anchor = opts.anchor == null ? "" : String(opts.anchor).replace(/^#/, "");
    var hash = raw.indexOf("#");
    var url = externalUrl(raw);
    if (!url && hash > 0) {
      anchor = anchor || raw.slice(hash + 1);
      raw = raw.slice(0, hash);
    }
    if (url && (mode === null || mode === "tab")) {
      openInBrowser(url);
      return Promise.resolve({ ok: true, mode: "browser", url: url });
    }
    if (!embedded) {
      if (url) {
        openInBrowser(url);
        return Promise.resolve({ ok: true, mode: "browser", url: url });
      }
      window.open(boardOrigin + "/#" + encodeURIComponent(raw), "_blank");
      return Promise.resolve({ ok: true, mode: "tab" });
    }
    return askBoard({
      type: "scribe-open",
      target: url || raw,
      mode: mode,
      anchor: anchor || null,
      background: opts.background === true
    });
  }

  /** Look up Scribe pages by key or id: { [target]: { id, title, open } | null }. */
  function resolve(targets) {
    var list = Array.isArray(targets) ? targets : [targets];
    var clean = [];
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i] == null ? "" : String(list[i]).split("#")[0].trim();
      if (item && !externalUrl(item) && clean.indexOf(item) === -1) {
        clean.push(item);
      }
    }
    if (!clean.length) {
      return Promise.resolve({});
    }
    return askBoard({ type: "scribe-resolve", targets: clean }).then(function (reply) {
      return reply && reply.pages ? reply.pages : {};
    });
  }

  function linkFor(target) {
    if (!target || !target.closest) {
      return null;
    }
    var el = target.closest("[data-scribe-open], a[href]");
    if (!el) {
      return null;
    }
    if (el.hasAttribute("data-scribe-open")) {
      return { el: el, target: el.getAttribute("data-scribe-open") || "" };
    }
    if (el.hasAttribute("download")) {
      return null;
    }
    var url = externalUrl(el.href);
    return url ? { el: el, target: url } : null;
  }

  /** The link a click would open here, or null when the browser should handle it. */
  function handledLink(target) {
    var link = linkFor(target);
    if (!link || (!embedded && externalUrl(link.target))) {
      return null;
    }
    return link;
  }

  // Shift+mousedown extends the text selection before the click opens the split. Cancel it on
  // links only, so Shift+click elsewhere still selects text.
  document.addEventListener("mousedown", function (event) {
    if (event.button === 0 && event.shiftKey && handledLink(event.target)) {
      event.preventDefault();
    }
  }, true);

  document.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button !== 0) {
      return;
    }
    var link = handledLink(event.target);
    if (!link) {
      return;
    }
    event.preventDefault();
    var mode = modeFromEvent(event) || cleanMode(link.el.getAttribute("data-scribe-mode"));
    open(link.target, { mode: mode }).then(function (result) {
      if (!result || result.error === "no_gesture" || result.error === "timeout" || result.error === "no_board") {
        return;
      }
      // The page was deleted or restored since the links were checked: recheck every link, not just this one.
      var missing = result.error === "not_found" || result.error === "in_trash";
      if (missing !== link.el.classList.contains("scribe-link-missing")) {
        recheckLinks();
      }
    });
  }, false);

  /** Mark links to pages that don't exist, and fill in empty link text with the page's title. */
  var labelQueued = false;
  function labelLinks() {
    labelQueued = false;
    if (!embedded) {
      return;
    }
    var els = document.querySelectorAll("[data-scribe-open]:not([data-scribe-link-checked])");
    if (!els.length) {
      return;
    }
    var targets = [];
    for (var i = 0; i < els.length; i += 1) {
      els[i].setAttribute("data-scribe-link-checked", "");
      targets.push(els[i].getAttribute("data-scribe-open") || "");
    }
    resolve(targets).then(function (pages) {
      for (var j = 0; j < els.length; j += 1) {
        var el = els[j];
        var raw = (el.getAttribute("data-scribe-open") || "").split("#")[0].trim();
        if (externalUrl(raw)) {
          continue;
        }
        var page = pages[raw];
        el.classList.toggle("scribe-link-missing", !page);
        // An empty link shows its page's title, kept current on each recheck; the target itself while the page is missing.
        if (el.hasAttribute("data-scribe-autotitle") || (!el.textContent.trim() && !el.children.length)) {
          el.setAttribute("data-scribe-autotitle", "");
          el.textContent = page ? page.title : raw;
        }
        if (page && !el.getAttribute("title")) {
          el.setAttribute("title", page.title);
        }
      }
    });
  }
  /** Pages were created, deleted, or restored: check every link again. */
  function recheckLinks() {
    var els = document.querySelectorAll("[data-scribe-open][data-scribe-link-checked]");
    for (var i = 0; i < els.length; i += 1) {
      els[i].removeAttribute("data-scribe-link-checked");
    }
    queueLabels();
  }
  function queueLabels() {
    if (labelQueued) {
      return;
    }
    labelQueued = true;
    setTimeout(labelLinks, 50);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", queueLabels);
  } else {
    queueLabels();
  }
  if (embedded && typeof MutationObserver === "function") {
    new MutationObserver(function (records) {
      var changed = false;
      for (var i = 0; i < records.length; i += 1) {
        if (records[i].type === "attributes") {
          records[i].target.removeAttribute("data-scribe-link-checked");
          changed = true;
        } else if (records[i].addedNodes.length) {
          changed = true;
        }
      }
      if (changed) {
        queueLabels();
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-scribe-open"] });
  }

  function scrollToAnchor(anchor) {
    var name = anchor == null ? "" : String(anchor).replace(/^#/, "");
    if (!name) {
      return;
    }
    var el = document.getElementById(name) || document.getElementsByName(name)[0];
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) {
      return;
    }
    var data = event.data;
    if (!data || data.id !== tabId) {
      return;
    }
    if (data.type === "scribe-open-result" && linkRequests[data.reqId]) {
      var done = linkRequests[data.reqId];
      delete linkRequests[data.reqId];
      done(data.result || { ok: false, error: "unknown" });
    } else if (data.type === "scribe-scroll") {
      scrollToAnchor(data.anchor);
    } else if (data.type === "scribe-pages-changed") {
      recheckLinks();
    } else if (data.type === "scribe-agent-event") {
      agentListeners.slice().forEach(function (fn) {
        try {
          fn(data.thread);
        } catch (err) {
          console.error(err);
        }
      });
    }
  });

  var template = boot.template && typeof boot.template === "object" ? boot.template : null;

  function reportIncompatible(reason) {
    if (!tabId || !template) {
      return;
    }
    post("/template-incompatible", "POST", { reason: reason == null ? "" : String(reason) }).catch(function (err) {
      console.error("[scribe] reportIncompatible failed", err);
    });
  }

  function assetsPath(suffix) {
    return "/api/tabs/" + encodeURIComponent(tabId) + "/assets" + (suffix || "");
  }

  function readJson(res) {
    return res.json().catch(function () {
      return {};
    }).then(function (data) {
      if (!res.ok) {
        throw new Error((data && data.error) || "request failed (" + res.status + ")");
      }
      return data;
    });
  }

  function warnUsage(usage) {
    if (usage && usage.warning) {
      console.warn("[scribe] " + usage.warning);
    }
  }

  /**
   * Store a Blob, File, ArrayBuffer, or typed array for this page. Keep the returned id (or
   * url) in page state: an asset nothing in the state or HTML mentions is deleted after a
   * grace period.
   */
  function saveAsset(data, options) {
    var opts = options || {};
    if (!tabId) {
      return Promise.reject(new Error("no tab id"));
    }
    var blob = data instanceof Blob ? data : new Blob([data]);
    var name = opts.name || (data && typeof data.name === "string" ? data.name : "") || "asset";
    var type = opts.type || blob.type || "application/octet-stream";
    return fetch(assetsPath(""), {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Asset-Name": encodeURIComponent(name),
        "X-Asset-Type": type
      },
      body: blob
    })
      .then(readJson)
      .then(function (result) {
        warnUsage(result.usage);
        var asset = result.asset;
        asset.usage = result.usage;
        return asset;
      });
  }

  function deleteAsset(id) {
    return fetch(assetsPath("/" + encodeURIComponent(String(id))), { method: "DELETE" })
      .then(readJson)
      .then(function (result) {
        return result.usage;
      });
  }

  function listAssets() {
    return fetch(assetsPath("")).then(readJson);
  }

  function assetUrl(idOrUrl) {
    var value = String(idOrUrl || "");
    return value.indexOf("/blob/") === 0 ? value : "/blob/" + value;
  }

  // ---------- file preview ----------
  // scribe.preview shows files in Scribe's own viewer (images, PDFs, media, text, Markdown, CSV,
  // HTML), so pages need no viewer of their own. The page reads each file itself (it may be one of
  // its assets) and hands the bytes over; Scribe never loads a URL for it.

  function previewFile(item, opts) {
    if (item instanceof Blob) {
      return Promise.resolve({ blob: item, name: item.name || opts.name || "file", mimeType: item.type || opts.mimeType || "" });
    }
    var spec = typeof item === "string" ? { src: item } : item || {};
    if (spec.blob instanceof Blob) {
      return Promise.resolve({ blob: spec.blob, name: spec.name || spec.blob.name || "file", mimeType: spec.mimeType || spec.blob.type || "" });
    }
    var src = String(spec.src || spec.url || spec.asset || "");
    if (!src) {
      return Promise.reject(new Error("Nothing to preview"));
    }
    // An asset id or /blob/ path, or any URL this page may fetch.
    var url = /^[a-z][a-z0-9+.-]*:|^\\//i.test(src) ? src : assetUrl(src);
    return fetch(url).then(function (res) {
      if (!res.ok) {
        throw new Error("Could not load " + src + " (" + res.status + ")");
      }
      return res.blob().then(function (blob) {
        var name = spec.name || opts.name || decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() || "file");
        return { blob: blob, name: name, mimeType: spec.mimeType || opts.mimeType || blob.type || "" };
      });
    });
  }

  /**
   * Preview one file or several (arrow keys step through them): a Blob or File, an asset id or URL,
   * or { src | blob, name?, mimeType? }. Needs a click or key press, like scribe.open.
   * opts: { index, name, mimeType }. Resolves { ok } or { ok: false, error }.
   */
  function preview(files, opts) {
    opts = opts || {};
    if (!hasGesture()) {
      console.warn("[scribe] scribe.preview needs a click or key press; ignored");
      return Promise.resolve({ ok: false, error: "no_gesture" });
    }
    var list = Array.isArray(files) ? files : [files];
    return Promise.all(
      list.map(function (item) {
        return previewFile(item, list.length === 1 ? opts : {});
      })
    ).then(
      function (resolved) {
        return askBoard({ type: "scribe-preview", files: resolved, index: Number(opts.index) || 0 });
      },
      function (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    );
  }

  // ---------- agent ----------
  // A page can run agent chat threads of its own. Starting, sending, and stopping need a click or
  // key press, unless the user lets the page run agents without one; Code and Plan threads need the
  // user's approval for their folder. Scribe checks both on its side and asks the user when needed,
  // so those calls may take as long as the user does.
  var agentListeners = [];
  var AGENT_ASK_MS = 10 * 60 * 1000;

  function agentText(value) {
    return value == null ? null : String(value);
  }

  function agentCall(message, timeoutMs) {
    message.type = "scribe-agent";
    return askBoard(message, timeoutMs || 30000).then(function (result) {
      if (result && result.ok === false && (result.error === "no_gesture" || result.error === "denied")) {
        console.warn(
          "[scribe] scribe.agent." + message.op + ": " +
            (result.error === "no_gesture" ? "needs a click or key press" : "not allowed (" + (result.permission || "permission") + ")")
        );
      }
      return result;
    });
  }

  /** The thread settings a page may pass to start(); Scribe checks them against the page's permissions. */
  function agentSettings(opts) {
    var out = {};
    ["title", "mode", "show", "provider", "model", "effort", "approval", "cwd"].forEach(function (name) {
      if (opts[name] != null && opts[name] !== "") {
        out[name] = String(opts[name]);
      }
    });
    ["worktree", "web", "fast"].forEach(function (name) {
      if (typeof opts[name] === "boolean") {
        out[name] = opts[name];
      }
    });
    if (opts.modelParams && typeof opts.modelParams === "object" && !Array.isArray(opts.modelParams)) {
      var params = {};
      Object.keys(opts.modelParams).forEach(function (key) {
        var val = opts.modelParams[key];
        if (val != null && val !== "") params[key] = String(val);
      });
      if (Object.keys(params).length) out.modelParams = params;
    }
    return out;
  }

  var agent = {
    /**
     * New thread for this page: { ok, threadId, queued }. opts: { title, show: "dock" | "sidebar",
     * mode: "board" | "ask" | "code" | "plan", provider, model, effort, fast (Cursor),
     * modelParams, and for Code and Plan: cwd (folder), approval: "ask" | "edits" | "auto" | "full",
     * worktree, web }.
     */
    start: function (prompt, opts) {
      var message = agentSettings(opts || {});
      message.op = "start";
      message.prompt = agentText(prompt);
      return agentCall(message, AGENT_ASK_MS);
    },
    /** Send to one of this page's threads; queued when it is still working: { ok, queued }. */
    send: function (threadId, prompt, opts) {
      opts = opts || {};
      return agentCall({ op: "send", threadId: agentText(threadId), prompt: agentText(prompt), show: agentText(opts.show) }, AGENT_ASK_MS);
    },
    /** Stop the thread's current turn and drop its queued messages: { ok }. */
    stop: function (threadId) {
      return agentCall({ op: "stop", threadId: agentText(threadId) }, AGENT_ASK_MS);
    },
    /**
     * Merge an idle thread's worktree branch into the branch it came from, and close the worktree:
     * { ok, merged, message }. merged is false when the thread has no open worktree.
     */
    merge: function (threadId) {
      return agentCall({ op: "merge", threadId: agentText(threadId) }, AGENT_ASK_MS);
    },
    /** This page's threads, newest first: { ok, threads: [{ id, title, status, queued, activityAt, finishedAt, mode, model, cwd }] }. */
    threads: function () {
      return agentCall({ op: "threads" });
    },
    /** One thread and its latest reply: { ok, thread, reply }. */
    get: function (threadId) {
      return agentCall({ op: "get", threadId: agentText(threadId) });
    },
    /** Resolves once the thread is idle (queue included): { ok, thread, reply }, or { ok: false, error: "timeout" }. */
    wait: function (threadId, opts) {
      var ms = opts && typeof opts.timeoutMs === "number" ? Math.max(1000, opts.timeoutMs) : 600000;
      return agentCall({ op: "wait", threadId: agentText(threadId), timeoutMs: ms }, ms + 5000);
    },
    /** What start() can pick from: { ok, providers, models (id, label, efforts, params), modes, approvals, defaults }. */
    options: function () {
      return agentCall({ op: "options" });
    },
    /** Let the user pick a folder for Code and Plan threads (needs a click): { ok, path } or { ok: false, error: "cancelled" }. */
    pickFolder: function (opts) {
      if (!hasGesture()) {
        console.warn("[scribe] scribe.agent.pickFolder needs a click or key press; ignored");
        return Promise.resolve({ ok: false, error: "no_gesture" });
      }
      return agentCall({ op: "pickFolder", initial: agentText(opts && opts.initial) }, AGENT_ASK_MS);
    },
    /** fn({ id, title, status, queued, reply? }) whenever one of this page's threads changes status. */
    onChange: function (fn) {
      agentListeners.push(fn);
      return function () {
        agentListeners = agentListeners.filter(function (item) {
          return item !== fn;
        });
      };
    }
  };

  // ---------- permissions ----------
  // What the user lets this page do (tab menu → Permissions…). Only Scribe can change them.
  var permissions = {
    /** { ok, permissions: [{ id, label, value: "allow" | "deny" | "ask", folders? }] } */
    query: function () {
      return askBoard({ type: "scribe-permissions", op: "query" }, 30000);
    },
    /**
     * Ask the user up front, e.g. from a settings dialog (needs a click): { ok, granted }.
     * opts for agent.workspace: { folder, approval }.
     */
    request: function (perm, opts) {
      if (!hasGesture()) {
        console.warn("[scribe] scribe.permissions.request needs a click or key press; ignored");
        return Promise.resolve({ ok: false, error: "no_gesture" });
      }
      opts = opts || {};
      return askBoard(
        { type: "scribe-permissions", op: "request", perm: agentText(perm), folder: agentText(opts.folder), approval: agentText(opts.approval) },
        AGENT_ASK_MS
      );
    }
  };

  window.scribe = {
    id: tabId,
    template: template,
    saveAsset: saveAsset,
    deleteAsset: deleteAsset,
    listAssets: listAssets,
    assetUrl: assetUrl,
    get state() {
      return current;
    },
    get revision() {
      return revision;
    },
    get local() {
      return local;
    },
    update: update,
    set: set,
    setLocal: setLocal,
    bind: bind,
    flush: flushAll,
    signal: signal,
    action: action,
    open: open,
    resolve: resolve,
    preview: preview,
    agent: agent,
    permissions: permissions,
    /** The ops engine, for pages that build ops: get(state, path), diff(before, after, keys), apply(state, ops). */
    ops: {
      get: engine.getAt,
      diff: engine.diff,
      apply: function (state, ops) {
        return engine.apply(state, ops).state;
      }
    },
    reportIncompatible: reportIncompatible,
    onChange: function (fn) {
      listeners.push(fn);
      return function () {
        listeners = listeners.filter(function (item) {
          return item !== fn;
        });
      };
    }
  };
})();
`.trim();

export const BOARD_STALE_CSS = `
.scribe-stale { outline: 1px dashed rgba(224, 179, 74, 0.7); outline-offset: 2px; }
[data-scribe-open] { cursor: pointer; }
.scribe-link-missing { text-decoration: line-through !important; opacity: 0.6; cursor: not-allowed !important; }
`.trim();
