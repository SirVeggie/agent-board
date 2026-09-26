/**
 * Shared hover card for strip tabs, Library rows, and templates.
 * `describe(el)` returns `{ title, id, description?, createdAt, updatedAt, folder? }` or null.
 */
window.createHoverCard = function createHoverCard({ describe }) {
  const card = document.createElement("div");
  card.id = "hover-card";
  card.className = "hover-card";
  card.role = "tooltip";
  card.hidden = true;
  document.body.appendChild(card);

  let showTimer = 0;
  let hideTimer = 0;
  /** @type {HTMLElement | null} */
  let anchor = null;
  let suppressed = false;

  function bind(el, delay) {
    el.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse" || suppressed || event.buttons) {
        return;
      }
      clearTimeout(hideTimer);
      clearTimeout(showTimer);
      if (!card.hidden) {
        show(el);
        return;
      }
      showTimer = window.setTimeout(() => show(el), delay);
    });
    el.addEventListener("pointerleave", () => {
      clearTimeout(showTimer);
      if (anchor === el) {
        hideTimer = window.setTimeout(hide, 80);
      }
    });
    el.addEventListener("pointerdown", hide);
  }

  function show(el) {
    if (!el.isConnected || suppressed) {
      return;
    }
    const info = describe(el);
    if (!info) {
      hide();
      return;
    }
    if (anchor && anchor !== el) {
      anchor.removeAttribute("aria-describedby");
    }
    anchor = el;
    render(info);
    card.hidden = false;
    el.setAttribute("aria-describedby", card.id);
    place(el);
  }

  function hide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    if (anchor) {
      anchor.removeAttribute("aria-describedby");
      anchor = null;
    }
    card.hidden = true;
  }

  /** Hides the card and keeps it away until `resume()`, e.g. for the length of a drag. */
  function suspend() {
    suppressed = true;
    hide();
  }

  function resume() {
    suppressed = false;
  }

  function render(info) {
    card.replaceChildren();
    const title = document.createElement("div");
    title.className = "hover-card-title";
    title.textContent = info.title;
    const id = document.createElement("div");
    id.className = "hover-card-id";
    id.textContent = info.id;
    card.append(title, id);
    if (info.description) {
      const description = document.createElement("div");
      description.className = "hover-card-desc";
      description.textContent = info.description;
      card.appendChild(description);
    }
    const rows = document.createElement("dl");
    rows.className = "hover-card-rows";
    addRow(rows, "Created", info.createdAt);
    addRow(rows, "Updated", info.updatedAt);
    card.appendChild(rows);
    if (info.folder) {
      const folder = document.createElement("div");
      folder.className = "hover-card-folder";
      folder.textContent = info.folder;
      card.appendChild(folder);
    }
  }

  function addRow(rows, label, at) {
    if (!at) {
      return;
    }
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    const rel = document.createElement("span");
    rel.textContent = relative(at);
    const abs = document.createElement("span");
    abs.className = "hover-card-abs";
    abs.textContent = new Date(at).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    dd.append(rel, abs);
    rows.append(dt, dd);
  }

  function place(el) {
    const margin = 8;
    const gap = 6;
    const box = el.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = card;
    const inLibrary = Boolean(el.closest(".side-pane"));
    let left;
    let top;
    if (inLibrary) {
      left = box.left - gap - width;
      top = box.top;
      if (left < margin) {
        left = box.left;
        top = box.bottom + gap;
      }
    } else {
      left = box.left;
      top = box.bottom + gap;
    }
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
    card.style.left = left + "px";
    card.style.top = top + "px";
  }

  function relative(at) {
    const diff = Date.now() - at;
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) {
      return "just now";
    }
    if (diff < hour) {
      return `${Math.floor(diff / minute)} min ago`;
    }
    if (diff < day) {
      const n = Math.floor(diff / hour);
      return `${n} hour${n === 1 ? "" : "s"} ago`;
    }
    if (diff < 30 * day) {
      const n = Math.floor(diff / day);
      return `${n} day${n === 1 ? "" : "s"} ago`;
    }
    return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  window.addEventListener("scroll", hide, true);
  window.addEventListener("wheel", hide, { passive: true, capture: true });
  window.addEventListener("blur", hide);
  window.addEventListener("keydown", hide, true);

  return { bind, hide, suspend, resume, refresh: () => anchor && show(anchor) };
};
