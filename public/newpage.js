/**
 * The New page screen (Ctrl+T): what a blank page shows instead of a frame. Shapeless moving
 * matter (one of several shader backgrounds, taking turns) behind a short prompt and the templates; picking one fills this page. Once the page has a
 * chat thread, the templates step aside and the screen waits for what the agent makes.
 */
(() => {
  const FILE_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 2h7.5l3.5 3.5V14h-11z" fill="currentColor"/></svg>';
  const BUILTIN_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill-rule="evenodd" d="M2.5 2h7.5l3.5 3.5V14h-11zM8 7.2l.9 1.8 2 .3-1.45 1.4.35 2L8 11.75l-1.8.95.35-2L5.1 9.3l2-.3z" fill="currentColor"/></svg>';
  const SPARK_SVG =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.2l1.5 3.9 3.9 1.5-3.9 1.5L8 12l-1.5-3.9L2.6 6.6l3.9-1.5z" fill="currentColor"/><circle cx="12.8" cy="12.6" r="1.5" fill="currentColor"/></svg>';

  /** Settings key, also written by the Layout track in app.js: the chosen background ids, comma-separated. */
  const BG_KEY = "scribe.newPageBackgrounds";
  const PROVIDER_KEY = "scribe.newPageProviderColors";

  /**
   * What every background shares: noise, the nebula (fractal noise warped through itself twice,
   * coloured from deep navy through indigo and violet to a cool blue rim), and the two ways matter
   * goes over the near-black panel, using the provider or theme effect colours.
   */
  const HEAD = `precision highp float;
uniform vec2 u_res;uniform float u_time;uniform float u_motionTime;uniform vec3 u_bg;uniform float u_light;uniform float u_work;
uniform float u_tint;uniform vec3 u_c0;uniform vec3 u_c1;uniform vec3 u_c2;uniform vec3 u_c3;
vec3 tint(vec3 col){if(u_tint<.5)return col;
float m=max(col.r,max(col.g,col.b)),t=clamp(m,0.,1.)*3.;
vec3 c=t<1.?mix(u_c0,u_c1,t):t<2.?mix(u_c1,u_c2,t-1.):mix(u_c2,u_c3,t-2.);
return c*m/max(max(c.r,max(c.g,c.b)),.001);}
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
vec2 hash2(vec2 p){return vec2(hash(p),hash(p+19.19));}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);}
float fbm(vec2 p){float v=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);
for(int i=0;i<5;i++){v+=a*noise(p);p=m*p;a*=.5;}return v;}
float vig(vec2 uv){return smoothstep(1.3,.1,length(uv*vec2(.8,1.)));}
vec3 cover(vec3 col,float a,float al){col=tint(col);return u_light>.5?mix(u_bg,mix(col,vec3(1.),.2),al):mix(u_bg,col,a);}
vec3 glow(vec3 base,vec3 e){float m=max(e.r,max(e.g,e.b));
e=tint(e);
return u_light>.5?mix(base,mix(e/max(m,.001),vec3(1.),.2),clamp(m,0.,1.)*.6):base+e;}
vec3 neb(vec2 uv,float t,out float lum){
vec2 p=uv*1.35;
vec2 q=vec2(fbm(p+vec2(0.,t)),fbm(p+vec2(5.2,1.3)-t*.8));
vec2 r=vec2(fbm(p+3.*q+vec2(1.7,9.2)+t*.6),fbm(p+3.*q+vec2(8.3,2.8)-t*.5));
float f=fbm(p+3.2*r);
vec3 deep=vec3(.05,.06,.20),indigo=vec3(.20,.19,.72),violet=vec3(.56,.26,.96),blue=vec3(.30,.62,1.);
vec3 col=mix(deep,indigo,smoothstep(.2,.7,f));
col=mix(col,violet,smoothstep(.45,.95,length(q))*.85);
col=mix(col,blue,smoothstep(.5,.85,r.y)*.65);
lum=smoothstep(.3,.85,f);
col*=.4+1.275*lum*lum;
col+=vec3(.78,.7,1.)*pow(smoothstep(.5,.88,f),4.)*.7;
return col;}
vec3 nebula(vec2 uv,float t,out float lum){
vec3 col=neb(uv,t,lum);float v=vig(uv);
vec3 o=cover(col,clamp((.3+.9*lum)*v,0.,1.),lum*v*.6);lum*=v;return o;}
`;

  /** Dithered so the soft gradients don't band. */
  const TAIL = `
void main(){
vec2 uv=(gl_FragCoord.xy-.5*u_res)/min(u_res.x,u_res.y);
vec3 c=shade(uv,u_time);
c+=(hash(gl_FragCoord.xy+fract(u_time))-.5)/128.;
gl_FragColor=vec4(c,1.);}`;

  /** Inward highlights gather into a breathing core, without changing the cloud's drift. */
  const NEBULA = `vec3 shade(vec2 uv,float T){float l;vec3 c=nebula(uv,T*.05,l);
float r=length(uv);float wave=pow(.5+.5*cos(r*13.+T*1.1),5.);
float core=exp(-r*6.)*(.6+.4*sin(T*.9));
return glow(c,u_work*vig(uv)*(vec3(.38,.28,.8)*wave*(.09+.32*l)+vec3(.48,.42,1.)*core*.17));}`;

  /** A slow working sweep lights sparkles in place, preserving their idle drift and twinkle. */
  const STARDUST = `vec3 shade(vec2 uv,float T){float l;vec3 c=nebula(uv,T*.04,l);vec3 e=vec3(0.);
for(int i=0;i<3;i++){float fi=float(i);float s=9.+fi*8.;
float sweep=pow(.5+.5*sin(uv.x*3.+uv.y*2.-T*.3+fi*.6),6.);
vec2 g=uv*s+vec2(T*.02*(fi+1.),T*.035);vec2 id=floor(g);vec2 h=hash2(id+fi*17.);
vec2 d=fract(g)-.5-(h-.5)*.6;float r=length(d);
float tw=pow(.5+.5*sin(T*(.8+h.x*2.5)+h.y*6.283),6.);
tw=mix(tw,max(tw,sweep*1.05),u_work);
float g1=pow(smoothstep(.3,0.,r),4.)*.5+smoothstep(.05,0.,r);
float sp=max(0.,1.-abs(d.x)*28.)*max(0.,1.-abs(d.y)*4.5)+max(0.,1.-abs(d.y)*28.)*max(0.,1.-abs(d.x)*4.5);
e+=mix(vec3(.75,.85,1.),vec3(.95,.8,1.),h.y)*(g1+sp*.45)*tw*step(h.x,.5)*(.15+1.6*l)*(1.-fi*.25);}
return glow(c,e);}`;

  /** Four hanging veils, each a wavy lower edge that fades upward, streaked with fine vertical rays. */
  const AURORA = `vec3 shade(vec2 uv,float T){float t=T*.05;vec3 c=vec3(0.);
for(int i=0;i<4;i++){float fi=float(i);float x=uv.x*(.9+fi*.25)+fi*3.1;
float off=(fbm(vec2(x*.8,t+fi))-.5)*.9-.3+fi*.1;float dy=uv.y-off;
float band=smoothstep(-.02,.03,dy)*exp(-max(dy,0.)*(2.6+fi));
float streak=.4+.6*noise(vec2(x*26.+fbm(vec2(x*3.,t*2.))*6.,t*3.+fi));
vec3 col=mix(vec3(.22,.5,1.),vec3(.64,.3,.98),clamp(dy*2.2+fi*.15,0.,1.));
float wave=pow(.5+.5*sin(x*3.-T*1.1-fi*.9),5.);
c+=col*band*streak*(.6-fi*.08)*(1.+u_work*wave*1.4);}
c+=vec3(.25,.22,.8)*.1*fbm(uv*2.+t);
return glow(u_bg,c*vig(uv));}`;

  /** A faint caustic net over deep blue haze; three broad submerged highlights bloom while working. */
  const CAUSTICS = `vec3 shade(vec2 uv,float T){vec2 p=uv*4.5-vec2(250.);vec2 i=p;float c=1.;
for(int n=0;n<5;n++){float t=T*.16*(1.-3.5/float(n+1));
i=p+vec2(cos(t-i.x)+sin(t+i.y),sin(t-i.y)+cos(t+i.x));
c+=1./length(vec2(p.x/(sin(i.x+t)/.005),p.y/(cos(i.y+t)/.005)));}
c/=5.;c=1.17-pow(c,1.4);float k=pow(abs(c),8.);
float depth=fbm(uv*1.5+T*.02);
vec3 e=(vec3(.1,.09,.34)*depth*.5+vec3(.42,.6,1.)*k*.3*(.35+depth)+vec3(.62,.36,1.)*k*k*.1)*.2;
for(int b=0;b<3;b++){float slot=float(b);float clock=T*.13+slot/3.;
float cycle=floor(clock),phase=fract(clock);vec2 seed=vec2(cycle,slot+27.);
vec2 centre=(hash2(seed)-.5)*vec2(1.7,1.);
centre.y+=sin(phase*3.14159)*.08;
float bloom=pow(sin(phase*3.14159),2.);
float radius=.16+.1*hash(seed+9.)+.06*bloom;
vec2 d=uv-centre;float blob=exp(-dot(d,d)/(radius*radius));
e+=mix(vec3(.3,.45,1.),vec3(.6,.35,1.),hash(seed+5.))*blob*bloom*u_work*(.18+k*.12);}
return glow(u_bg,e*vig(uv));}`;

  /** Height lines of a smooth, shifting terrain, one pixel wide whatever the slope; every fourth is brighter. */
  const CONTOURS = `float f3(vec2 p){return noise(p)*.6+noise(p*2.1+7.)*.28+noise(p*4.3+3.)*.12;}
vec3 shade(vec2 uv,float T){float t=T*.05;vec2 p=uv*1.1;
vec2 q=vec2(f3(p+vec2(0.,t)),f3(p+vec2(5.2,1.3)-t*.8));
float h=f3(p*.9+1.6*q+vec2(t*.4,0.));float k=h*22.;
float d=abs(fract(k+.5)-.5);float w=fwidth(k);
float line=1.-smoothstep(w*.5,w*1.5,d);
float major=step(mod(floor(k+.5),4.),.5);
vec3 col=mix(vec3(.24,.24,.85),vec3(.6,.3,.98),smoothstep(.35,.6,h));
col=mix(col,vec3(.35,.68,1.),smoothstep(.55,.75,h));
vec3 c=col*line*(.35+.65*major)+col*smoothstep(.3,.8,h)*.14;
float wave=pow(.5+.5*cos(length(uv)*17.-T*1.25),10.);
c+=vec3(.55,.7,1.)*line*wave*u_work*.65;
return glow(u_bg,c*vig(uv));}`;

  /** Nebula dots on a tilted grid, with sparse blue colour droplets while working. */
  const HALFTONE = `vec3 shade(vec2 uv,float T){float m=min(u_res.x,u_res.y);float cells=m/9.;
vec2 g=mat2(.866,-.5,.5,.866)*uv*cells;vec2 id=floor(g)+.5;vec2 f=fract(g)-.5;
vec2 cuv=mat2(.866,.5,-.5,.866)*id/cells;float l;vec3 col=neb(cuv,T*.05,l);float v=vig(cuv);
float seed=hash(id);float cycle=floor(T*.22+seed*13.);
float phase=fract(T*.22+seed*13.);float blink=pow(sin(phase*3.14159),4.)*step(.982,hash(id+cycle*17.))*u_work;
col=mix(col,vec3(.4,.65,1.),blink*.35);
l+=blink*.07;
float rad=.5*sqrt(clamp(l*v*1.6+.06*v,0.,1.));float aa=cells/m;
float a=(1.-smoothstep(rad-aa,rad+aa,length(f)))*step(.03,rad);
return cover(col*1.3+.04,a,a*.6);}`;

  /** Working discs morph into gently spinning polygons and stars; drift uses an integrated clock. */
  const BOKEH = `float cross2(vec2 a,vec2 b){return a.x*b.y-a.y*b.x;}
float shapeRadius(float a,float kind){
if(kind<3.){float n=kind+3.;float sector=6.283185/n;
return cos(3.141593/n)/cos(mod(a+sector*.5,sector)-sector*.5);}
float sector=.6283185;float k=floor(mod(a,6.283185)/sector);
float a0=k*sector,a1=a0+sector;
float r0=mod(k,2.)<.5?1.:.45;float r1=1.45-r0;
vec2 v0=vec2(cos(a0),sin(a0))*r0,v1=vec2(cos(a1),sin(a1))*r1;
return cross2(v0,v1)/cross2(vec2(cos(a),sin(a)),v1-v0);}
vec3 shade(vec2 uv,float T){float l;vec3 c=mix(u_bg,nebula(uv,T*.04,l),.5);vec3 e=vec3(0.);
for(int i=0;i<3;i++){float fi=float(i);float s=2.4+fi*1.9;
vec2 g=uv*s+vec2(u_motionTime*.018*(fi+1.),-u_motionTime*.03*(1.+fi*.5))+fi*5.3;
vec2 id=floor(g);vec2 h=hash2(id+fi*31.);vec2 d=fract(g)-.5-(h-.5)*.45;
float rr=.16+.14*h.y,r=length(d);
float spin=(.035+.055*hash(id+fi*31.+7.))*(h.x<.25?-1.:1.);
float angle=atan(d.y,d.x)+T*spin+h.y*6.283185;
float boundary=shapeRadius(angle,floor(hash(id+fi*31.+13.)*4.));
r/=mix(1.,boundary,u_work);
float disc=smoothstep(rr,rr-.035,r);float ring=smoothstep(.035,0.,abs(r-rr+.03));
vec3 bc=mix(vec3(.32,.56,1.),vec3(.68,.36,1.),h.y);
e+=bc*(disc*.17+ring*.1)*step(h.x,.5)*(.55+.45*sin(T*.5+h.x*20.))*(1.-fi*.22)*vig(uv);}
return glow(c,e);}`;

  /**
   * The backgrounds, by the ids the setting stores. Half resolution suits the soft ones and keeps
   * them cheap on big screens; the ones made of lines and dots need every pixel.
   */
  const STYLES = {
    nebula: { frag: NEBULA },
    stardust: { frag: STARDUST },
    aurora: { frag: AURORA },
    caustics: { frag: CAUSTICS },
    contours: { frag: CONTOURS, sharp: true, derivatives: true },
    halftone: { frag: HALFTONE, sharp: true },
    bokeh: { frag: BOKEH },
  };

  /** The backgrounds the user left on in Settings; all of them when nothing valid is stored. */
  function chosen() {
    const ids = (localStorage.getItem(BG_KEY) || "").split(",").filter((id) => STYLES[id]);
    return ids.length ? ids : Object.keys(STYLES);
  }

  let bag = [];
  let lastPick = null;

  /**
   * The next background, drawn from a bag of the chosen ones that refills when it runs out, so
   * each shows equally often. A refill doesn't start with the one just shown.
   */
  function pick() {
    const ids = chosen();
    bag = bag.filter((id) => ids.includes(id));
    if (!bag.length) bag = [...ids];
    const pool = bag.length > 1 ? bag.filter((id) => id !== lastPick) : bag;
    lastPick = pool[Math.floor(Math.random() * pool.length)];
    bag.splice(bag.indexOf(lastPick), 1);
    return lastPick;
  }

  /** The shader behind the New page screen; null when WebGL isn't there (the CSS blobs show then). */
  function createBackdrop(root) {
    const GL = window.scribeGL;
    if (!GL) return null;
    const still = matchMedia("(prefers-reduced-motion: reduce)");
    let canvas = root.querySelector(".np-canvas");
    let fx = null;
    let style = null;
    // Starts somewhere along the drift, so each new page doesn't open on the same frame.
    let time = Math.random() * 400;
    let motionTime = time;
    let running = false;
    let work = 0;
    let target = 0;
    let palette = null;

    function build(id) {
      const { frag, sharp, derivatives } = STYLES[id];
      return GL.create(canvas, (derivatives ? "#extension GL_OES_standard_derivatives : enable\n" : "") + HEAD + frag + TAIL, {
        scale: sharp ? () => Math.min(2, devicePixelRatio || 1) : 0.5,
        extensions: derivatives ? ["OES_standard_derivatives"] : [],
      });
    }

    /** One shader per WebGL context, so another background gets a fresh canvas. The nebula stands in for one that won't compile. */
    function use(id) {
      if (fx && id === style) return true;
      if (fx) {
        fx.destroy();
        const next = canvas.cloneNode();
        canvas.replaceWith(next);
        canvas = next;
      }
      fx = build(id) || (id !== "nebula" && build("nebula")) || null;
      style = fx ? id : null;
      return Boolean(fx);
    }

    function theme() {
      const css = getComputedStyle(root);
      const m = css.backgroundColor.match(/[\d.]+/g) || [0, 0, 0];
      const [r, g, b] = m.slice(0, 3).map((v) => v / 255);
      fx.set({ u_bg: [r, g, b], u_light: 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? 1 : 0 });
      const themeColors = [1, 2, 3].map((i) => css.getPropertyValue("--fx-" + i).split(",").map((v) => Number(v) / 255));
      const colors = palette
        ? palette.map((c) => [1, 3, 5].map((p) => parseInt(c.slice(p, p + 2), 16) / 255))
        : [themeColors[0].map((v) => v * .2), ...themeColors];
      fx.set({ u_tint: 1, ...Object.fromEntries(colors.map((c, i) => ["u_c" + i, c])) });
    }

    const draw = () => fx?.draw({ u_time: time, u_motionTime: motionTime, u_work: work });
    const loop = GL.loop((dt) => {
      work += (target - work) * Math.min(1, dt * 2);
      time += dt;
      motionTime += dt * (1 + .1 * work);
      draw();
    });

    function start() {
      theme();
      if (still.matches) {
        loop.stop();
        work = target;
        draw();
        return;
      }
      loop.start();
    }

    if (!use("nebula")) return null;
    new MutationObserver(() => running && start()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    new ResizeObserver(() => running && draw()).observe(root);
    still.addEventListener("change", () => running && start());

    return {
      /** Run with this background while the screen is shown. */
      set(on, id, working = false, colors = null) {
        palette = colors;
        target = working ? 1 : 0;
        running = Boolean(on && use(id));
        if (running) start();
        else loop.stop();
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
   * threads), working(id) (an agent is at work on it), openChat(), provider() (the floating chat's provider).
   */
  window.createNewPage = (host) => {
    const root = document.getElementById("newpage");
    const body = root.querySelector(".newpage-body");
    const lede = root.querySelector(".newpage-lede");
    const askBtn = root.querySelector(".newpage-ask");
    const grid = root.querySelector(".newpage-templates");
    const gridHead = root.querySelector(".newpage-templates-head");
    askBtn.innerHTML = `${SPARK_SVG}<span>Ask the agent</span><kbd>Ctrl</kbd><kbd>K</kbd>`;
    askBtn.addEventListener("click", () => host.openChat());
    const backdrop = createBackdrop(root);
    root.classList.toggle("gl", Boolean(backdrop));
    /** Each blank page keeps the background it drew, so coming back to it doesn't change it. */
    const picks = new Map();
    let current = null;
    /** The page shown and what was drawn for it, so a re-render with nothing new keeps focus and scroll. */
    let shown = null;
    let drawn = "";
    let replacement = null;

    function cancelReplacement() {
      if (!replacement) return;
      replacement.frame.removeEventListener("load", replacement.reveal);
      clearTimeout(replacement.timer);
      replacement.animations.forEach((animation) => animation.cancel());
      replacement = null;
      root.inert = false;
    }

    /** Hold the waiting screen until its own page loads, then dissolve it over the page. */
    function replace(tab, frame) {
      if (replacement?.id === tab.id) return;
      if (!frame || current?.id !== tab.id) {
        render(null);
        return;
      }
      const pending = { id: tab.id, frame, animations: [], timer: 0, reveal: null };
      replacement = pending;
      root.inert = true;
      pending.reveal = () => {
        if (replacement !== pending) return;
        frame.removeEventListener("load", pending.reveal);
        clearTimeout(pending.timer);
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          render(null);
          return;
        }
        const timing = { duration: 420, easing: "ease-in-out", fill: "both" };
        pending.animations = [
          root.animate([{ opacity: 1, filter: "blur(0px)" }, { opacity: 0, filter: "blur(12px)" }], timing),
          frame.animate([{ opacity: 0, filter: "blur(8px)" }, { opacity: 1, filter: "blur(0px)" }], timing),
        ];
        Promise.all(pending.animations.map((animation) => animation.finished)).then(() => {
          if (replacement === pending) render(null);
        }).catch(() => { /* Switching pages cancels the animations. */ });
      };
      if (frame.dataset.loaded) pending.reveal();
      else {
        frame.addEventListener("load", pending.reveal);
        // A slow or failed frame must not leave the waiting screen covering the page forever.
        pending.timer = setTimeout(pending.reveal, 4000);
      }
    }

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

    function background(id) {
      if (!chosen().includes(picks.get(id))) picks.set(id, pick());
      return picks.get(id);
    }

    function updateBackdrop(provider = host.provider?.()) {
      const colors = localStorage.getItem(PROVIDER_KEY) !== "0" && provider ? window.scribeOrb?.colors(provider) : null;
      root.classList.toggle("provider-colors", Boolean(colors));
      if (colors) colors.forEach((c, i) => root.style.setProperty("--np-c" + i, [1, 3, 5].map((p) => parseInt(c.slice(p, p + 2), 16)).join(",")));
      else [0, 1, 2, 3].forEach((i) => root.style.removeProperty("--np-c" + i));
      backdrop?.set(Boolean(current), current ? background(current.id) : null, current ? host.working(current.id) : false, colors);
    }

    function render(tab) {
      cancelReplacement();
      root.hidden = !tab;
      current = tab || null;
      updateBackdrop();
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
      body.inert = threads > 0;
      // Keep the existing text and template cards in place while they fade away.
      if (threads > 0) return;
      lede.textContent = "Start from a template, or ask the agent to make something here.";
      gridHead.hidden = !list.length;
      grid.replaceChildren(...list.map(([template, builtin]) => card(template, builtin)));
    }

    window.addEventListener("scribe:newpage-bg", () => updateBackdrop());
    window.addEventListener("scribe:dock-provider", (event) => updateBackdrop(event.detail.provider));
    window.addEventListener("scribe:orb-appearance", () => updateBackdrop());
    window.addEventListener("scribe:threads-ready", () => updateBackdrop());

    return {
      render,
      replace,
      /** Focus a starting control only while the page has no thread. */
      focus() {
        if (!current || host.threads(current.id) > 0) return;
        (grid.querySelector("button") || askBtn).focus({ preventScroll: true });
      },
    };
  };
})();
