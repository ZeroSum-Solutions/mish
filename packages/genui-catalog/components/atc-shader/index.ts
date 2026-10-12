/**
 * atc-shader — clean-room implementation from the effect description only ("Shader surface").
 * A living, two-tone shader surface: domain-warped fractal noise folds colour A into colour B
 * over a near-black base, and faint topographic contour lines trace the warped field so the
 * surface reads as a slow, technical map rather than a blur. With `interactive`, the pointer
 * gently pulls the warp field toward it. No library and no import beyond the shared runtime:
 * raw `canvas.getContext('webgl')` with a full-screen triangle.
 *
 * Fallbacks: the host always carries a static two-tone CSS gradient (with a very slow drift).
 * When WebGL is missing, a shader fails to compile or the context is lost, no canvas stays in
 * the DOM and that gradient is the whole effect. The render loop runs only while the host is on
 * screen (IntersectionObserver), motion is allowed and `speed > 0`; otherwise one still frame is
 * drawn. destroy() stops the loop, loses the context and removes the canvas.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-atc-shader` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'atc-shader';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const GL_CLASS = `${PREFIX}--gl`;
const CANVAS_CLASS = `${PREFIX}__canvas`;

export interface AtcShaderOptions {
  [key: string]: string | number | boolean;
  /** First surface colour, as #rgb or #rrggbb. */
  colorA: string;
  /** Second surface colour, as #rgb or #rrggbb. */
  colorB: string;
  /** Flow speed; 0 holds a still frame. */
  speed: number;
  /** Pattern scale; larger gives finer detail (0.3–6). */
  scale: number;
  /** Contour-line strength, 0–1. */
  lines: number;
  /** Film-grain amount, 0–1. */
  grain: number;
  /** Let the pointer pull the warp field toward it. */
  interactive: boolean;
}

export const defaults: AtcShaderOptions = {
  colorA: '#2f6bff',
  colorB: '#ff5fa2',
  speed: 0.5,
  scale: 1.2,
  lines: 0.4,
  grain: 0.35,
  interactive: true,
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Parse #rgb / #rrggbb to 0..1 floats; anything else falls back to `fallback`. */
export function parseColor(color: string, fallback = defaults.colorA): [number, number, number] {
  let hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1] ?? fallback.slice(1);
  if (hex.length === 3) hex = hex.replace(/./g, '$&$&');
  const n = parseInt(hex, 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The custom properties `mount` writes for a set of options (used by the CSS fallback). */
export function toVars(options: AtcShaderOptions): Record<string, string> {
  const speed = Math.max(0, options.speed);
  return {
    a: options.colorA,
    b: options.colorB,
    duration: speed > 0 ? `${Math.round(12 / speed)}s` : '0s',
  };
}

const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
// Uniforms: r resolution, m pointer (0..1), t time, s scale, l lines, g grain, a/b colours.
const FRAG = `precision mediump float;
uniform vec2 r,m;uniform float t,s,l,g;uniform vec3 a,b;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+1.),f.x),f.y);}
float F(vec2 p){float v=0.,w=.5;for(int i=0;i<5;i++){v+=w*n(p);p=p*2.03+vec2(1.7,9.2);w*=.5;}return v;}
void main(){vec2 u=(gl_FragCoord.xy-.5*r)/r.y*s*2.;
vec2 d=u-(m-.5)*vec2(r.x/r.y,1.)*s*2.;u-=d*.18*exp(-dot(d,d)*.6);
vec2 q=vec2(F(u+t*.1),F(u+vec2(5.2,1.3)-t*.08));
vec2 k=vec2(F(u+3.*q+vec2(1.7,9.2)+t*.12),F(u+3.*q+vec2(8.3,2.8)-t*.1));
float f=F(u+3.*k);
vec3 c=mix(vec3(.03,.035,.06),a,smoothstep(.2,.75,f));
c=mix(c,b,smoothstep(.35,.95,length(k-.5)*1.6)*smoothstep(.25,.6,f));
float z=abs(fract(f*11.)-.5)*2.;
c+=smoothstep(.86,1.,z)*l*.35*(.4+f);
c=c/(1.+c*.25);
c+=(h(gl_FragCoord.xy+fract(t))-.5)*g*.08;
gl_FragColor=vec4(c,1.);}`;

export function mount(el: HTMLElement, opts: Partial<AtcShaderOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));

    let reduced = false;
    let visible = true;
    let raf = 0;
    let last = 0;
    let time = 0;
    const pointer = [0.5, 0.5];
    const target = [0.5, 0.5];
    let draw: (() => void) | null = null;
    const hasRaf = typeof requestAnimationFrame === 'function';
    const stop = (): void => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    };
    const tick = (now: number): void => {
      const dt = Math.min(0.1, last ? (now - last) / 1000 : 0);
      time += dt * options.speed;
      last = now;
      // Ease the pointer toward its target so the pull never snaps.
      for (let i = 0; i < 2; i += 1) pointer[i]! += (target[i]! - pointer[i]!) * Math.min(1, dt * 3);
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
      gl.uniform1f(loc('s'), clamp(options.scale, 0.3, 6));
      gl.uniform1f(loc('l'), clamp(options.lines, 0, 1));
      gl.uniform1f(loc('g'), clamp(options.grain, 0, 1));
      gl.uniform3fv(loc('a'), parseColor(options.colorA));
      gl.uniform3fv(loc('b'), parseColor(options.colorB, defaults.colorB));
      const ratio = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 1.5);
      draw = (): void => {
        const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
        const h = Math.max(1, Math.round(canvas.clientHeight * ratio));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        gl.viewport(0, 0, w, h);
        gl.uniform2f(uR, w, h);
        gl.uniform2f(uM, pointer[0]!, pointer[1]!);
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
      if (options.interactive) {
        const aim = (x: number, y: number): void => { target[0] = x; target[1] = y; };
        el.addEventListener('pointermove', (event) => {
          const rect = el.getBoundingClientRect();
          if (rect.width && rect.height) aim((event.clientX - rect.left) / rect.width, 1 - (event.clientY - rect.top) / rect.height);
        }, { passive: true, signal });
        el.addEventListener('pointerleave', () => { aim(0.5, 0.5); }, { passive: true, signal });
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
