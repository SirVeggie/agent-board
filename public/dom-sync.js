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

  window.scribeSyncChildren = function scribeSyncChildren(parent, nodes) {
    const wanted = nodes.flatMap((node) => (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? [...node.childNodes] : [node]));
    const pool = [...parent.childNodes];
    const next = wanted.map((node) => {
      let at = pool.indexOf(node);
      if (at < 0) at = pool.findIndex((old) => same(old, node));
      return at < 0 ? node : pool.splice(at, 1)[0];
    });
    for (const old of pool) old.remove();
    let cursor = parent.firstChild;
    for (const node of next) {
      if (node === cursor) cursor = cursor.nextSibling;
      else parent.insertBefore(node, cursor);
    }
  };
})();
