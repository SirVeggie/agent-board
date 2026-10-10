/**
 * The aurora edge: a thin line in the theme's effect colours along the bottom of the title bar that drifts while any
 * agent chat runs, from the same noise as the New page nebula. One small WebGL canvas, at half
 * resolution and about 30 fps, that only draws while an agent runs (and through the fade-out after)
 * with the window visible and focused. Idle, a static CSS tint can stand in, which needs no GPU.
 */
(() => {
  /** Settings keys, also written by the Layout switches in app.js. */
  const ANIM_KEY = "scribe.auroraEdge";
  const IDLE_KEY = "scribe.auroraIdle";
  const FADE_MS = 1000;

  /**
   * The nebula's domain-warped noise stretched along x so it flows sideways, in the theme's effect
   * colours (blue and violet on Neutral). Premultiplied alpha follows brightness, so the dark parts let the
   * chrome through instead of laying a dark smudge on light themes.
   */
  const FRAG = `precision mediump float;
uniform vec2 u_res;uniform float u_time;uniform float u_light;uniform vec3 u_c1,u_c2,u_c3;
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);}
float fbm(vec2 p){float v=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);
for(int i=0;i<4;i++){v+=a*noise(p);p=m*p;a*=.5;}return v;}
void main(){
vec2 uv=gl_FragCoord.xy/u_res;
float t=u_time*.12;
vec2 p=vec2(uv.x*u_res.x/90.,uv.y*1.2);
vec2 q=vec2(fbm(p+vec2(t,0.)),fbm(p+vec2(5.2,1.3)-t*.7));
vec2 r=vec2(fbm(p+3.*q+vec2(1.7,9.2)+t*.5),fbm(p+3.*q+vec2(8.3,2.8)-t*.4));
float f=fbm(p+3.*r);
vec3 col=mix(u_c1,u_c2,smoothstep(.45,.95,length(q))*.85);
col=mix(col,u_c3,smoothstep(.5,.85,r.y)*.7);
float lum=smoothstep(.2,.8,f);
col+=mix(u_c2,vec3(1.),.5-.5*u_light)*pow(smoothstep(.5,.88,f),4.)*.8;
float a=clamp(.25+.95*lum,0.,1.);
gl_FragColor=vec4(col*a,a);}`;

  const root = document.querySelector(".chrome-edge");
  if (!root) return;
  const canvas = root.querySelector("canvas");
  const still = matchMedia("(prefers-reduced-motion: reduce)");

  let fx; // created on first use, so an idle window never opens a WebGL context
  let busy = false;
  let fadeUntil = 0;
  // Starts somewhere along the drift, so each window doesn't open on the same frame.
  let time = Math.random() * 400;

  const setting = (key) => localStorage.getItem(key) !== "0";
  const focused = () => !document.hidden && document.hasFocus();

  const loop = window.scribeGL?.loop((dt) => {
    if (!focused() || (!root.classList.contains("on") && performance.now() > fadeUntil)) {
      loop.stop();
      return;
    }
    time += dt;
    fx.draw({ u_time: time, ...window.scribeGL.palette() });
  });

  function glReady() {
    if (fx === undefined) fx = window.scribeGL?.create(canvas, FRAG, { alpha: true, scale: 0.5 }) || null;
    return Boolean(fx && loop);
  }

  function render() {
    const anim = setting(ANIM_KEY) && busy && glReady();
    // Keep drawing through the fade-out rather than freezing mid-fade.
    if (!anim && root.classList.contains("on")) fadeUntil = performance.now() + FADE_MS;
    root.classList.toggle("on", anim);
    root.classList.toggle("tint", setting(IDLE_KEY));
    if (!anim) return;
    if (still.matches) {
      loop.stop();
      fx.draw({ u_time: time, ...window.scribeGL.palette() });
    } else if (focused()) loop.start();
    else fx.draw({ u_time: time, ...window.scribeGL.palette() }); // a still frame to fade in on while the window is in the background
  }

  /** Called by the agent UI whenever its thread statuses change. */
  function setBusy(next) {
    next = Boolean(next);
    if (next === busy) return;
    busy = next;
    render();
  }

  window.addEventListener("focus", render);
  document.addEventListener("visibilitychange", render);
  window.addEventListener("scribe:aurora", render);
  window.addEventListener("scribe:theme", render);
  still.addEventListener?.("change", render);
  render();

  window.scribeAurora = { setBusy };
})();
