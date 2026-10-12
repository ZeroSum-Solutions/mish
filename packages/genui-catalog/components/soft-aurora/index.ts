/**
 * soft-aurora — clean-room implementation from the effect description only ("Soft aurora wash -
 * quiet base layer"). Two soft curtains of light hang across the host and sway slowly, like a
 * faint aurora seen through haze. A fragment shader traces a wavering band line, fades light up
 * from it in a long tail and down from it in a short one, streaks it with gentle vertical rays,
 * blends the two colours along the band and dithers the result so the wash never bands. No
 * library and no import beyond the shared runtime: raw `canvas.getContext('webgl')`.
 *
 * Fallbacks: the host always carries a static CSS wash of the same two colours (with a very slow
 * drift). When WebGL is missing, a shader fails to compile or the context is lost, no canvas stays
 * in the DOM and that wash is the whole effect. The render loop runs only while the host is on
 * screen (IntersectionObserver), motion is allowed and `speed > 0`; otherwise one still frame is
 * drawn. destroy() stops the loop, loses the context and removes the canvas.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-soft-aurora` and `data-genui-mounted`, and returns a handle
 * whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'soft-aurora';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const GL_CLASS = `${PREFIX}--gl`;
const CANVAS_CLASS = `${PREFIX}__canvas`;

export interface SoftAuroraOptions {
  [key: string]: string | number | boolean;
  /** First curtain colour, as #rgb or #rrggbb. */
  colorA: string;
  /** Second curtain colour, as #rgb or #rrggbb. */
  colorB: string;
  /** Sway speed; 0 holds a still frame. */
  speed: number;
  /** Brightness of the wash, 0–1. Keep it low under text. */
  intensity: number;
  /** Height of the band line, 0 (bottom) to 1 (top). */
  height: number;
}

export const defaults: SoftAuroraOptions = {
  colorA: '#3fd8b0',
  colorB: '#7c6cf2',
  speed: 0.5,
  intensity: 0.6,
  height: 0.55,
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Parse #rgb / #rrggbb to 0..1 floats; anything else falls back to `fallback`. */
export function parseColor(color: string, fallback = defaults.colorA): [number, number, number] {
  const pick = (c: string): string | undefined => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim())?.[1];
  let hex = pick(color) ?? pick(fallback) ?? '3fd8b0';
  if (hex.length === 3) hex = hex.replace(/./g, '$&$&');
  const n = parseInt(hex, 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The custom properties `mount` writes for a set of options (used by the CSS fallback). */
export function toVars(options: SoftAuroraOptions): Record<string, string> {
  const speed = Math.max(0, options.speed);
  return {
    a: options.colorA,
    b: options.colorB,
    alpha: `${Math.round(clamp(options.intensity, 0, 1) * 100)}%`,
    y: `${Math.round((1 - clamp(options.height, 0, 1)) * 100)}%`,
    duration: speed > 0 ? `${Math.round(12 / speed)}s` : '0s',
  };
}

const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
// Uniforms: r resolution, t time, i intensity, y band height, a/b colours.
const FRAG = `precision mediump float;
uniform vec2 r;uniform float t,i,y;uniform vec3 a,b;
float h(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
float band(vec2 u,float o,float k){
float c=y+.1*sin(u.x*1.6+t*.23+o)+.05*sin(u.x*3.7-t*.31+o*2.);
float d=u.y-c;
float f=d>0.?exp(-d*d*k):exp(-d*d*k*9.);
float s=.7+.3*sin(u.x*17.+2.*sin(u.x*2.3+t*.4+o));
return f*s;}
void main(){vec2 u=gl_FragCoord.xy/r;u.x*=r.x/r.y;
float m=.5+.5*sin(u.x*1.2+t*.17);
float p=band(u,0.,7.),q=band(u,2.1,12.)*.7;
vec3 col=vec3(.043,.051,.071);
col+=(mix(a,b,m)*p+mix(b,a,m)*q)*i*.85;
col+=mix(a,b,.5)*i*.06*(1.-u.y);
col=col/(1.+col*.35);
col+=(h(gl_FragCoord.xy+fract(t))-.5)/128.;
gl_FragColor=vec4(col,1.);}`;

export function mount(el: HTMLElement, opts: Partial<SoftAuroraOptions> = {}): GenuiHandle {
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
      gl.uniform1f(loc('i'), clamp(options.intensity, 0, 1));
      gl.uniform1f(loc('y'), clamp(options.height, 0, 1));
      gl.uniform3fv(loc('a'), parseColor(options.colorA, defaults.colorA));
      gl.uniform3fv(loc('b'), parseColor(options.colorB, defaults.colorB));
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
