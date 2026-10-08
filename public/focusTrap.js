/**
 * Keep Tab inside a modal. bind(root) cycles focus among visible controls in root,
 * focuses the first one unless something inside already has focus, and returns unbind.
 */
(() => {
  const SELECTOR =
    'a[href]:not([disabled]),button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function visible(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function focusables(root) {
    return [...root.querySelectorAll(SELECTOR)].filter(visible);
  }

  function trapTab(event, root) {
    if (event.key !== "Tab" || event.defaultPrevented) return false;
    const list = focusables(root);
    if (!list.length) {
      event.preventDefault();
      return true;
    }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !root.contains(active)) {
        event.preventDefault();
        last.focus();
        return true;
      }
    } else if (active === last || !root.contains(active)) {
      event.preventDefault();
      first.focus();
      return true;
    }
    return false;
  }

  function bind(root, { initial } = {}) {
    const onKey = (event) => trapTab(event, root);
    root.addEventListener("keydown", onKey);
    if (!root.contains(document.activeElement)) {
      (initial || focusables(root)[0])?.focus({ preventScroll: true });
    }
    return () => root.removeEventListener("keydown", onKey);
  }

  window.scribeFocusTrap = { focusables, trapTab, bind };
})();
