/**
 * fluid-glass — clean-room implementation from the effect description ("WebGL glass lens. Modes:
 * lens, bar, cube") only. No three.js: one fragment shader on a raw WebGL 1 context draws a soft
 * banded backdrop in `colorA`/`colorB` and a glass shape over it that refracts (magnifies and
 * bends, with a chromatic split and a bright fresnel rim) the backdrop beneath. `mode` picks the
 * shape: a round `lens`, a capsule `bar` or a slowly turning bevelled `cube`. The shape follows
 * the pointer (`followPointer`) and drifts on its own otherwise.
 *
 * The host's own children sit above the canvas and are never touched. When `getContext` returns
 * null (jsdom, WebGL off), no canvas is added and the stylesheet's static gradient plus a CSS
 * glass shape stand in. The rAF loop runs only while the host is on screen (IntersectionObserver)
 * and never under reduced motion, which renders one still frame instead.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-fluid-glass` and `data-genui-mounted`, and returns a handle
 * whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'fluid-glass';
const PREFIX = `genui-${id}`;
const MODES = ['lens', 'bar', 'cube'] as const;

export interface FluidGlassOptions {
  [key: string]: string | number | boolean;
  /** Glass shape: `lens`, `bar` or `cube`. */
  mode: string;
  /** Lens radius (half height for `bar` and `cube`), in px. */
  size: number;
  /** Refraction strength, 0–1.5. */
  refraction: number;
  /** Chromatic split at the rim, 0–1. */
  chromatic: number;
  colorA: string;
  colorB: string;
  /** Steer the glass with the pointer; otherwise it only drifts. */
  followPointer: boolean;
  /** Time scale of the drift and backdrop motion. */
  speed: number;
}

export const defaults: FluidGlassOptions = {
  mode: 'lens',
  size: 64,
  refraction: 0.7,
  chromatic: 0.4,
  colorA: '#4f7cff',
  colorB: '#c26bff',
  followPointer: true,
  speed: 1,
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The index of `mode` in lens/bar/cube; unknown strings fall back to lens. */
export function modeIndex(mode: string): number {
  return Math.max(0, (MODES as readonly string[]).indexOf(mode));
}

/** `#rgb` / `#rrggbb` to 0–1 floats; anything unparsable is black. */
export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.replace(/./g, '$&$&');
  const n = /^[\da-f]{6}$/i.test(h) ? parseInt(h, 16) : 0;
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

/** The custom properties `mount` writes for a set of options (used by the static fallback). */
export function toVars(options: FluidGlassOptions): Record<string, string> {
  return { size: `${Math.max(0, options.size)}px`, a: options.colorA, b: options.colorB };
}

const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
const FRAG = `precision mediump float;
uniform vec2 R,P;uniform float T,S,M,K,C;uniform vec3 A,B;
float sd(vec2 q){
if(M>1.5){float a=T*.35;q=mat2(cos(a),-sin(a),sin(a),cos(a))*q;vec2 d=abs(q)-vec2(S*.78);return length(max(d,0.))+min(max(d.x,d.y),0.)-S*.22;}
if(M>.5){vec2 d=abs(q)-vec2(S*1.25,0.);return length(max(d,0.))-S*.5;}
return length(q)-S;}
vec3 sc(vec2 u){
float s=sin(u.x*7.+u.y*3.+T*.3)+.6*sin(u.y*11.-u.x*2.-T*.45);
vec3 c=mix(A,B,.5+.5*sin(u.x*2.3-u.y*1.7+T*.2))*(.22+.34*smoothstep(-.3,.9,s));
vec2 g=abs(fract(u*9.)-.5);
return c+.045*smoothstep(.46,.5,max(g.x,g.y));}
void main(){
vec2 f=gl_FragCoord.xy,q=f-P;
float d=sd(q);
vec3 o=sc(f/R.y)*(1.-.4*exp(-max(sd(q+vec2(0.,S*.14)),0.)/(S*.3)));
if(d<1.){
vec2 n=normalize(vec2(sd(q+vec2(1.,0.))-d,sd(q+vec2(0.,1.))-d)+1e-5);
float b=M>1.5?S*.3:M>.5?S*.5:S,t=clamp(-d/b,0.,1.),h=sqrt(1.-(1.-t)*(1.-t)),l=(1.-t)/max(h,.08);
vec2 z=P+q*(1.-.28*K),w=-n*l*K*S*.3;
vec3 i=vec3(sc((z+w*(1.+C))/R.y).r,sc((z+w)/R.y).g,sc((z+w*(1.-C))/R.y).b)*1.25+.035;
vec3 N=normalize(vec3(-n*l*.6,1.));
i+=pow(max(dot(reflect(normalize(vec3(.45,-.6,-.8)),N),vec3(0.,0.,1.)),0.),30.)*.8+pow(1.-t,5.)*.4+.3*smoothstep(1.5,0.,abs(d));
o=mix(o,i,smoothstep(1.,-1.,d));}
gl_FragColor=vec4(o,1.);}`;

type GL = WebGLRenderingContext;

function program(gl: GL): WebGLProgram | null {
  const prog = gl.createProgram();
  if (!prog) return null;
  for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]] as const) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    gl.attachShader(prog, shader);
  }
  gl.linkProgram(prog);
  return gl.getProgramParameter(prog, gl.LINK_STATUS) ? prog : null;
}

export function mount(el: HTMLElement, opts: Partial<FluidGlassOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    const mode = modeIndex(options.mode);
    setVars(el, PREFIX, toVars(options));
    if (mode) el.classList.add(`${PREFIX}--${MODES[mode]}`);

    let raf = 0;
    let visible = typeof IntersectionObserver !== 'function';
    const stop = (): void => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    };
    let sync = (): void => {};
    const motion = watchReducedMotion(signal, (reduced) => {
      el.classList.toggle(`${PREFIX}--reduced`, reduced);
      sync();
    });
    el.classList.toggle(`${PREFIX}--reduced`, motion.reduced);

    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false });
    const prog = gl && program(gl);
    if (!gl || !prog) {
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      return; // static CSS gradient and glass shape stay in place.
    }
    canvas.className = `${PREFIX}__canvas`;
    canvas.setAttribute('aria-hidden', 'true');
    el.prepend(canvas);
    el.classList.add(`${PREFIX}--gl`);
    onDestroy(() => {
      stop();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
    });

    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(prog, name);
    gl.uniform3fv(u('A'), hexToRgb(options.colorA));
    gl.uniform3fv(u('B'), hexToRgb(options.colorB));
    gl.uniform1f(u('M'), mode);
    gl.uniform1f(u('K'), clamp(options.refraction, 0, 1.5));
    gl.uniform1f(u('C'), clamp(options.chromatic, 0, 1) * 0.12);
    const [uR, uP, uT, uS] = ['R', 'P', 'T', 'S'].map(u);

    // Glass position in CSS px (top-left origin); `pointer` is null when the glass drifts freely.
    let x = -1; let y = 0; let last = 0; let time = 0;
    let pointer: [number, number] | null = null;

    const draw = (now: number): void => {
      const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2);
      const w = el.clientWidth; const h = el.clientHeight;
      const cw = Math.max(1, Math.round(w * dpr)); const ch = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
      last = now;
      time += dt * Math.max(0, options.speed);
      const size = Math.min(Math.max(0, options.size), Math.min(w, h) * 0.42);
      // Free drift keeps the whole shape inside the host (the bar is wider than it is tall).
      const reachX = motion.reduced ? 0 : Math.max(0, w / 2 - size * (mode === 1 ? 1.8 : 1.1));
      const reachY = motion.reduced ? 0 : Math.max(0, h / 2 - size * 1.1);
      const [tx, ty] = pointer ?? [w / 2 + reachX * Math.cos(time * 0.45), h / 2 + reachY * Math.sin(time * 0.7)];
      const ease = x < 0 || motion.reduced ? 1 : 1 - Math.exp(-dt * 7);
      x += (tx - x) * ease; y += (ty - y) * ease;
      gl.viewport(0, 0, cw, ch);
      gl.uniform2f(uR!, cw, ch);
      gl.uniform2f(uP!, x * dpr, (h - y) * dpr);
      gl.uniform1f(uT!, time);
      gl.uniform1f(uS!, size * dpr);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const frame = (now: number): void => {
      raf = 0;
      draw(now);
      sync();
    };
    sync = () => {
      if (motion.reduced || !visible || typeof requestAnimationFrame !== 'function') {
        stop();
        last = 0;
        if (motion.reduced) { pointer = null; draw(0); }
      } else if (!raf) {
        raf = requestAnimationFrame(frame);
      }
    };

    if (options.followPointer) {
      const listen = { passive: true, signal } as const;
      el.addEventListener('pointermove', (event) => {
        if (motion.reduced) return;
        const rect = el.getBoundingClientRect();
        pointer = [event.clientX - rect.left, event.clientY - rect.top];
      }, listen);
      el.addEventListener('pointerleave', () => { pointer = null; }, listen);
    }

    draw(0);
    if (!visible) {
      const io = new IntersectionObserver(([entry]) => {
        visible = !!entry?.isIntersecting;
        sync();
      });
      io.observe(el);
      onDestroy(() => { io.disconnect(); });
    }
    sync();
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default autoInit;
