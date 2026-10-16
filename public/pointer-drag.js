/* Shared by the shell and the page bridge. Geometry belongs to a drag, not a pointer event. */
(() => {
  const style = document.createElement("style");
  style.textContent = "body.pointer-shield { user-select: none; } body.pointer-shield iframe { pointer-events: none; }";
  document.head.appendChild(style);
  let current = null;
  let suppress = false;
  let clickTimer = 0;
  document.addEventListener("click", (event) => {
    if (!suppress || event.detail === 0) return;
    suppress = false;
    clearTimeout(clickTimer);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  window.scribeDrag = function scribeDrag(options) {
    const event = options.event;
    if (event.button !== 0 || current) return null;
    const target = options.target || event.currentTarget || event.target;
    const start = { x: event.clientX, y: event.clientY };
    let last = event, active = false, ended = false, frame = 0, dirty = true;
    let geometry;
    const rects = new Map();
    const layouts = new Map();
    const api = {
      start,
      rect(node) {
        if (!rects.has(node)) rects.set(node, node.getBoundingClientRect());
        return rects.get(node);
      },
      layout(node) {
        if (!layouts.has(node)) {
          const rect = api.rect(node);
          const transform = getComputedStyle(node).transform;
          const matrix = transform && transform !== "none" ? new DOMMatrix(transform) : null;
          const left = rect.left - (matrix?.m41 || 0), top = rect.top - (matrix?.m42 || 0);
          layouts.set(node, { left, top, width: rect.width, height: rect.height, right: left + rect.width, bottom: top + rect.height });
        }
        return layouts.get(node);
      },
      invalidate() {
        rects.clear();
        layouts.clear();
        dirty = true;
        if (active && !ended) schedule();
      },
      cancel() { stop(last, true); },
      dispose() { cleanup(); },
    };
    current = api;
    function schedule() { frame ||= requestAnimationFrame(apply); }
    function apply() {
      frame = 0;
      if (!active || ended) return;
      // Return true only while auto-scrolling needs another frame.
      try {
        if (dirty) {
          dirty = false;
          geometry = options.measure?.(api);
        }
        if (options.onMove?.(last, geometry, api) === true) schedule();
      } catch (error) { cleanup(); options.onCancel?.(last, api); throw error; }
    }
    function move(next) {
      if (next.pointerId !== event.pointerId || ended) return;
      last = next;
      if (!active) {
        if (Math.hypot(next.clientX - start.x, next.clientY - start.y) < (options.threshold ?? 6)) return;
        activate();
      }
      next.preventDefault();
      schedule();
    }
    function activate() {
      active = true;
      document.body.classList.add("pointer-shield");
      try { options.onStart?.(last, api); } catch (error) { cleanup(); options.onCancel?.(last, api); throw error; }
      // Start may reparent the source, so capture afterwards.
      try { target.setPointerCapture(event.pointerId); } catch { /* synthetic or disconnected */ }
    }
    function cleanup() {
      if (ended) return;
      ended = true;
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", api.invalidate, true);
      window.removeEventListener("resize", api.invalidate);
      target.removeEventListener("lostpointercapture", cancel);
      try { if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId); } catch {}
      document.body.classList.remove("pointer-shield");
      if (current === api) current = null;
    }
    function stop(next, cancelled) {
      if (ended || (next.pointerId !== undefined && next.pointerId !== event.pointerId)) return;
      if (!cancelled && active) {
        last = next;
        cancelAnimationFrame(frame);
        frame = 0;
        apply();
      }
      cleanup();
      if (active) {
        suppress = true;
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => { suppress = false; }, 0);
      }
      if (cancelled) options.onCancel?.(next, api);
      else options.onDrop?.(next, active, api);
    }
    function up(next) { stop(next, false); }
    function cancel(next) { stop(next, true); }
    function blur() { stop(last, true); }
    function key(next) {
      if (next.key !== "Escape") return;
      next.preventDefault();
      next.stopImmediatePropagation();
      stop(last, true);
    }
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", api.invalidate, true);
    window.addEventListener("resize", api.invalidate);
    target.addEventListener("lostpointercapture", cancel);
    if (options.threshold === 0) { event.preventDefault(); activate(); }
    return api;
  };
  window.scribeDrag.rect = node => current ? current.rect(node) : node.getBoundingClientRect();
  window.scribeDrag.layout = node => current ? current.layout(node) : node.getBoundingClientRect();
  window.scribeDrag.invalidate = () => current?.invalidate();
})();
