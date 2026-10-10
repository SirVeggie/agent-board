/**
 * The title bar background: a faint shader behind the tabs and buttons, in the theme's own colours
 * (--fx-1..3 in app.css). Three looks: the aurora edge's noise as a wash over the whole bar, sparse
 * motes drifting sideways, and motes rising. It is calm when idle and livelier while an agent chat
 * runs; the "moves" setting says whether it shows and moves when idle. Like the edge, it only
 * draws while it has something to animate with the window visible and focused, and holds a still
 * frame otherwise.
 */
(() => {
  /** Settings keys, also written by the Layout tracks in app.js. */
  const STYLE_KEY = "scribe.chromeFx";
  const WHEN_KEY = "scribe.chromeFxWhen";

  /**
   * u_phase is the drift the effect has travelled, summed frame by frame in JS. The speed changes
   * with u_busy, and multiplying a clock by a changing speed would jump the whole pattern forward
   * or back while it eases. u_px is backing pixels per CSS pixel, so sizes are in CSS pixels.
   */
  const HEAD = `precision mediump float;
uniform vec2 u_res;uniform float u_time,u_phase,u_busy,u_show,u_px,u_light;uniform vec3 u_c1,u_c2,u_c3;
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);}
float fbm(vec2 p){float v=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);
for(int i=0;i<4;i++){v+=a*noise(p);p=m*p;a*=.5;}return v;}
vec4 outc(vec3 c,float a){a=clamp(a*u_show*(1.+.3*u_light),0.,1.);return vec4(c*a,a);}
`;

  const WASH = `void main(){
vec2 uv=gl_FragCoord.xy/u_res;float t=u_phase;
vec2 p=vec2(gl_FragCoord.x/u_px/160.,uv.y*.8);
vec2 q=vec2(fbm(p+vec2(t,0.)),fbm(p+vec2(5.2,1.3)-t*.7));
vec2 r=vec2(fbm(p+3.*q+vec2(1.7,9.2)+t*.5),fbm(p+3.*q+vec2(8.3,2.8)-t*.4));
float f=fbm(p+3.*r);
vec3 c=mix(u_c1,u_c2,smoothstep(.45,.95,length(q))*.85);
c=mix(c,u_c3,smoothstep(.5,.85,r.y)*.7);
gl_FragColor=outc(c,smoothstep(.25,.85,f)*(.07+.2*u_busy));}`;

  /** Two layers of cells, each with at most one twinkling speck. u_rise 1 sends them up, fading in and out at the bar's edges. */
  const MOTES = `uniform float u_rise;
void main(){
vec2 fc=gl_FragCoord.xy/u_px;float t=u_time;vec3 acc=vec3(0.);float a=0.;
vec2 dir=mix(vec2(1.,0.),vec2(0.,-1.),u_rise);
for(int l=0;l<2;l++){float fl=float(l);float cell=22.+14.*fl;
vec2 p=fc+dir*u_phase*(1.+fl);
vec2 id=floor(p/cell),f=fract(p/cell);float h=hash(id+fl*7.);
float thr=.3+.4*u_busy;float on=smoothstep(thr,thr-.08,h);
vec2 o=vec2(hash(id+3.1),hash(id+8.7));o=.2+.6*o+.12*vec2(sin(t*.7+h*20.),cos(t*.9+h*13.));
float d=length((f-o)*cell);float tw=.5+.5*sin(t*(1.5+3.*h)+h*40.);
float g=(exp(-d*d*.35)+exp(-d*.45)*.15)*tw*on;
acc+=mix(u_c3,u_c2,hash(id+1.3))*g;a+=g;}
float y=gl_FragCoord.y/u_res.y;
a*=mix(1.,smoothstep(0.,.3,y)*smoothstep(1.,.6,y),u_rise);
gl_FragColor=outc(acc/max(a,1e-3),a*(.4+.4*u_busy));}`;

  /** idle and busy are the drift speeds (u_phase per second) at rest and while an agent works. */
  const STYLES = {
    wash: { frag: WASH, scale: () => 0.5, idle: 0.03, busy: 0.12 },
    motes: { frag: MOTES, scale: () => Math.min(2, devicePixelRatio || 1), idle: 6, busy: 36, uniforms: { u_rise: 0 } },
    rise: { frag: MOTES, scale: () => Math.min(2, devicePixelRatio || 1), idle: 3, busy: 14, uniforms: { u_rise: 1 } },
  };

  const chrome = document.querySelector(".chrome");
  const GL = window.scribeGL;
  if (!chrome || !GL) return;
  const still = matchMedia("(prefers-reduced-motion: reduce)");

  let style = null; // the mounted entry of STYLES
  let canvas = null;
  let fx = null;
  let busy = false;
  let when = "idle-still";
  // Eased towards their targets, so the bar wakes up and settles instead of switching.
  let level = 0;
  let show = 0;
  // Start somewhere along the drift, so each window doesn't open on the same frame.
  let time = Math.random() * 100;
  let phase = Math.random() * 40;

  const focused = () => !document.hidden && document.hasFocus();
  const showTarget = () => (when === "busy" && !busy ? 0 : 1);
  const ease = (from, to, dt) => (Math.abs(to - from) < 0.004 ? to : from + (to - from) * Math.min(1, dt * 1.5));

  function draw() {
    fx.draw({ u_time: time, u_phase: phase, u_busy: level, u_show: show, u_px: style.scale(), ...style.uniforms, ...GL.palette() });
  }

  const loop = GL.loop((dt) => {
    if (!fx || !focused()) {
      loop.stop();
      return;
    }
    const always = when === "always";
    level = ease(level, busy ? 1 : 0, dt);
    show = ease(show, showTarget(), dt);
    // Idle, the drift and the twinkle slow to a stop unless the bar is set to always move.
    phase += dt * ((always ? style.idle : 0) * (1 - level) + style.busy * level);
    time += dt * (always ? 1 : level);
    draw();
    if (!always && !busy && level === 0 && show === showTarget()) loop.stop();
  });

  const resized = new ResizeObserver(() => {
    if (fx && !loop.running) draw();
  });

  /** Each look gets a canvas of its own: a WebGL context keeps the one shader it was made with. */
  function mount(id) {
    const next = STYLES[id] || null;
    if (next === style) return;
    resized.disconnect();
    fx?.destroy();
    canvas?.remove();
    fx = canvas = null;
    style = next;
    show = 0;
    if (!style) return;
    canvas = document.createElement("canvas");
    canvas.className = "chrome-fx";
    chrome.prepend(canvas);
    fx = GL.lazy(canvas, HEAD + style.frag, { alpha: true, scale: style.scale, onError: () => { loop.stop(); canvas?.remove(); } });
    if (fx) resized.observe(canvas);
  }

  function render() {
    const stored = localStorage.getItem(WHEN_KEY);
    when = stored === "busy" || stored === "always" ? stored : "idle-still";
    mount(localStorage.getItem(STYLE_KEY) || "wash");
    if (!fx) {
      loop.stop();
      return;
    }
    if (still.matches || !focused()) {
      // A still frame of where it would have settled.
      loop.stop();
      level = busy ? 1 : 0;
      show = showTarget();
      draw();
    } else loop.start();
  }

  /** Called by the agent UI whenever its thread statuses change. */
  function setBusy(next) {
    next = Boolean(next);
    if (next === busy) return;
    busy = next;
    render();
  }

  window.addEventListener("focus", render);
  window.addEventListener("blur", render);
  document.addEventListener("visibilitychange", render);
  window.addEventListener("scribe:chrome-fx", render);
  window.addEventListener("scribe:theme", render);
  still.addEventListener?.("change", render);
  render();

  window.scribeChromeFx = { setBusy };
})();
