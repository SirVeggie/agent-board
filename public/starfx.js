/**
 * The star of an empty chat: the sparkle icon drawn by a shader, with a slow effect around it in
 * the theme's own colours (--fx-1..3 in app.css). Six looks share one shader; the app shows PICK
 * unless "scribe.starFx" names another. It only animates while it is on screen with animated
 * effects on, and holds a still frame otherwise. Without WebGL the plain icon stays.
 */
(() => {
  const STYLE_KEY = "scribe.starFx";
  const STYLES = ["halo", "orbit", "rays", "twinkle", "echo", "dust"];
  const PICK = "dust";

  /** uv runs -1..1 over the canvas, so the star (radius .2) and its dot sit where the icon does. */
  const FRAG = `precision mediump float;
uniform vec2 u_res;uniform float u_time,u_style,u_light;uniform vec3 u_c1,u_c2,u_c3;
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);}
float fbm(vec2 p){float v=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);
for(int i=0;i<4;i++){v+=a*noise(p);p=m*p;a*=.5;}return v;}
vec4 pm(vec3 c,float a){a=clamp(a,0.,1.);return vec4(c*a,a);}
vec4 over(vec4 top,vec4 under){return top+under*(1.-top.a);}
// A four-point star with hollowed sides: below zero inside, about a distance outside.
float star(vec2 p,float r){p=abs(p)+1e-4;return pow(pow(p.x,.62)+pow(p.y,.62),1.613)-r;}

vec4 halo(vec2 uv,float t,float k){float r=length(uv);vec2 q=uv*2.2;
float n=fbm(q+vec2(t*.25,-t*.2)+2.*fbm(q-t*.15));
float g=exp(-r*r*5.)*(.25+.9*n)*(.85+.15*sin(t*1.3));
vec3 c=mix(u_c1,u_c2,smoothstep(.3,.7,n));c=mix(c,u_c3,smoothstep(.5,.1,r)*.6);
return pm(c,g*k);}

vec4 orbit(vec2 uv,float t){vec3 acc=vec3(0.);float a=0.;
for(int i=0;i<3;i++){float fi=float(i);float tilt=fi*1.05+.4;float c=cos(tilt),s=sin(tilt);
vec2 p=vec2(c*uv.x+s*uv.y,-s*uv.x+c*uv.y);
for(int j=0;j<10;j++){float fj=float(j);float ang=t*(1.1+.25*fi)+fi*2.1-fj*.09;
vec2 o=vec2(cos(ang)*(.5+.08*fi),sin(ang)*.2);float d=length(p-o);
float g=exp(-d*d*(900.+fj*500.))*(1.-fj/10.);
acc+=mix(u_c3,u_c2,fi*.5)*g;a+=g;}}
return pm(acc/max(a,1e-3),a);}

vec4 rays(vec2 uv,float t){float r=length(uv);vec2 d=uv/max(r,1e-3);
float n=noise(d*2.5+vec2(t*.3,0.))*noise(d*5.-vec2(0.,t*.4)+7.);
float g=pow(n,1.3)*5.*exp(-r*2.8)+exp(-r*r*9.)*.35;
return pm(mix(u_c2,u_c3,smoothstep(.1,.5,n)),g);}

vec4 twinkle(vec2 uv,float t){float cell=.36;vec2 p=uv/cell+.5;vec2 id=floor(p),f=fract(p)-.5;
float h=hash(id);float ph=t*(.3+.4*h)+h*20.;float k=floor(ph);
// Each life is somewhere new in the cell, and only some cells are lit at a time.
vec2 o=(vec2(hash(id+k),hash(id+k+5.3))-.5)*.55;float on=step(.4,hash(id+k*1.7+2.));
float tw=sin(fract(ph)*3.14159);tw*=tw;float px=2./u_res.y;
float g=smoothstep(px,-px,star((f-o)*cell,.07*tw))*tw*on*smoothstep(.2,.34,length(uv));
return pm(mix(u_c3,u_c2,hash(id+k+1.3)),g);}

vec4 echo(vec2 uv,float t){float r=star(uv,0.);float a=0.;
for(int i=0;i<3;i++){float ph=fract(t*.2+float(i)/3.);float rr=.2+ph*.75;float w=(r-rr)*(34.-18.*ph);
a+=exp(-w*w)*(1.-ph)*smoothstep(0.,.15,ph);}
return pm(mix(u_c3,u_c2,smoothstep(.2,.9,r)),a*.7);}

vec4 dust(vec2 uv,float t){vec3 acc=vec3(0.);float a=0.;
for(int i=0;i<14;i++){float fi=float(i);float h=hash(vec2(fi,1.7)),h2=hash(vec2(fi,9.2));
float ph=fract(t*(.07+.08*h)+h2);
float ang=h*6.2832+fi*2.4+.6*sin(t*.3+fi)+ph*1.2;
vec2 o=vec2(cos(ang),sin(ang))*(.2+ph*.62);float d=length(uv-o);
float g=exp(-d*d*(1400.+1800.*h2))*smoothstep(0.,.15,ph)*(1.-ph)*(.6+.4*sin(t*(2.+3.*h)+fi));
acc+=mix(u_c3,u_c2,h2)*g;a+=g;}
return pm(acc/max(a,1e-3),a);}

void main(){
vec2 uv=(gl_FragCoord.xy-.5*u_res)/(.5*u_res.y);float t=u_time;
vec4 c;
if(u_style<.5)c=halo(uv,t,1.);
else if(u_style<1.5)c=over(orbit(uv,t),halo(uv,t,.4));
else if(u_style<2.5)c=rays(uv,t);
else if(u_style<3.5)c=over(twinkle(uv,t),halo(uv,t,.35));
else if(u_style<4.5)c=over(echo(uv,t),halo(uv,t,.25));
else c=over(dust(uv,t),halo(uv,t,.6));
c*=smoothstep(1.,.6,length(uv));
c=min(c*(1.+.6*u_light),1.);
// The icon itself: the star and its small dot, with a glint passing over them.
float px=2./u_res.y;float d=star(uv,.2+.01*sin(t*1.7));
float fill=max(smoothstep(px,-px,d),smoothstep(px,-px,length(uv-vec2(.2,-.24))-.05));
float band=(uv.x+uv.y)*2.2-(fract(t*.16)*6.-3.);band=exp(-band*band*6.);
vec3 sc=mix(u_c2,u_c3,.5+.5*sin(t*.6+uv.y*4.));
sc=mix(sc,vec3(1.),(.3+.6*band)*(1.-u_light));sc=mix(sc,u_c1,.35*u_light*(1.-band));
c=over(pm(u_c3,exp(-max(d,0.)*16.)*.3),c);
gl_FragColor=over(pm(sc,fill),c);}`;

  const GL = window.scribeGL;
  const still = matchMedia("(prefers-reduced-motion: reduce)");

  /** opts.style fixes the look; otherwise it follows the setting. mount(host) moves the star into an icon's wrapper. */
  function create(opts = {}) {
    if (!GL) return null;
    const canvas = document.createElement("canvas");
    canvas.className = "star-fx";
    canvas.setAttribute("aria-hidden", "true");
    const fx = GL.lazy(canvas, FRAG, {
      alpha: true, scale: () => Math.min(2, window.devicePixelRatio || 1),
      onReady: () => host?.classList.add("gl"),
      onError: () => { dead = true; loop.stop(); host?.classList.remove("gl"); canvas.remove(); },
    });
    if (!fx) return null;
    let host = null;
    let dead = false;
    // Start somewhere along the motion, so each chat doesn't open on the same frame.
    let time = Math.random() * 60;

    const style = () => Math.max(0, STYLES.indexOf(opts.style || localStorage.getItem(STYLE_KEY) || PICK));
    const draw = () => fx.draw({ u_time: time, u_style: style(), ...GL.palette() });
    const loop = GL.loop((dt) => {
      time += dt;
      if (!canvas.isConnected || !draw()) loop.stop();
    });

    function update() {
      if (dead || !canvas.isConnected) {
        loop.stop();
        return;
      }
      const moving = !still.matches && !document.documentElement.classList.contains("no-ui-fx") && canvas.getClientRects().length > 0;
      if (moving) loop.start();
      else {
        loop.stop();
        draw();
      }
    }

    const resized = new ResizeObserver(update);
    resized.observe(canvas);
    window.addEventListener("scribe:ui-fx", update);
    window.addEventListener("scribe:theme", update);
    still.addEventListener?.("change", update);
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      dead = true;
      loop.stop();
      host?.classList.remove("gl");
      canvas.remove();
    });

    return {
      mount(next) {
        if (dead) return;
        host?.classList.remove("gl");
        host = next;
        if (canvas.dataset.ready) host.classList.add("gl");
        host.prepend(canvas);
        // The host is usually added to the page right after this.
        requestAnimationFrame(update);
      },
      destroy() {
        dead = true;
        loop.destroy();
        resized.disconnect();
        window.removeEventListener("scribe:ui-fx", update);
        window.removeEventListener("scribe:theme", update);
        still.removeEventListener?.("change", update);
        host?.classList.remove("gl");
        fx.destroy();
        canvas.remove();
      },
    };
  }

  window.scribeStarFx = { create, STYLES, PICK };
})();
