/** Daemon-backed visual preferences; localStorage is only a cache and migration source. */
(() => {
  const seed = window.scribeAppearanceSeed;
  if (!seed) return;
  const keys = new Set(seed.keys);
  let settings = { ...seed.settings };
  let sharedSettings = { ...seed.settings };
  let revision = seed.revision ?? 0;
  const legacy = {};
  const pending = new Map();
  let saving = false;
  let retry;
  for (const key of keys) {
    if (Object.hasOwn(settings, key)) continue;
    try {
      const value = localStorage.getItem(key) ?? localStorage.getItem(key.replace(/^scribe\./, "agent-board."));
      if (value !== null) legacy[key] = value;
    } catch { /* Browser storage may be disabled; the daemon still works. */ }
  }
  settings = { ...legacy, ...settings };
  function cache() {
    for (const [key, value] of Object.entries(settings)) {
      try { localStorage.setItem(key, value); } catch { /* Cache is optional. */ }
    }
  }
  function receive(shared, incomingRevision = revision) {
    if (incomingRevision >= revision) {
      revision = incomingRevision;
      sharedSettings = { ...shared };
    }
    settings = { ...sharedSettings, ...Object.fromEntries(pending) };
    cache();
    window.dispatchEvent(new Event("scribe:appearance"));
  }
  async function request(values, migrate = false) {
    const response = await fetch("/api/appearance", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: values, migrate }),
    });
    if (!response.ok) throw new Error("Could not save appearance settings in Scribe.");
    return { settings: await response.json(), revision: Number(response.headers.get("X-Appearance-Revision")) };
  }
  async function flush() {
    if (saving || !pending.size) return;
    clearTimeout(retry); retry = null;
    saving = true;
    const batch = Object.fromEntries(pending);
    try {
      const shared = await request(batch);
      for (const [key, value] of Object.entries(batch)) {
        if (pending.get(key) === value) pending.delete(key);
      }
      receive(shared.settings, shared.revision);
    } catch (error) {
      window.scribeApp?.showNotice?.("Appearance changes haven't reached Scribe. Retrying…");
      console.warn(error.message);
      clearTimeout(retry);
      retry = setTimeout(() => { retry = null; void flush(); }, 5000);
    } finally {
      saving = false;
    }
    if (pending.size && !retry) void flush();
  }
  window.scribeAppearance = {
    getItem(key) { return keys.has(key) ? settings[key] ?? null : localStorage.getItem(key); },
    setItem(key, value) {
      if (!keys.has(key)) return localStorage.setItem(key, value);
      value = String(value);
      if (settings[key] === value) return;
      settings[key] = value;
      pending.set(key, value);
      cache();
      void flush();
    },
    receive,
  };
  cache();
  // Only actual saved keys migrate. A fresh browser must not publish built-in fallbacks.
  if (Object.keys(legacy).length) {
    const migrate = () => request(legacy, true).then(result => receive(result.settings, result.revision)).catch(() => {
      setTimeout(migrate, 5000);
    });
    void migrate();
  }
  window.addEventListener("scribe:connection", async event => {
    if (!event.detail.connected) return;
    // A daemon restart starts a new revision sequence.
    revision = 0;
    clearTimeout(retry); retry = null;
    void flush();
    try {
      const response = await fetch("/api/appearance", { cache: "no-store" });
      if (response.ok) receive(await response.json(), Number(response.headers.get("X-Appearance-Revision")));
    } catch { /* The connection event will retry after reconnecting. */ }
  });
})();
