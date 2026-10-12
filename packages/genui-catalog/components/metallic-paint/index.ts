/**
 * metallic-paint — clean-room implementation from the effect description only ("WebGL metal
 * shader. Uniforms: refract, fresnel, chroma, tint"). A slow-flowing liquid-metal surface fills
 * the host behind its content. A fragment shader builds a domain-warped height field, derives a
 * surface normal from it, and reflects a banded studio-light environment off that normal:
 * `refract` sets how far the relief bends the reflection, `fresnel` brightens grazing angles,
 * `chroma` splits the lookup per colour channel for a thin-film fringe, and `tint` colours the
 * metal. No library and no import beyond the shared runtime: raw `canvas.getContext('webgl')`.
 *
 * Fallbacks: the host always carries a static, tinted CSS gradient. When WebGL is missing (or a
 * shader fails to compile, or the context is lost) no canvas stays in the DOM and that gradient is
 * the whole effect. The render loop runs only while the host is on screen (IntersectionObserver),
 * motion is allowed and `speed > 0`; otherwise one still frame is drawn. destroy() stops the loop,
 * loses the context and removes the canvas.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-metallic-paint` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'metallic-paint';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const GL_CLASS = `${PREFIX}--gl`;
const CANVAS_CLASS = `${PREFIX}__canvas`;

export interface MetallicPaintOptions {
  [key: string]: string | number | boolean;
  /** How far the surface relief bends the reflected light, 0–2. */
  refract: number;
  /** Rim brightening at grazing angles, 0–3. */
  fresnel: number;
  /** Per-channel split of the reflection (thin-film fringe), 0–1. */
  chroma: number;
  /** Metal colour, as #rgb or #rrggbb. */
  tint: string;
  /** Flow speed; 0 holds a still frame. */
  speed: number;
  /** Size of the flow pattern; larger means finer ripples. */
  scale: number;
}

export const defaults: MetallicPaintOptions = {
  refract: 0.7,
  fresnel: 1.2,
  chroma: 0.25,
  tint: '#c9d2de',
  speed: 0.5,
  scale: 2.2,
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Parse #rgb / #rrggbb to 0..1 floats; anything else falls back to the default tint. */
export function parseTint(tint: string): [number, number, number] {
  let hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(tint.trim())?.[1] ?? defaults.tint.slice(1);
  if (hex.length === 3) hex = hex.replace(/./g, '$&$&');
  const n = parseInt(hex, 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The custom properties `mount` writes for a set of options (used by the CSS fallback). */
export function toVars(options: MetallicPaintOptions): Record<string, string> {
  const speed = Math.max(0, options.speed);
  return {
    tint: options.tint,
    duration: speed > 0 ? `${Math.round(12 / speed)}s` : '0s',
  };
}

const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
// Uniforms: r resolution, t time, s pattern scale, rf refract, fr fresnel, ch chroma, tn tint.
const FRAG = `precision mediump float;
uniform vec2 r;uniform float t,s,rf,fr,ch;uniform vec3 tn;
float f(vec2 p){p*=s;
p+=.9*vec2(sin(p.y*1.3+t*.7),cos(p.x*1.1-t*.5));
p+=.5*vec2(cos(p.y*2.1-t*.4),sin(p.x*1.7+t*.6));
return .5*sin(p.x+sin(p.y*1.7+t))+.5*cos(p.y*1.3-p.x*.6+t*.8);}
float E(float v){return .1+.85*pow(.5+.5*sin(v*6.2832),4.)+.3*smoothstep(-.6,1.2,v);}
void main(){vec2 u=gl_FragCoord.xy/r.y;float e=.003;
float a=f(u),b=f(u+vec2(e,0.)),c=f(u+vec2(0.,e));
vec3 n=normalize(vec3(vec2(a-b,a-c)/e*.12*(.15+rf),1.));
vec3 R=reflect(vec3(0.,0.,-1.),n);
float v=u.y*.35+R.y*(.4+rf)+R.x*.2+a*.25*rf;float k=ch*.15;
vec3 col=vec3(E(v-k),E(v),E(v+k));
float F=pow(1.-n.z,2.)*fr*4.;
col=col*tn*1.15+F*mix(vec3(1.),tn,.4);
col=col/(1.+col*.25);
gl_FragColor=vec4(col,1.);}`;

export function mount(el: HTMLElement, opts: Partial<MetallicPaintOptions> = {}): GenuiHandle {
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
      gl.uniform1f(loc('s'), clamp(options.scale, 0.2, 12));
      gl.uniform1f(loc('rf'), clamp(options.refract, 0, 2));
      gl.uniform1f(loc('fr'), clamp(options.fresnel, 0, 3));
      gl.uniform1f(loc('ch'), clamp(options.chroma, 0, 1));
      gl.uniform3fv(loc('tn'), parseTint(options.tint));
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
      const lose = (): void => { gl.getExtension('WEBGL_lose_context')?.loseContext(); };
      canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        stop();
        draw = null;
        canvas.remove();
        el.classList.remove(GL_CLASS);
      }, { signal });
      addEventListener('resize', () => { if (!raf) draw?.(); }, { passive: true, signal });
      onDestroy(() => { stop(); draw = null; lose(); canvas.remove(); });

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

/** Compile the full-screen triangle program; null (and nothing left bound) on any failure. */
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
