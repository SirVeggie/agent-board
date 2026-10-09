/**
 * Shared WebGL setup for Scribe's shader effects: a full-screen triangle drawn through one
 * fragment shader, so each effect is just its shader and a few uniforms. The shader gets u_res
 * (backing pixels) on every draw; the rest are the effect's own.
 */
(() => {
  const VERT = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";

  /**
   * opts: alpha (transparent canvas; the shader writes premultiplied colour), scale (backing pixels
   * per CSS pixel, or a function returning it). Null when WebGL isn't there or the shader fails.
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
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = shader(gl.VERTEX_SHADER, VERT);
    const fs = shader(gl.FRAGMENT_SHADER, frag);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
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
      /** Sizes the canvas to its CSS box times scale, sets values, and draws a frame. False while it has no size. */
      draw(values) {
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
      frame = requestAnimationFrame(tick);
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
    };
  }

  window.scribeGL = { create, loop };
})();
