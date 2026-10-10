/**
 * Shared WebGL setup for Scribe's shader effects: a full-screen triangle drawn through one
 * fragment shader, so each effect is just its shader and a few uniforms. The shader gets u_res
 * (backing pixels) on every draw; the rest are the effect's own.
 */
(() => {
  const VERT = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";

  /**
   * opts: alpha (transparent canvas; the shader writes premultiplied colour), scale (backing pixels
   * per CSS pixel, or a function returning it), extensions (WebGL extensions the shader needs).
   * Null when WebGL isn't there or the shader fails. async requests non-blocking readiness
   * with KHR_parallel_shader_compile when supported; that path returns a Promise.
   */
  function create(canvas, frag, opts = {}) {
    const gl = canvas.getContext("webgl", {
      alpha: Boolean(opts.alpha),
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      powerPreference: "low-power",
    });
    if (!gl) return null;
    const parallel = opts.async && gl.getExtension("KHR_parallel_shader_compile");
    for (const name of opts.extensions || []) gl.getExtension(name);
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (parallel || gl.getShaderParameter(s, gl.COMPILE_STATUS)) return s;
      gl.deleteShader(s);
      return null;
    };
    const vs = shader(gl.VERTEX_SHADER, VERT);
    const fs = shader(gl.FRAGMENT_SHADER, frag);
    if (!vs || !fs) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return null;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    const release = () => {
      gl.deleteShader(vs); gl.deleteShader(fs); gl.deleteProgram(prog);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
    function finish() {
      if (opts.signal?.aborted || gl.isContextLost() || !gl.getProgramParameter(prog, gl.LINK_STATUS)) { release(); return null; }
      gl.deleteShader(vs); gl.deleteShader(fs);
      gl.useProgram(prog);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "p");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const locs = new Map();
      const u = (name) => {
        if (!locs.has(name)) locs.set(name, gl.getUniformLocation(prog, name));
        return locs.get(name);
      };

      /** Sets uniforms by name: a number is a float, an array of 2 to 4 numbers a vec. */
      function set(values) {
        for (const [name, v] of Object.entries(values)) {
          const at = u(name);
          if (!at) continue;
          if (typeof v === "number") gl.uniform1f(at, v);
          else gl[`uniform${v.length}fv`](at, v);
        }
      }

      return {
        set,
        destroy() {
          gl.deleteBuffer(buffer);
          gl.deleteProgram(prog);
          gl.getExtension("WEBGL_lose_context")?.loseContext();
        },
        /** Sizes the canvas to its CSS box times scale, sets values, and draws a frame. False while it has no size. */
        draw(values) {
          if (gl.isContextLost()) return false;
          const scale = typeof opts.scale === "function" ? opts.scale() : opts.scale || 1;
          if (!canvas.clientWidth || !canvas.clientHeight) return false;
          const w = Math.max(1, Math.round(canvas.clientWidth * scale));
          const h = Math.max(1, Math.round(canvas.clientHeight * scale));
          if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            gl.viewport(0, 0, w, h);
          }
          set({ u_res: [w, h], ...values });
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          return true;
        },
      };
    }
    if (!parallel) return finish();
    return new Promise((resolve) => {
      const poll = () => {
        if (opts.signal?.aborted) { release(); resolve(null); }
        else if (gl.getProgramParameter(prog, parallel.COMPLETION_STATUS_KHR)) resolve(finish());
        else setTimeout(poll, 16);
      };
      poll();
    });
  }

  /** Keep CSS fallbacks until a shown effect is needed, after saved tabs have painted. */
  function lazy(canvas, frag, opts = {}) {
    let fx = null;
    let dead = false;
    let queued = false;
    let wanted = false;
    let frame = 0;
    let uniforms = {};
    const controller = new AbortController();
    const visible = () => !document.hidden && canvas.isConnected && canvas.clientWidth > 0 && canvas.clientHeight > 0;
    const restored = () => !document.documentElement.hasAttribute("data-restoring");
    function queue() {
      if (dead || fx || queued || !wanted || !visible() || !restored()) return;
      queued = true;
      // Two frames let the restored shell paint before the first visible effect is built.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (dead || !visible() || !restored()) { queued = false; return; }
          Promise.resolve(window.scribeGL.create(canvas, frag, { ...opts, async: true, signal: controller.signal })).then((built) => {
            queued = false;
            if (dead) { built?.destroy(); return; }
            fx = built;
            cleanup();
            if (!fx) { dead = true; opts.onError?.(); return; }
            canvas.dataset.ready = "1";
            fx.draw(uniforms);
            opts.onReady?.();
          });
        });
      });
    }
    const resize = new ResizeObserver(queue);
    resize.observe(canvas);
    document.addEventListener("visibilitychange", queue);
    window.addEventListener("scribe:restored", queue);
    function cleanup() {
      resize.disconnect();
      document.removeEventListener("visibilitychange", queue);
      window.removeEventListener("scribe:restored", queue);
      if (frame) cancelAnimationFrame(frame);
    }
    return {
      set(values) { Object.assign(uniforms, values); fx?.set(values); },
      draw(values) {
        Object.assign(uniforms, values);
        if (dead || !visible()) return false;
        wanted = true;
        if (fx) return fx.draw(uniforms);
        queue();
        return true;
      },
      destroy() { dead = true; controller.abort(); cleanup(); fx?.destroy(); },
    };
  }

  /**
   * A frame loop at about 30 fps, plenty for slow shader motion: step(dt) gets the seconds since
   * the last frame (0 on the first). It idles while the window is hidden and picks up after.
   */
  function loop(step) {
    let running = false;
    let frame = 0;
    let last = 0;
    function tick(now) {
      frame = 0;
      if (!running || document.hidden) return;
      if (now - last >= 32) {
        const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
        last = now;
        step(dt);
      }
      if (running) frame = requestAnimationFrame(tick);
    }
    function kick() {
      if (frame || !running || document.hidden) return;
      last = 0;
      frame = requestAnimationFrame(tick);
    }
    document.addEventListener("visibilitychange", kick);
    return {
      get running() {
        return running;
      },
      start() {
        running = true;
        kick();
      },
      stop() {
        running = false;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
      },
      destroy() {
        this.stop();
        document.removeEventListener("visibilitychange", kick);
      },
    };
  }

  let colours = null;

  /**
   * The theme's effect colours (--fx-1..3 in app.css) as uniforms: u_c1 the base, u_c2 and u_c3 its
   * highlights, and u_light 1 on a light theme, where the colours tint the chrome darker.
   */
  function palette() {
    if (!colours) {
      const css = getComputedStyle(document.documentElement);
      const rgb = (name) => css.getPropertyValue(name).split(",").map((v) => (Number(v) || 0) / 255).concat(0, 0, 0).slice(0, 3);
      colours = { u_c1: rgb("--fx-1"), u_c2: rgb("--fx-2"), u_c3: rgb("--fx-3"), u_light: css.colorScheme === "light" ? 1 : 0 };
    }
    return colours;
  }

  new MutationObserver(() => {
    colours = null;
    window.dispatchEvent(new Event("scribe:theme"));
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  window.scribeGL = { create, lazy, loop, palette };
})();
