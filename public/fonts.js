// The blocking stylesheet contains the font bytes, but decoding is asynchronous.
// Keep the first visible shell layout behind decoding, even with the overlay off.
(() => {
  if (!document.fonts) return;
  const root = document.documentElement;
  root.setAttribute("data-fonts-loading", "");
  // One character from each bundled subset prepares titles in every supported
  // script. All four weights share the same variable WOFF2 faces.
  // Settle every face before revealing; a damaged face uses the system fallback.
  Promise.allSettled([400, 500, 600, 700].map(weight =>
    document.fonts.load(`${weight} 14px Inter`, "Scribe Ā Ж Ѡ Ἀ α ế")
  )).then(() => root.removeAttribute("data-fonts-loading"));
})();
