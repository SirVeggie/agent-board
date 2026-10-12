/* Floating shell scrollbars. Wheel, touch, keyboard and scroll anchoring remain native. */
(() => {
  const surfaces = new Map();
  const dirty = new Set([document.body]);
  const changedElements = new Set();
  let frame = 0, pointer = null, dragging = null, fadeTimer;
  const scrollable = value => /^(auto|scroll)$/.test(value);
  const isOverlay = node => node instanceof Element && Boolean(node.closest('.overlay-scrollbar'));
  const queue = () => { if (!frame) frame = requestAnimationFrame(update); };
  const resize = new ResizeObserver(queue);

  function register(el) {
    if (surfaces.has(el) || isOverlay(el) || !(el instanceof HTMLElement)) return;
    const style = getComputedStyle(el);
    // Respect controls intentionally hiding their scrollbar (e.g. the tab strip).
    if (style.scrollbarWidth === 'none' || (!scrollable(style.overflowX) && !scrollable(style.overflowY))) return;
    el.classList.add('overlay-scroll-surface');
    surfaces.set(el, { bars: {}, until: 0 });
    resize.observe(el);
  }

  function makeBar(el, state, axis) {
    const bar = document.createElement('div');
    bar.className = `overlay-scrollbar ${axis}`;
    bar.setAttribute('aria-hidden', 'true');
    const thumb = document.createElement('div');
    thumb.className = 'overlay-scrollbar-thumb';
    bar.append(thumb);
    document.body.append(bar);
    const data = { bar, thumb, axis, travel: 0, range: 0 };
    state.bars[axis] = data;
    thumb.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      thumb.setPointerCapture(event.pointerId);
      dragging = { el, data, start: axis === 'vertical' ? event.clientY : event.clientX,
        scroll: axis === 'vertical' ? el.scrollTop : el.scrollLeft };
      queue();
    });
    thumb.addEventListener('pointermove', event => {
      if (dragging?.data !== data) return;
      const delta = (axis === 'vertical' ? event.clientY : event.clientX) - dragging.start;
      const value = dragging.scroll + delta * data.range / Math.max(1, data.travel);
      if (axis === 'vertical') el.scrollTop = value;
      else el.scrollLeft = value;
      queue();
    });
    const release = () => {
      if (dragging?.data !== data) return;
      dragging = null;
      state.until = performance.now() + 900;
      queue();
    };
    thumb.addEventListener('lostpointercapture', release);
    thumb.addEventListener('pointerup', release);
    thumb.addEventListener('pointercancel', release);
    bar.addEventListener('wheel', event => {
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1;
      el.scrollBy({ left: event.deltaX * unit, top: event.deltaY * unit, behavior: 'instant' });
      event.preventDefault();
    }, { passive: false });
    return data;
  }

  function updateBar(el, state, axis, rect, clip, style) {
    const vertical = axis === 'vertical';
    const size = vertical ? el.clientHeight : el.clientWidth;
    const total = vertical ? el.scrollHeight : el.scrollWidth;
    const overflow = vertical ? style.overflowY : style.overflowX;
    const needed = scrollable(overflow) && total > size + 1 && size > 0;
    let data = state.bars[axis];
    if (!needed) { if (data) data.bar.hidden = true; return; }
    data ||= makeBar(el, state, axis);
    const { bar, thumb } = data;
    const sx = rect.width / el.offsetWidth, sy = rect.height / el.offsetHeight;
    const left = rect.left + el.clientLeft * sx;
    const top = rect.top + el.clientTop * sy;
    const width = el.clientWidth * sx, height = el.clientHeight * sy;
    const length = Math.max(0, (vertical ? height : width) - 4);
    const thumbSize = Math.min(length, Math.max(28, length * size / total));
    data.range = total - size;
    data.travel = length - thumbSize;
    const scroll = vertical ? el.scrollTop : el.scrollLeft;
    // Chromium uses negative scrollLeft for RTL surfaces.
    const fraction = vertical || style.direction !== 'rtl' ? scroll / data.range : 1 + scroll / data.range;
    const offset = Math.max(0, Math.min(1, fraction)) * data.travel;
    const x = vertical ? left + width - 12 : left + 2;
    const y = vertical ? top + 2 : top + height - 12;
    const w = vertical ? 12 : length, h = vertical ? length : 12;
    bar.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;clip-path:inset(${Math.max(0, clip.top - y)}px ${Math.max(0, x + w - clip.right)}px ${Math.max(0, y + h - clip.bottom)}px ${Math.max(0, clip.left - x)}px)`;
    thumb.style.cssText = vertical ? `top:${offset}px;height:${thumbSize}px` : `left:${offset}px;width:${thumbSize}px`;
    // Do not float a covered surface's handle over a dialog or menu above it.
    const cx = Math.max(clip.left, Math.min(clip.right - 1, x + w / 2));
    const cy = Math.max(clip.top, Math.min(clip.bottom - 1, y + h / 2));
    const hit = document.elementsFromPoint(cx, cy).find(node => !isOverlay(node));
    bar.hidden = !hit || !el.contains(hit) || clip.right <= clip.left || clip.bottom <= clip.top;
    const near = pointer && (vertical
      ? Math.abs(pointer.x - (left + width)) <= 24 && pointer.y >= clip.top && pointer.y <= clip.bottom
      : Math.abs(pointer.y - (top + height)) <= 24 && pointer.x >= clip.left && pointer.x <= clip.right);
    bar.classList.toggle('active', Boolean(near || state.until > performance.now() || dragging?.data === data));
    bar.classList.toggle('dragging', dragging?.data === data);
  }

  function update() {
    frame = 0;
    // Inspect changed subtrees once per frame, not the whole transcript on each scroll.
    for (const root of dirty) {
      if (!root?.isConnected || isOverlay(root)) continue;
      register(root);
      root.querySelectorAll?.('*').forEach(register);
    }
    dirty.clear();
    changedElements.forEach(register);
    changedElements.clear();
    let nextFade = Infinity;
    let moving = false;
    for (const [el, state] of surfaces) {
      if (!el.isConnected) {
        Object.values(state.bars).forEach(data => data.bar.remove());
        resize.unobserve(el);
        surfaces.delete(el);
        el.classList.remove('overlay-scroll-surface');
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height || el.closest('[inert]')) {
        Object.values(state.bars).forEach(data => { data.bar.hidden = true; });
        continue;
      }
      const style = getComputedStyle(el);
      const clip = { left: Math.max(0, rect.left), top: Math.max(0, rect.top),
        right: Math.min(innerWidth, rect.right), bottom: Math.min(innerHeight, rect.bottom) };
      // Fixed handles follow the panel's finite entrance/size animations too.
      for (let node = el; node; node = node.parentElement) {
        if (node.getAnimations().some(animation => animation.playState === 'running' &&
          animation.effect?.getTiming().iterations !== Infinity)) moving = true;
      }
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const ps = getComputedStyle(parent);
        if (ps.overflowX === 'visible' && ps.overflowY === 'visible') continue;
        const bounds = parent.getBoundingClientRect();
        if (ps.overflowX !== 'visible') { clip.left = Math.max(clip.left, bounds.left); clip.right = Math.min(clip.right, bounds.right); }
        if (ps.overflowY !== 'visible') { clip.top = Math.max(clip.top, bounds.top); clip.bottom = Math.min(clip.bottom, bounds.bottom); }
      }
      updateBar(el, state, 'vertical', rect, clip, style);
      updateBar(el, state, 'horizontal', rect, clip, style);
      if (state.until > performance.now()) nextFade = Math.min(nextFade, state.until);
    }
    clearTimeout(fadeTimer);
    if (Number.isFinite(nextFade)) fadeTimer = setTimeout(queue, Math.max(1, nextFade - performance.now()));
    if (moving) queue();
  }

  new MutationObserver(records => {
    let changed = false;
    for (const record of records) {
      if (isOverlay(record.target)) continue;
      changed = true;
      if (record.type === 'attributes') changedElements.add(record.target);
      for (const node of record.addedNodes) if (node instanceof Element && !isOverlay(node)) dirty.add(node);
    }
    if (changed) queue();
  }).observe(document.body, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'inert'] });
  document.addEventListener('scroll', event => {
    const state = surfaces.get(event.target);
    if (state) state.until = performance.now() + 900;
    queue();
  }, true);
  document.addEventListener('pointermove', event => {
    pointer = { x: event.clientX, y: event.clientY };
    queue();
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { pointer = null; queue(); });
  window.addEventListener('blur', () => { pointer = null; queue(); });
  document.addEventListener('load', queue, true);
  window.addEventListener('resize', queue);
  queue();
})();
