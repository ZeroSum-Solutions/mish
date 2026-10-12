/**
 * silk — clean-room implementation from the effect description only ("Quiet flowing texture -
 * safe base layer"). A slow, low-contrast sheet of folded fabric drifts behind the host's content.
 * A fragment shader bends a set of diagonal folds with a gentle sine warp, shades them softly,
 * adds a narrow sheen along each crest and a fine film grain so the gradient never bands. No
 * library and no import beyond the shared runtime: raw `canvas.getContext('webgl')`.
 *
 * Fallbacks: the host always carries a static, tinted CSS gradient (with a very slow drift). When
 * WebGL is missing, a shader fails to compile or the context is lost, no canvas stays in the DOM
 * and that gradient is the whole effect. The render loop runs only while the host is on screen
 * (IntersectionObserver), motion is allowed and `speed > 0`; otherwise one still frame is drawn.
 * destroy() stops the loop, loses the context and removes the canvas.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-silk` and `data-genui-mounted`, and returns a handle whose
 * `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'silk';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const GL_CLASS = `${PREFIX}--gl`;
const CANVAS_CLASS = `${PREFIX}__canvas`;

export interface SilkOptions {
  [key: string]: string | number | boolean;
  /** Fabric colour, as #rgb or #rrggbb. */
  color: string;
  /** Flow speed; 0 holds a still frame. */
  speed: number;
  /** Fold density; larger gives more, narrower folds (0.2–8). */
  scale: number;
  /** Direction of the folds, in degrees. */
  rotation: number;
  /** Film-grain amount, 0–1. */
  noise: number;
}

export const defaults: SilkOptions = {
  color: '#7a6fb0',
  speed: 0.6,
  scale: 1,
  rotation: 0,
  noise: 0.5,
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Parse #rgb / #rrggbb to 0..1 floats; anything else falls back to the default colour. */
export function parseColor(color: string): [number, number, number] {
  let hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1] ?? defaults.color.slice(1);
  if (hex.length === 3) hex = hex.replace(/./g, '$&$&');
  const n = parseInt(hex, 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The custom properties `mount` writes for a set of options (used by the CSS fallback). */
export function toVars(options: SilkOptions): Record<string, string> {
  const speed = Math.max(0, options.speed);
  return {
    color: options.color,
    angle: `${options.rotation}deg`,
    duration: speed > 0 ? `${Math.round(18 / speed)}s` : '0s',
  };
}

const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
// Uniforms: r resolution, t time, s fold scale, a rotation (rad), n grain, c colour.
const FRAG = `precision mediump float;
uniform vec2 r;uniform float t,s,a,n;uniform vec3 c;
float h(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
void main(){vec2 u=(gl_FragCoord.xy-.5*r)/r.y*s*1.6;
float q=cos(a),w=sin(a);u=mat2(q,w,-w,q)*u;
u.y+=.3*sin(u.x*1.4+t*.5)+.12*sin(u.x*2.9-t*.35);
float f=u.x*1.3+u.y*4.+t*.6+.9*sin(u.x*1.1-u.y*.7+t*.25);
float l=.5+.5*sin(f);
float k=pow(.5+.5*sin(f+.7),14.);
float v=.3+.75*l*l+.05*u.y;
vec3 col=c*v+k*.22*mix(vec3(1.),c,.35);
col=col/(1.+col*.2);
col+=(h(gl_FragCoord.xy+fract(t))-.5)*n*.07;
gl_FragColor=vec4(col,1.);}`;

export function mount(el: HTMLElement, opts: Partial<SilkOptions> = {}): GenuiHandle {
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
      gl.uniform1f(loc('s'), clamp(options.scale, 0.2, 8));
      gl.uniform1f(loc('a'), (options.rotation * Math.PI) / 180);
      gl.uniform1f(loc('n'), clamp(options.noise, 0, 1));
      gl.uniform3fv(loc('c'), parseColor(options.color));
      const ratio = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 1.5);
      draw = (): void => {
        const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
        const h = Math.max(1, Math.round(canvas.clientHeight * ratio));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        gl.viewport(0, 0, w, h);
        gl.uniform2f(uR, w, h);
        gl.uniform1f(uT, time + 2);
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
