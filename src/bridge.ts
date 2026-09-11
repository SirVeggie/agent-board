/**
 * Injected into every tab page. Gives the page `window.board` over the tab's
 * server-owned state: `board.state`, `board.set`, `board.onChange`, `board.bind`,
 * `board.signal`.
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

  window.board = {
    id: tabId,
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
`.trim();
