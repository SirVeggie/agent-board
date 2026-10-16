/**
 * Re-rendering a list without disturbing the rows that did not change.
 *
 * A node that is taken out of the document and put back (or replaced by a new copy) loses `:hover` until the
 * pointer next moves and drops its running transitions. A list rebuilt on every server event therefore blinks:
 * the hover highlight falls to nothing and fades back in, on all rows at once (#407).
 *
 * `scribeSyncChildren(parent, nodes)` makes `nodes` the children of `parent`, but keeps a child already there
 * when the new node would look the same, and moves only what is out of place. A kept child keeps its own
 * listeners: handlers on rows that may be kept must read live data, not what they closed over.
 */
(() => {
  // Set on a node after it is in the page (tooltip.js, hover card), so a fresh copy never has them.
  const IGNORED = new Set(["aria-description", "aria-describedby"]);
  // Their state lives in properties, which attributes don't show.
  const STATEFUL = new Set(["INPUT", "TEXTAREA", "SELECT"]);

  function attrs(el) {
    const out = new Map();
    for (const { name, value } of el.attributes) {
      if (IGNORED.has(name)) continue;
      out.set(name, name === "class" ? value.trim().split(/\s+/).join(" ") : value);
    }
    if (out.get("class") === "") out.delete("class");
    return out;
  }

  function same(a, b) {
    if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
    if (a.nodeType !== Node.ELEMENT_NODE) return a.nodeValue === b.nodeValue;
    if (STATEFUL.has(a.nodeName) || a.childNodes.length !== b.childNodes.length) return false;
    const mine = attrs(a);
    const theirs = attrs(b);
    if (mine.size !== theirs.size) return false;
    for (const [name, value] of mine) {
      if (theirs.get(name) !== value) return false;
    }
    for (let i = 0; i < a.childNodes.length; i += 1) {
      if (!same(a.childNodes[i], b.childNodes[i])) return false;
    }
    return true;
  }

  /*
   * Patching: a row whose text changed (a running thread's status, a chat turn that got one more step) would
   * still be swapped for its new copy, and blink under the pointer on every update (#443). With `patch`, the
   * node in the page takes the new copy's attributes and children instead, so only what differs is touched.
   *
   * A patched node keeps its own listeners, so:
   * - a node that stands for one thing among its siblings carries a key (KEYS), and is only ever patched from
   *   the new copy with that key. Its handlers may close over what the key names, nothing that changes.
   * - controls without a key (buttons, links) are kept only while they look the same, else the new copy goes in.
   * - handlers must not close over a parent node: the new copy's parent is thrown away. Use closest().
   * - `atomic(node)` marks nodes to keep or replace whole: kept while a new copy renders to the same HTML as
   *   the copy it came from, whatever was done to it in the page since (classes, styles, what the user opened).
   */
  const KEYS = ["data-key", "data-item-id", "data-turn", "data-id"];
  // Without a key these are never patched: their handlers or their content belong to the copy they came with.
  const WHOLE = new Set(["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT", "DETAILS", "CANVAS", "IFRAME", "VIDEO", "AUDIO"]);
  const sigs = new WeakMap();
  const KEEP = "data-sync-keep";
  // stand-in -> the node in the page it stands for
  const kept = new WeakMap();

  function keyOf(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    for (const name of KEYS) {
      const value = node.getAttribute(name);
      if (value !== null) return `${name}=${value}`;
    }
    return null;
  }

  const firstClass = (el) => (el.getAttribute("class") || "").trim().split(/\s+/)[0];

  /** Remember what each atomic node in a new subtree rendered as, before the page changes it. */
  function stamp(node, opts) {
    if (node.nodeType !== Node.ELEMENT_NODE || !opts.atomic) return;
    if (opts.atomic(node)) sigs.set(node, node.outerHTML);
    else for (const child of node.children) stamp(child, opts);
  }

  /** The same for a subtree kept because it looks like its new copy: each atomic node rendered as that copy's does. */
  function stampFrom(old, fresh, opts) {
    if (old.nodeType !== Node.ELEMENT_NODE || !opts.atomic) return;
    if (opts.atomic(fresh)) sigs.set(old, fresh.outerHTML);
    else for (let i = 0; i < old.children.length; i += 1) stampFrom(old.children[i], fresh.children[i], opts);
  }

  function patchClass(old, fresh) {
    const cls = fresh.getAttribute("class");
    if (cls === null) old.removeAttribute("class");
    else if (old.getAttribute("class") !== cls) old.setAttribute("class", cls);
  }

  function patchAttrs(old, fresh) {
    for (const { name } of [...old.attributes]) {
      if (!IGNORED.has(name) && !fresh.hasAttribute(name)) old.removeAttribute(name);
    }
    for (const { name, value } of fresh.attributes) {
      if (old.getAttribute(name) !== value) old.setAttribute(name, value);
    }
  }

  /** The node to show for `fresh` where `old` is now: `old` brought up to date, or `fresh` itself. */
  function patch(old, fresh, opts) {
    if (old === fresh) return old;
    if (old.nodeType !== fresh.nodeType || old.nodeName !== fresh.nodeName) return fresh;
    if (old.nodeType !== Node.ELEMENT_NODE) {
      if (old.nodeValue !== fresh.nodeValue) old.nodeValue = fresh.nodeValue;
      return old;
    }
    const key = keyOf(fresh);
    if (keyOf(old) !== key) return fresh;
    // A stand-in for a node the renderer knows is unchanged (window.scribeKeep): keep it, take only its classes.
    if (key !== null && fresh.hasAttribute(KEEP) && kept.get(fresh) === old) {
      patchClass(old, fresh);
      return old;
    }
    if (opts.atomic?.(fresh)) {
      const sig = fresh.outerHTML;
      const had = sigs.get(old);
      if (had === undefined ? same(old, fresh) : had === sig) {
        sigs.set(old, sig);
        return old;
      }
      sigs.set(fresh, sig);
      return fresh;
    }
    if (STATEFUL.has(old.nodeName) || (key === null && WHOLE.has(old.nodeName))) {
      if (same(old, fresh)) return old;
      stamp(fresh, opts);
      return fresh;
    }
    patchAttrs(old, fresh);
    sync(old, [...fresh.childNodes], opts);
    return old;
  }

  /** Whether `old` may be patched into `node`: the same key, or neither has one and they are the same kind of node. */
  function pairs(old, node, key) {
    if (old.nodeType !== node.nodeType || old.nodeName !== node.nodeName) return false;
    if (node.nodeType !== Node.ELEMENT_NODE) return true;
    if (keyOf(old) !== key) return false;
    return key !== null || firstClass(old) === firstClass(node);
  }

  function sync(parent, wanted, opts) {
    const pool = [...parent.childNodes];
    const dropped = [];
    const next = wanted.map((node) => {
      let at = pool.indexOf(node);
      if (at >= 0) return pool.splice(at, 1)[0];
      const key = opts.patch ? keyOf(node) : null;
      // A keyed node is only ever its own earlier copy; the rest take the first one that looks the same.
      if (key === null) at = pool.findIndex((old) => same(old, node));
      if (at >= 0) {
        if (opts.patch) stampFrom(pool[at], node, opts);
        return pool.splice(at, 1)[0];
      }
      if (opts.patch) at = pool.findIndex((old) => pairs(old, node, key));
      if (at < 0) {
        if (opts.patch) stamp(node, opts);
        return node;
      }
      const old = pool.splice(at, 1)[0];
      const live = patch(old, node, opts);
      if (live !== old) dropped.push(old);
      return live;
    });
    for (const old of [...pool, ...dropped]) old.remove();
    let cursor = parent.firstChild;
    for (const node of next) {
      if (node === cursor) cursor = cursor.nextSibling;
      else parent.insertBefore(node, cursor);
    }
  }

  /** opts: { patch, atomic }. Without `patch`, a child is kept only while it looks the same. */
  window.scribeSyncChildren = function scribeSyncChildren(parent, nodes, opts = {}) {
    sync(parent, nodes.flatMap((node) => (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? [...node.childNodes] : [node])), opts);
  };

  /** A stand-in that went in where its node was not: put the node itself there (it moves, so it loses :hover). */
  function resolveKept(root) {
    const stubs = root.hasAttribute?.(KEEP) ? [root] : [...root.querySelectorAll(`[${KEEP}]`)];
    for (const stub of stubs) {
      const real = kept.get(stub);
      if (!real) continue;
      patchClass(real, stub);
      stub.replaceWith(real);
    }
  }

  /** Bring `old` up to date with `fresh` where it stands, and return the node now in the page (`fresh` if `old` could not be patched). */
  window.scribeMorph = function scribeMorph(old, fresh, opts = {}) {
    const live = patch(old, fresh, { ...opts, patch: true });
    if (live !== old) old.replaceWith(live);
    resolveKept(live);
    return live;
  };

  /**
   * A stand-in for `node`, to put in a new copy where `node` would go when the renderer knows it has not changed:
   * scribeMorph keeps `node` itself and gives it only the stand-in's classes, so the renderer can add or drop its
   * own position classes on the stand-in. `node` needs a key (KEYS). The stand-in starts with `node`'s classes.
   */
  window.scribeKeep = function scribeKeep(node) {
    const stub = node.cloneNode(false);
    stub.setAttribute(KEEP, "");
    kept.set(stub, node);
    return stub;
  };
})();
