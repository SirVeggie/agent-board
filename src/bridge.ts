/**
 * Injected into every tab page. Gives the page `window.board` over the tab's
 * server-owned state: `board.state`, `board.set`, `board.onChange`, `board.bind`,
 * `board.signal`, page-saved blobs: `board.saveAsset`, `board.assetUrl`,
 * `board.deleteAsset`, `board.listAssets`, and page links: `board.open`, `board.resolve`,
 * `data-board-open`, and external hrefs (opened in the browser, a peek, or a split).
 *
 * Boot state is inlined ahead of this script so `board.state` is readable
 * synchronously by page scripts.
 */
export const BOARD_BRIDGE_JS = `
(function () {
  var boot = window.__BOARD_BOOT__ || {};
  try { delete window.__BOARD_BOOT__; } catch (err) { window.__BOARD_BOOT__ = undefined; }

  var IDLE_MS = 250;
  var MAX_WAIT_MS = 1000;

  var tabId = boot.id || "";
  var client = "c_" + Math.random().toString(36).slice(2, 10);
  var current = boot.state && typeof boot.state === "object" ? boot.state : {};
  var revision = typeof boot.stateRevision === "number" ? boot.stateRevision : 0;

  var listeners = [];
  var bindings = [];
  var pending = null;
  var pendingSince = 0;
  var timer = null;
  var inFlight = false;
  var queuedSignal = null;

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
        console.error("[board] onChange handler failed", err);
      }
    }
  }

  function applyBindings() {
    for (var i = 0; i < bindings.length; i += 1) {
      var el = bindings[i].el;
      var key = bindings[i].key;
      if (!(key in current) || sameEl(el, current[key])) {
        el.classList.remove("board-stale");
        continue;
      }
      if (document.activeElement === el) {
        el.classList.add("board-stale");
        continue;
      }
      el.classList.remove("board-stale");
      writeEl(el, current[key]);
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

  function schedule() {
    if (!pendingSince) {
      pendingSince = Date.now();
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(flush, Math.min(IDLE_MS, Math.max(0, pendingSince + MAX_WAIT_MS - Date.now())));
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending || inFlight || !tabId) {
      return;
    }
    var sent = pending;
    pending = null;
    pendingSince = 0;
    inFlight = true;
    fetch("/api/tabs/" + encodeURIComponent(tabId) + "/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: sent, client: client }),
      keepalive: true
    })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        inFlight = false;
        if (data) {
          revision = data.stateRevision;
          adopt(data.state);
        }
        if (queuedSignal) {
          sendSignal();
        } else if (pending) {
          schedule();
        }
      })
      .catch(function (err) {
        inFlight = false;
        console.error("[board] save failed", err);
        if (queuedSignal) {
          sendSignal();
        } else if (pending) {
          schedule();
        }
      });
  }

  function sendSignal() {
    if (!queuedSignal || inFlight || !tabId) {
      return;
    }
    var name = queuedSignal;
    queuedSignal = null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    var body = { name: name, client: client };
    if (pending) {
      body.state = pending;
      pending = null;
      pendingSince = 0;
    }
    inFlight = true;
    fetch("/api/tabs/" + encodeURIComponent(tabId) + "/signal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true
    })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        inFlight = false;
        if (data) {
          if (typeof data.stateRevision === "number") {
            revision = data.stateRevision;
          }
          if (data.state) {
            adopt(data.state);
          }
        }
        if (queuedSignal) {
          sendSignal();
        } else if (pending) {
          schedule();
        }
      })
      .catch(function (err) {
        inFlight = false;
        console.error("[board] signal failed", err);
        if (queuedSignal) {
          sendSignal();
        } else if (pending) {
          schedule();
        }
      });
  }

  function signal(name) {
    var next = name == null ? "" : String(name).trim();
    if (!next) {
      console.error("[board] signal name is required");
      return;
    }
    queuedSignal = next;
    if (inFlight) {
      return;
    }
    sendSignal();
  }

  /** Take the server's view, keeping any local edits made while the save was in flight. */
  function adopt(serverState) {
    if (!serverState || typeof serverState !== "object") {
      return;
    }
    var next = {};
    var key;
    for (key in serverState) {
      next[key] = serverState[key];
    }
    if (pending) {
      for (key in pending) {
        next[key] = pending[key];
      }
    }
    if (JSON.stringify(next) === JSON.stringify(current)) {
      current = next;
      return;
    }
    current = next;
    applyBindings();
    notify();
  }

  function set(partial) {
    if (!partial || typeof partial !== "object") {
      return;
    }
    if (!pending) {
      pending = {};
    }
    for (var key in partial) {
      current[key] = partial[key];
      pending[key] = partial[key];
    }
    schedule();
  }

  function bind(el, key) {
    if (!el || !key) {
      return;
    }
    bindings.push({ el: el, key: key });
    if (key in current) {
      writeEl(el, current[key]);
    } else if (readEl(el)) {
      set(single(key, readEl(el)));
    }
    function onEdit() {
      set(single(key, readEl(el)));
    }
    el.addEventListener("input", onEdit);
    el.addEventListener("change", onEdit);
    el.addEventListener("blur", function () {
      el.classList.remove("board-stale");
      if (pending && key in pending) {
        flush();
        return;
      }
      if (key in current && !sameEl(el, current[key])) {
        writeEl(el, current[key]);
      }
    });
  }

  function single(key, value) {
    var one = {};
    one[key] = value;
    return one;
  }

  function applyRemote(message) {
    if (message.client === client) {
      return;
    }
    if (typeof message.stateRevision === "number" && message.stateRevision <= revision) {
      return;
    }
    revision = message.stateRevision;
    current = message.state && typeof message.state === "object" ? message.state : {};
    if (pending) {
      for (var key in pending) {
        current[key] = pending[key];
      }
    }
    applyBindings();
    notify();
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) {
      return;
    }
    var data = event.data;
    if (!data || data.type !== "agent-board-state" || data.id !== tabId) {
      return;
    }
    applyRemote(data);
  });

  var lastActivityPing = 0;
  function pingActivity() {
    var now = Date.now();
    if (now - lastActivityPing < 400) {
      return;
    }
    lastActivityPing = now;
    try {
      parent.postMessage({ type: "agent-board-activity", id: tabId }, "*");
    } catch (err) {}
  }

  document.addEventListener("pointerdown", reconcileSoon, true);
  document.addEventListener("keyup", reconcileSoon, true);
  document.addEventListener("input", pingActivity, true);
  document.addEventListener("change", pingActivity, true);
  document.addEventListener("keydown", pingActivity, true);
  document.addEventListener("pointerdown", pingActivity, true);

  window.addEventListener("pagehide", function () {
    if (queuedSignal) {
      sendSignal();
      return;
    }
    flush();
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      if (queuedSignal) {
        sendSignal();
        return;
      }
      flush();
      return;
    }
    applyBindings();
  });

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) {
      return;
    }
    var src = target.closest("[data-board-signal]");
    if (!src) {
      return;
    }
    var name = src.getAttribute("data-board-signal");
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
    var name = form.getAttribute("data-board-signal");
    if (!name) {
      return;
    }
    event.preventDefault();
    signal(name);
  }, false);

  /* ---------- page links: board.open, data-board-open, external hrefs ---------- */

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

  /** An http(s) URL outside the board, or null. Everything else is a page key or id. */
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
   * Open a board page (by key or id) or an http(s) URL as a tab, a peek, or a split.
   * Without a mode, a page follows the board's Settings default and a URL opens in the browser.
   */
  function open(target, options) {
    var opts = options || {};
    var raw = target == null ? "" : String(target).trim();
    if (!raw) {
      return Promise.resolve({ ok: false, error: "not_found" });
    }
    if (!hasGesture()) {
      console.warn("[board] board.open needs a click or key press; ignored " + raw);
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
      type: "agent-board-open",
      target: url || raw,
      mode: mode,
      anchor: anchor || null,
      background: opts.background === true
    });
  }

  /** Look up board pages by key or id: { [target]: { id, title, open } | null }. */
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
    return askBoard({ type: "agent-board-resolve", targets: clean }).then(function (reply) {
      return reply && reply.pages ? reply.pages : {};
    });
  }

  function linkFor(target) {
    if (!target || !target.closest) {
      return null;
    }
    var el = target.closest("[data-board-open], a[href]");
    if (!el) {
      return null;
    }
    if (el.hasAttribute("data-board-open")) {
      return { el: el, target: el.getAttribute("data-board-open") || "" };
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
    var mode = modeFromEvent(event) || cleanMode(link.el.getAttribute("data-board-mode"));
    open(link.target, { mode: mode }).then(function (result) {
      if (!result || result.error === "no_gesture" || result.error === "timeout" || result.error === "no_board") {
        return;
      }
      // The page was deleted or restored since the links were checked: recheck every link, not just this one.
      var missing = result.error === "not_found" || result.error === "in_trash";
      if (missing !== link.el.classList.contains("board-link-missing")) {
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
    var els = document.querySelectorAll("[data-board-open]:not([data-board-link-checked])");
    if (!els.length) {
      return;
    }
    var targets = [];
    for (var i = 0; i < els.length; i += 1) {
      els[i].setAttribute("data-board-link-checked", "");
      targets.push(els[i].getAttribute("data-board-open") || "");
    }
    resolve(targets).then(function (pages) {
      for (var j = 0; j < els.length; j += 1) {
        var el = els[j];
        var raw = (el.getAttribute("data-board-open") || "").split("#")[0].trim();
        if (externalUrl(raw)) {
          continue;
        }
        var page = pages[raw];
        el.classList.toggle("board-link-missing", !page);
        // An empty link shows its page's title, kept current on each recheck; the target itself while the page is missing.
        if (el.hasAttribute("data-board-autotitle") || (!el.textContent.trim() && !el.children.length)) {
          el.setAttribute("data-board-autotitle", "");
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
    var els = document.querySelectorAll("[data-board-open][data-board-link-checked]");
    for (var i = 0; i < els.length; i += 1) {
      els[i].removeAttribute("data-board-link-checked");
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
          records[i].target.removeAttribute("data-board-link-checked");
          changed = true;
        } else if (records[i].addedNodes.length) {
          changed = true;
        }
      }
      if (changed) {
        queueLabels();
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-board-open"] });
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
    if (data.type === "agent-board-open-result" && linkRequests[data.reqId]) {
      var done = linkRequests[data.reqId];
      delete linkRequests[data.reqId];
      done(data.result || { ok: false, error: "unknown" });
    } else if (data.type === "agent-board-scroll") {
      scrollToAnchor(data.anchor);
    } else if (data.type === "agent-board-pages-changed") {
      recheckLinks();
    } else if (data.type === "agent-board-agent-event") {
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
    fetch("/api/tabs/" + encodeURIComponent(tabId) + "/template-incompatible", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason == null ? "" : String(reason) }),
      keepalive: true
    }).catch(function (err) {
      console.error("[board] reportIncompatible failed", err);
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
      console.warn("[board] " + usage.warning);
    }
  }

  /**
   * Store a Blob, File, ArrayBuffer, or typed array for this page. Keep the returned id (or
   * url) in board state: an asset nothing in the state or HTML mentions is deleted after a
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

  // ---------- agent ----------
  // A page can start agent chat threads of its own and continue them. Starting or sending needs a
  // click or key press, like board.open (the board checks again on its side); reading does not.
  var agentListeners = [];

  function agentText(value) {
    return value == null ? null : String(value);
  }

  function agentCall(message, timeoutMs) {
    message.type = "agent-board-agent";
    return askBoard(message, timeoutMs || 30000);
  }

  function agentWrite(message) {
    if (!hasGesture()) {
      console.warn("[board] board.agent." + message.op + " needs a click or key press; ignored");
      return Promise.resolve({ ok: false, error: "no_gesture" });
    }
    return agentCall(message);
  }

  var agent = {
    /** New thread for this page: { ok, threadId, queued }. opts: { title, mode: "board" | "ask", show: "dock" | "sidebar" }. */
    start: function (prompt, opts) {
      opts = opts || {};
      return agentWrite({ op: "start", prompt: agentText(prompt), title: agentText(opts.title), mode: agentText(opts.mode), show: agentText(opts.show) });
    },
    /** Send to one of this page's threads; queued when it is still working: { ok, queued }. */
    send: function (threadId, prompt, opts) {
      opts = opts || {};
      return agentWrite({ op: "send", threadId: agentText(threadId), prompt: agentText(prompt), show: agentText(opts.show) });
    },
    /** This page's threads, newest first: { ok, threads: [{ id, title, status, queued, activityAt }] }. */
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

  window.board = {
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
    set: set,
    bind: bind,
    flush: flush,
    signal: signal,
    open: open,
    resolve: resolve,
    agent: agent,
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
.board-stale { outline: 1px dashed rgba(224, 179, 74, 0.7); outline-offset: 2px; }
[data-board-open] { cursor: pointer; }
.board-link-missing { text-decoration: line-through !important; opacity: 0.6; cursor: not-allowed !important; }
`.trim();
