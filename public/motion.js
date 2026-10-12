/* Shell motion: geometry snaps; only transform and opacity animate. */
(() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const enabled = () => !reduced.matches && !document.documentElement.classList.contains("fx-off");
  const duration = (token = "enter") => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(`--dur-${token}`).trim();
    return value ? parseFloat(value) * (value.endsWith("ms") ? 1 : 1000) : 0;
  };
  const animate = (node, frames, options = {}) => node.animate(frames, {
    duration: enabled() ? duration(options.token || "enter") : 0,
    easing: getComputedStyle(document.documentElement).getPropertyValue("--ease").trim() || "ease",
    ...options,
  });
  const reveal = (node, visible, { translate = "translateY(6px)", ...options } = {}) => {
    const frames = [{ opacity: 0, transform: translate }, { opacity: 1, transform: "none" }];
    return animate(node, visible ? frames : frames.reverse(), { token: visible ? "enter" : "leave", ...options });
  };
  const enter = (node) => {
    if (enabled()) node.dataset.fxEnter = "";
  };
  const clearEnter = (event) => {
    if (event.animationName === "ui-enter") delete event.target.dataset.fxEnter;
  };
  document.addEventListener("animationend", clearEnter);
  document.addEventListener("animationcancel", clearEnter);
  // Finish outstanding shell motion when the user disables effects, including WAAPI.
  const settle = () => {
    if (enabled()) return;
    document.querySelectorAll("[data-fx-enter]").forEach(node => delete node.dataset.fxEnter);
    for (const animation of document.getAnimations()) {
      try { animation.finish(); } catch { /* Infinite CSS effects are paused by CSS. */ }
    }
  };
  new MutationObserver(records => {
    if (records.some(record => record.target === document.documentElement)) settle();
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ["class"] });
  reduced.addEventListener("change", settle);
  window.scribeMotion = { enabled, duration, animate, reveal, enter };
})();
