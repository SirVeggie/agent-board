/**
 * The New page screen (Ctrl+T): what a blank page shows instead of a frame. Shapeless moving
 * matter behind a short prompt and the templates; picking one fills this page. Once the page has a
 * chat thread, the templates step aside and the screen waits for what the agent makes.
 */
(() => {
  const FILE_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 2h7.5l3.5 3.5V14h-11z" fill="currentColor"/></svg>';
  const BUILTIN_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill-rule="evenodd" d="M2.5 2h7.5l3.5 3.5V14h-11zM8 7.2l.9 1.8 2 .3-1.45 1.4.35 2L8 11.75l-1.8.95.35-2L5.1 9.3l2-.3z" fill="currentColor"/></svg>';
  const SPARK_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.2l1.5 3.9 3.9 1.5-3.9 1.5L8 12l-1.5-3.9L2.6 6.6l3.9-1.5z" fill="currentColor"/><circle cx="12.8" cy="12.6" r="1.5" fill="currentColor"/></svg>';

  const VERT = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
  /**
   * A slow nebula: fractal noise warped through itself twice (domain warping), coloured from deep
   * navy through indigo and violet to a cool blue rim, laid over the theme's panel colour and faded
   * out at the edges. Dithered so the soft gradients don't band.
   */
  const FRAG = `precision mediump float;
uniform vec2 u_res;uniform float u_time;uniform vec3 u_bg;uniform float u_light;uniform float u_energy;
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);}
float fbm(vec2 p){float v=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);
for(int i=0;i<5;i++){v+=a*noise(p);p=m*p;a*=.5;}return v;}
void main(){
vec2 uv=(gl_FragCoord.xy-.5*u_res)/min(u_res.x,u_res.y);
float t=u_time*.05;
vec2 p=uv*1.35;
vec2 q=vec2(fbm(p+vec2(0.,t)),fbm(p+vec2(5.2,1.3)-t*.8));
vec2 r=vec2(fbm(p+3.*q+vec2(1.7,9.2)+t*.6),fbm(p+3.*q+vec2(8.3,2.8)-t*.5));
float f=fbm(p+3.2*r);
vec3 deep=vec3(.05,.06,.20),indigo=vec3(.20,.19,.72),violet=vec3(.56,.26,.96),blue=vec3(.30,.62,1.);
vec3 col=mix(deep,indigo,smoothstep(.2,.7,f));
col=mix(col,violet,smoothstep(.45,.95,length(q))*.85);
col=mix(col,blue,smoothstep(.5,.85,r.y)*.65);
float lum=smoothstep(.3,.85,f);
col*=.4+1.5*lum*lum*(.85+.3*u_energy);
col+=vec3(.78,.7,1.)*pow(smoothstep(.5,.88,f),4.)*(.7+.5*u_energy);
float vig=smoothstep(1.3,.1,length(uv*vec2(.8,1.)));
float a=clamp((.3+.9*lum)*vig,0.,1.);
vec3 outc=u_light>.5?mix(u_bg,mix(col,vec3(1.),.2),lum*vig*.6):mix(u_bg,col,a);
outc+=(hash(gl_FragCoord.xy+fract(u_time))-.5)/128.;
gl_FragColor=vec4(outc,1.);}`;

  /** The shader behind the New page screen; null when WebGL isn't there (the CSS blobs show then). */
  function createNebula(canvas) {
    const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, powerPreference: "low-power" });
    if (!gl) return null;
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = shader(gl.VERTEX_SHADER, VERT);
    const fs = shader(gl.FRAGMENT_SHADER, FRAG);
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
    const u = (name) => gl.getUniformLocation(prog, name);
    const uRes = u("u_res");
    const uTime = u("u_time");
    const uBg = u("u_bg");
    const uLight = u("u_light");
    const uEnergy = u("u_energy");

    const still = matchMedia("(prefers-reduced-motion: reduce)");
    // Starts somewhere along the drift, so each new page doesn't open on the same frame.
    let time = Math.random() * 400;
    let energy = 0;
    let target = 0;
    let running = false;
    let frame = 0;
    let last = 0;

    function theme() {
      const m = getComputedStyle(canvas.parentElement).backgroundColor.match(/[\d.]+/g) || [0, 0, 0];
      const [r, g, b] = m.slice(0, 3).map((v) => v / 255);
      gl.uniform3f(uBg, r, g, b);
      gl.uniform1f(uLight, 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? 1 : 0);
    }

    function draw() {
      // Half resolution: the nebula is all soft gradients, and this keeps it cheap on big screens.
      const w = Math.max(1, Math.round(canvas.clientWidth / 2));
      const h = Math.max(1, Math.round(canvas.clientHeight / 2));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(uRes, w, h);
      gl.uniform1f(uTime, time);
      gl.uniform1f(uEnergy, energy);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function tick(now) {
      frame = 0;
      if (!running) return;
      // About 30 fps is plenty for motion this slow.
      if (now - last >= 32) {
        const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
        last = now;
        energy += (target - energy) * Math.min(1, dt * 1.5);
        time += dt * (1 + energy * 2.5);
        draw();
      }
      frame = requestAnimationFrame(tick);
    }

    function start() {
      theme();
      if (still.matches) {
        energy = target;
        draw();
        return;
      }
      if (!frame) {
        last = 0;
        frame = requestAnimationFrame(tick);
      }
    }

    new MutationObserver(() => running && start()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    document.addEventListener("visibilitychange", () => running && !document.hidden && start());
    new ResizeObserver(() => running && draw()).observe(canvas);

    return {
      /** Run while the screen is shown; working speeds the drift up and brightens it. */
      set(on, working) {
        target = working ? 1 : 0;
        running = on;
        if (on) start();
        else if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
      },
    };
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /**
   * host: templates() and builtins() (template metas), pick(template), threads(id) (the page's chat
   * threads), working(id) (an agent is at work on it), openChat().
   */
  window.createNewPage = (host) => {
    const root = document.getElementById("newpage");
    const lede = root.querySelector(".newpage-lede");
    const askBtn = root.querySelector(".newpage-ask");
    const grid = root.querySelector(".newpage-templates");
    const gridHead = root.querySelector(".newpage-templates-head");
    askBtn.innerHTML = `${SPARK_SVG}<span>Ask the agent</span><kbd>Ctrl</kbd><kbd>K</kbd>`;
    askBtn.addEventListener("click", () => host.openChat());
    const nebula = createNebula(root.querySelector(".np-canvas"));
    root.classList.toggle("gl", Boolean(nebula));
    /** The page shown and what was drawn for it, so a re-render with nothing new keeps focus and scroll. */
    let shown = null;
    let drawn = "";

    function card(template, builtin) {
      const btn = el("button", "newpage-card");
      btn.type = "button";
      const icon = el("span", "newpage-card-icon");
      icon.innerHTML = builtin ? BUILTIN_SVG : FILE_SVG;
      const text = el("span", "newpage-card-text");
      text.append(el("span", "newpage-card-title", template.title));
      if (template.description) text.append(el("span", "newpage-card-desc", template.description));
      btn.append(icon, text);
      btn.addEventListener("click", () => host.pick(template));
      return btn;
    }

    /** Built-ins that already have a local copy show once, as the copy. */
    function templateList() {
      const own = host.templates();
      const copied = new Set(own.map((t) => t.builtinSource).filter(Boolean));
      const builtins = host.builtins().filter((t) => !t.localId && !copied.has(t.key));
      return [...own.map((t) => [t, false]), ...builtins.map((t) => [t, true])];
    }

    function render(tab) {
      root.hidden = !tab;
      nebula?.set(Boolean(tab), tab ? host.working(tab.id) : false);
      if (!tab) {
        shown = null;
        drawn = "";
        return;
      }
      const threads = host.threads(tab.id);
      const working = host.working(tab.id);
      const list = threads ? [] : templateList();
      const key = JSON.stringify([tab.id, threads, working, list.map(([t]) => [t.id, t.title, t.description])]);
      if (shown === tab.id && drawn === key) return;
      shown = tab.id;
      drawn = key;
      root.classList.toggle("has-thread", threads > 0);
      root.classList.toggle("working", Boolean(working));
      lede.textContent = threads
        ? working
          ? "The agent is working on it. What it makes takes this page's place."
          : "Ask the agent in the chat. The page it makes takes this page's place."
        : "Start from a template, or ask the agent to make something here.";
      askBtn.querySelector("span").textContent = threads ? "Open the chat" : "Ask the agent";
      gridHead.hidden = !list.length;
      grid.replaceChildren(...list.map(([template, builtin]) => card(template, builtin)));
    }

    return {
      render,
      /** Focus the first template, or the chat button once the templates are gone. */
      focus() {
        (grid.querySelector("button") || askBtn).focus({ preventScroll: true });
      },
    };
  };
})();
