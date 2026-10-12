/**
 * molten-metal — clean-room implementation from the effect description only ("Molten metal
 * surface"). A slowly churning sheet of liquid metal: a domain-warped value-noise height field is
 * shaded as polished metal (a fake environment reflection from the surface normal plus a tight
 * specular glint), and the lowest troughs glow with incandescent heat that cools from white-hot
 * through orange to deep red. No library and no import beyond the shared runtime: raw
 * `canvas.getContext('webgl')`.
 *
 * Fallbacks: the host always carries a static CSS gradient of dark steel with glowing heat pools
 * (and a very slow drift). When WebGL is missing, a shader fails to compile or the context is
 * lost, no canvas stays in the DOM and that gradient is the whole effect. The render loop runs
 * only while the host is on screen (IntersectionObserver), motion is allowed and `speed > 0`;
 * otherwise one still frame is drawn. destroy() stops the loop, loses the context and removes the
 * canvas.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-molten-metal` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'molten-metal';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const GL_CLASS = `${PREFIX}--gl`;
const CANVAS_CLASS = `${PREFIX}__canvas`;

export interface MoltenMetalOptions {
  [key: string]: string | number | boolean;
  /** Surface metal tint, as #rgb or #rrggbb. */
  metal: string;
  /** Heat glow colour, as #rgb or #rrggbb. */
  glow: string;
  /** Churn speed; 0 holds a still frame. */
  speed: number;
  /** Ripple size; larger gives more, smaller ripples (0.2–6). */
  scale: number;
  /** How much of the surface glows, 0–1. */
  heat: number;
}

export const defaults: MoltenMetalOptions = {
  metal: '#9aa3b5',
  glow: '#ff6a1f',
  speed: 0.5,
  scale: 1,
  heat: 0.5,
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Parse #rgb / #rrggbb to 0..1 floats; anything else falls back to `fallback`. */
export function parseColor(color: string, fallback: string = defaults.metal): [number, number, number] {
  let hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1] ?? fallback.slice(1);
  if (hex.length === 3) hex = hex.replace(/./g, '$&$&');
  const n = parseInt(hex, 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The custom properties `mount` writes for a set of options (used by the CSS fallback). */
export function toVars(options: MoltenMetalOptions): Record<string, string> {
  const speed = Math.max(0, options.speed);
  return {
    metal: options.metal,
    glow: options.glow,
    heat: `${Math.round(clamp(options.heat, 0, 1) * 100)}%`,
    duration: speed > 0 ? `${Math.round(12 / speed)}s` : '0s',
  };
}

const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
// Uniforms: r resolution, t time, s scale, k heat, m metal tint, g glow colour.
const FRAG = `precision mediump float;
uniform vec2 r;uniform float t,s,k;uniform vec3 m,g;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+1.),f.x),f.y);}
float b(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*n(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}
float H(vec2 p){vec2 q=vec2(b(p+vec2(0,t*.12)),b(p+vec2(5.2,1.3)-t*.09));
return b(p+2.2*q+vec2(t*.05,-t*.04));}
void main(){vec2 u=(gl_FragCoord.xy-.5*r)/r.y*s*1.7;
float e=.02,c=H(u);
vec3 N=normalize(vec3((H(u+vec2(e,0))-c)/e,(H(u+vec2(0,e))-c)/e,2.4));
vec3 R=reflect(vec3(0,0,-1),N);
float env=.5+.5*R.y;
vec3 col=m*(.12+.75*env*env)+pow(max(0.,dot(R,normalize(vec3(.4,.6,.7)))),40.)*.9;
float w=1.-smoothstep(.3-k*.2,.62-k*.3,c);
float z=clamp(w*k*1.6,0.,1.);
vec3 hot=mix(g*g*.6,g*1.7,z);hot=mix(hot,vec3(1.,.92,.7),z*z*z);
col=col*(1.-z)+hot*z;
col=col/(1.+col*.25);
col+=(h(gl_FragCoord.xy+fract(t))-.5)*.03;
gl_FragColor=vec4(col,1.);}`;

export function mount(el: HTMLElement, opts: Partial<MoltenMetalOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));

    let reduced = false;
    let visible = true;
    let raf = 0;
    let last = 0;
    let time = 0;
    let draw: (() => void) | null = null;
    const hasRaf = typeof requestAnimationFrame === 'function';
    const stop = (): void => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    };
    const tick = (now: number): void => {
      time += Math.min(0.1, last ? (now - last) / 1000 : 0) * options.speed;
      last = now;
      draw?.();
      raf = requestAnimationFrame(tick);
    };
    // Start or stop the loop to match state; draw one still frame whenever it is not running.
    const sync = (): void => {
      el.classList.toggle(REDUCED_CLASS, reduced);
      if (draw && hasRaf && visible && !reduced && options.speed > 0) {
        if (!raf) { last = 0; raf = requestAnimationFrame(tick); }
      } else {
        stop();
        draw?.();
      }
    };

    const motion = watchReducedMotion(signal, (value) => { reduced = value; sync(); });
    reduced = motion.reduced;
    onDestroy(stop);

    const canvas = document.createElement('canvas');
    canvas.className = CANVAS_CLASS;
    canvas.setAttribute('aria-hidden', 'true');
    const attrs: WebGLContextAttributes = { antialias: false, depth: false, powerPreference: 'low-power' };
    const gl = (canvas.getContext('webgl', attrs) ?? canvas.getContext('experimental-webgl', attrs)) as WebGLRenderingContext | null;
    const program = gl && build(gl);
    if (gl && program) {
      el.prepend(canvas);
      el.classList.add(GL_CLASS);
      const loc = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(program, name);
      const [uR, uT] = [loc('r'), loc('t')];
      gl.uniform1f(loc('s'), clamp(options.scale, 0.2, 6));
      gl.uniform1f(loc('k'), clamp(options.heat, 0, 1));
      gl.uniform3fv(loc('m'), parseColor(options.metal));
      gl.uniform3fv(loc('g'), parseColor(options.glow, defaults.glow));
      const ratio = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 1.5);
      draw = (): void => {
        const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
        const h = Math.max(1, Math.round(canvas.clientHeight * ratio));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        gl.viewport(0, 0, w, h);
        gl.uniform2f(uR, w, h);
        gl.uniform1f(uT, time + 3);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      };
      canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        stop();
        draw = null;
        canvas.remove();
        el.classList.remove(GL_CLASS);
      }, { signal });
      addEventListener('resize', () => { if (!raf) draw?.(); }, { passive: true, signal });
      onDestroy(() => {
        stop();
        draw = null;
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        canvas.remove();
      });

      if (typeof IntersectionObserver === 'function') {
        const io = new IntersectionObserver(([entry]) => {
          visible = !!entry?.isIntersecting;
          if (visible) sync(); else stop();
        });
        io.observe(el);
        onDestroy(() => { io.disconnect(); });
      }
    }
    sync();
  });
}

/** Compile the full-screen triangle program; null on any failure. */
function build(gl: WebGLRenderingContext): WebGLProgram | null {
  const program = gl.createProgram();
  if (!program) return null;
  for (const [type, source] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]] as const) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return null;
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const at = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(at);
  gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
  return program;
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default { id, mount, autoInit };
