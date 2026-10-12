/**
 * liquid-chrome — clean-room implementation from the effect description only ("Liquid chrome
 * surface"). A sheet of molten, mirror-polished metal flows behind the host's content. A fragment
 * shader domain-warps the plane into a smooth height field, takes its normal by finite
 * differences and shades it as chrome: a sharp horizon reflection (bright sky over a dark ground)
 * plus a tight specular glint, tinted by `tint`. With `interactive`, the pointer pushes a soft
 * dent into the flow. No library and no import beyond the shared runtime: raw WebGL.
 *
 * Fallbacks: the host always carries a banded, tinted CSS chrome gradient. When WebGL is missing,
 * a shader fails to compile or the context is lost, no canvas stays in the DOM and that gradient
 * is the whole effect. The loop runs only while the host is on screen (IntersectionObserver),
 * motion is allowed and `speed > 0`; otherwise one still frame is drawn. destroy() stops the
 * loop, loses the context and removes the canvas.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-liquid-chrome` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'liquid-chrome';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const GL_CLASS = `${PREFIX}--gl`;
const CANVAS_CLASS = `${PREFIX}__canvas`;

export interface LiquidChromeOptions {
  [key: string]: string | number | boolean;
  /** Metal tint, as #rgb or #rrggbb. */
  tint: string;
  /** Flow speed; 0 holds a still frame. */
  speed: number;
  /** Warp strength: how far the surface folds (0–2). */
  amplitude: number;
  /** Ripple density; larger gives more, smaller ripples (0.2–6). */
  frequency: number;
  /** Let the pointer press a soft dent into the flow. */
  interactive: boolean;
}

export const defaults: LiquidChromeOptions = {
  tint: '#c9d2e0',
  speed: 0.5,
  amplitude: 0.7,
  frequency: 1.5,
  interactive: true,
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Parse #rgb / #rrggbb to 0..1 floats; anything else falls back to the default tint. */
export function parseColor(color: string): [number, number, number] {
  let hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1] ?? defaults.tint.slice(1);
  if (hex.length === 3) hex = hex.replace(/./g, '$&$&');
  const n = parseInt(hex, 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The custom properties `mount` writes for a set of options (used by the CSS fallback). */
export function toVars(options: LiquidChromeOptions): Record<string, string> {
  const speed = Math.max(0, options.speed);
  return {
    tint: options.tint,
    duration: speed > 0 ? `${Math.round(12 / speed)}s` : '0s',
  };
}

const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
// Uniforms: r resolution, t time, a amplitude, f frequency, c tint, m pointer (xy in uv, z weight).
const FRAG = `precision mediump float;
uniform vec2 r;uniform float t,a,f;uniform vec3 c,m;
float H(vec2 p){vec2 d=p-m.xy;p-=d*m.z*.9*exp(-dot(d,d)*3.);
for(int i=1;i<6;i++){float k=float(i);
p+=a/k*vec2(sin(k*p.y*f+t*.9+k*1.7),cos(k*p.x*f-t*.7+k*.9));}
return .5+.5*sin(p.x*1.3+p.y*.9);}
void main(){vec2 u=(gl_FragCoord.xy-.5*r)/r.y*2.;
float e=.004,h=H(u);
vec3 n=normalize(vec3(h-H(u+vec2(e,0.)),h-H(u+vec2(0.,e)),e*1.8));
float y=n.y*1.4+n.x*.35+u.y*.12;
vec3 sky=mix(vec3(.62,.66,.74),vec3(1.),smoothstep(.05,.9,y));
vec3 gnd=mix(vec3(.03,.035,.05),vec3(.32,.3,.29),smoothstep(-1.,-.05,y));
vec3 col=mix(gnd,sky,smoothstep(-.03,.03,y));
col+=pow(max(0.,dot(n,normalize(vec3(.4,.6,1.)))),60.)*.9;
col*=mix(vec3(1.),c*1.25,.75);
col*=1.-.25*dot(u*.35,u*.35);
gl_FragColor=vec4(col,1.);}`;

export function mount(el: HTMLElement, opts: Partial<LiquidChromeOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));

    let reduced = false;
    let visible = true;
    let raf = 0;
    let last = 0;
    let time = 0;
    // Pointer: target and eased position in shader space, plus the dent weight.
    const pt = [0, 0, 0];
    const pc = [0, 0, 0];
    let draw: (() => void) | null = null;
    const hasRaf = typeof requestAnimationFrame === 'function';
    const stop = (): void => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    };
    const tick = (now: number): void => {
      time += Math.min(0.1, last ? (now - last) / 1000 : 0) * options.speed;
      last = now;
      for (let i = 0; i < 3; i += 1) pc[i]! += (pt[i]! - pc[i]!) * 0.08;
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
      const [uR, uT, uM] = [loc('r'), loc('t'), loc('m')];
      gl.uniform1f(loc('a'), clamp(options.amplitude, 0, 2));
      gl.uniform1f(loc('f'), clamp(options.frequency, 0.2, 6));
      gl.uniform3fv(loc('c'), parseColor(options.tint));
      const ratio = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 1.5);
      draw = (): void => {
        const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
        const h = Math.max(1, Math.round(canvas.clientHeight * ratio));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        gl.viewport(0, 0, w, h);
        gl.uniform2f(uR, w, h);
        gl.uniform1f(uT, time + 3);
        gl.uniform3f(uM, pc[0]!, pc[1]!, pc[2]!);
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
      if (options.interactive) {
        const listen = { passive: true, signal } as const;
        // Map the pointer into the shader's space (y up, height spans -1..1), then let the loop ease to it.
        el.addEventListener('pointermove', (event) => {
          const rect = el.getBoundingClientRect();
          if (!rect.height) return;
          pt[0] = ((event.clientX - rect.left - rect.width / 2) / rect.height) * 2;
          pt[1] = ((rect.top + rect.height / 2 - event.clientY) / rect.height) * 2;
          pt[2] = 1;
        }, listen);
        el.addEventListener('pointerleave', () => { pt[2] = 0; }, listen);
      }
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
