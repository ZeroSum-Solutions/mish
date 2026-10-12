/**
 * shader-svg — clean-room implementation from the one-line effect description ("Shader fill inside
 * an SVG logo") only. A flowing, domain-warped colour field is rendered with raw WebGL (no shader
 * library) into a `<canvas>` that sits in a `<foreignObject>` over the logo, clipped by an SVG
 * `<clipPath>` built from clones of the logo's own shapes, so the colour flows only inside the mark.
 *
 * DOM contract: the host wraps one inline `<svg>` (with a `viewBox`). Shapes marked
 * `.genui-shader-svg__shape` form the clip; without any, every path/rect/circle/ellipse/polygon/
 * polyline/text outside `<defs>` does. Clones copy each shape's own attributes (and map
 * `fill-rule` to `clip-rule`), not transforms inherited from a parent `<g>`; strokes do not clip.
 *
 * - No WebGL (getContext returns null, or the context is lost): the canvas becomes a static CSS
 *   gradient in the same palette, clipped the same way.
 * - The rAF loop runs only while the host is on screen (IntersectionObserver) and motion is allowed;
 *   reduced motion draws one still frame. destroy() stops the loop, loses the context and removes
 *   every added node, so `el.outerHTML` is restored exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'shader-svg';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const READY_CLASS = `${PREFIX}--ready`;
const SVG_NS = 'http://www.w3.org/2000/svg';
const SHAPES = 'path,rect,circle,ellipse,polygon,polyline,text';

export interface ShaderSvgOptions {
  [key: string]: string | number | boolean;
  colorA: string;
  colorB: string;
  colorC: string;
  /** Flow speed multiplier; 0 holds a still frame. */
  speed: number;
  /** Pattern zoom; larger values give tighter swirls. */
  scale: number;
  /** Main flow direction, in degrees. */
  angle: number;
}

export const defaults: ShaderSvgOptions = {
  colorA: '#6d5dfc',
  colorB: '#22d3ee',
  colorC: '#f472b6',
  speed: 1,
  scale: 1.4,
  angle: 135,
};

/** The custom properties `mount` writes (they drive the fallback gradient). */
export function toVars(options: ShaderSvgOptions): Record<string, string> {
  return { a: options.colorA, b: options.colorB, c: options.colorC, angle: `${options.angle}deg` };
}

/** `#rgb` / `#rrggbb` to 0..1 channels, or null. */
export function hexToRgb(value: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  let hex = match[1]!;
  if (hex.length === 3) hex = hex.replace(/./g, '$&$&');
  const n = parseInt(hex, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const VERTEX = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
const FRAGMENT = `precision mediump float;
uniform vec2 r;uniform float t,s,g;uniform vec3 a,b,c;
void main(){
vec2 p=(gl_FragCoord.xy-.5*r)/min(r.x,r.y)*s*2.;
vec2 d=vec2(cos(g),sin(g));
for(int i=1;i<5;i++){float f=float(i);p+=vec2(sin(p.y*f*.9+t*f*.6),cos(p.x*f*.7-t*f*.5))*.4/f;}
float k=.5+.5*sin(dot(p,d)*1.7+t*.8);
float m=smoothstep(.35,1.,.5+.5*sin(p.x*1.3-p.y*1.1+t*1.1));
vec3 col=mix(mix(a,b,k),c,m*.85);
col+=.07*sin(p.x*5.+p.y*3.+t*1.6);
gl_FragColor=vec4(col,1.);}`;

type Draw = ((time: number) => void) & { lose(): void };

function createRenderer(canvas: HTMLCanvasElement, options: ShaderSvgOptions): Draw | null {
  let gl: WebGLRenderingContext | null = null;
  try { gl = canvas.getContext('webgl', { antialias: false }) as WebGLRenderingContext | null; } catch { gl = null; }
  if (!gl) return null;
  const program = gl.createProgram();
  if (!program) return null;
  const add = (type: number, source: string): void => {
    const shader = gl.createShader(type);
    if (!shader) return;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  };
  add(gl.VERTEX_SHADER, VERTEX);
  add(gl.FRAGMENT_SHADER, FRAGMENT);
  gl.bindAttribLocation(program, 0, 'p');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const at = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(program, name);
  const colour = (name: string, value: string, fallback: string): void => {
    const [x, y, z] = hexToRgb(value) ?? hexToRgb(fallback)!;
    gl.uniform3f(at(name), x, y, z);
  };
  colour('a', options.colorA, defaults.colorA);
  colour('b', options.colorB, defaults.colorB);
  colour('c', options.colorC, defaults.colorC);
  gl.uniform1f(at('s'), Math.max(0.1, options.scale));
  // CSS angles run clockwise from "up"; GL y points up, so this matches the fallback gradient.
  gl.uniform1f(at('g'), ((90 - options.angle) * Math.PI) / 180);
  const uRes = at('r');
  const uTime = at('t');
  const draw = ((time: number) => {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }) as Draw;
  draw.lose = () => { gl.getExtension('WEBGL_lose_context')?.loseContext(); };
  return draw;
}

let uid = 0;

export function mount(el: HTMLElement, opts: Partial<ShaderSvgOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    let sync = (): void => {};
    const motion = watchReducedMotion(signal, (reduced) => {
      el.classList.toggle(REDUCED_CLASS, reduced);
      sync();
    });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);

    const svg = el.querySelector('svg');
    if (!svg) return;
    const make = (tag: string): SVGElement => document.createElementNS(SVG_NS, tag) as SVGElement;
    const clipId = `${PREFIX}-clip-${(uid += 1)}`;
    const defs = make('defs');
    const clip = make('clipPath');
    clip.setAttribute('id', clipId);
    let shapes = svg.querySelectorAll(`.${PREFIX}__shape`);
    if (shapes.length === 0) shapes = svg.querySelectorAll(SHAPES);
    for (const shape of Array.from(shapes)) {
      if (shape.closest('defs,clipPath,mask,symbol,pattern,marker')) continue;
      const copy = shape.cloneNode(true) as Element;
      copy.removeAttribute('id');
      copy.removeAttribute('class');
      const rule = shape.getAttribute('fill-rule');
      if (rule) copy.setAttribute('clip-rule', rule);
      clip.append(copy);
    }
    defs.append(clip);

    const fx = make('foreignObject');
    const box = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    const [x, y, w, h] = box.length === 4 && box.every(Number.isFinite) ? box : [0, 0, '100%', '100%'];
    fx.setAttribute('x', String(x));
    fx.setAttribute('y', String(y));
    fx.setAttribute('width', String(w));
    fx.setAttribute('height', String(h));
    fx.setAttribute('class', `${PREFIX}__fx`);
    fx.setAttribute('aria-hidden', 'true');
    fx.setAttribute('clip-path', `url(#${clipId})`);

    const fallback = (): HTMLElement => {
      const div = document.createElement('div');
      div.className = `${PREFIX}__fallback`;
      return div;
    };
    const canvas = document.createElement('canvas');
    canvas.className = `${PREFIX}__canvas`;
    let draw = createRenderer(canvas, options);
    fx.append(draw ? canvas : fallback());
    svg.append(defs, fx);
    onDestroy(() => { defs.remove(); fx.remove(); });
    const ready = (): void => { el.classList.add(READY_CLASS); };
    if (!draw) { ready(); return; }

    const hasRaf = typeof requestAnimationFrame === 'function';
    let raf = 0;
    let last = 0;
    let time = 0;
    let visible = typeof IntersectionObserver !== 'function';

    const resize = (): void => {
      const rect = svg.getBoundingClientRect();
      const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
      canvas.width = Math.max(1, Math.min(2048, Math.round(rect.width * dpr)));
      canvas.height = Math.max(1, Math.min(2048, Math.round(rect.height * dpr)));
    };
    const stop = (): void => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    };
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      if (last) time += (Math.min(100, now - last) / 1000) * Math.max(0, options.speed);
      last = now;
      draw?.(time);
      ready();
    };
    sync = (): void => {
      if (!draw) return;
      if (visible && !motion.reduced && hasRaf) {
        if (!raf) raf = requestAnimationFrame(tick);
        return;
      }
      stop();
      draw(time); // one still frame: the reduced-motion and off-screen state
      ready();
    };

    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      stop();
      draw = null;
      canvas.replaceWith(fallback());
    }, { signal });

    resize();
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => { resize(); if (!raf) draw?.(time); });
      ro.observe(svg);
      onDestroy(() => { ro.disconnect(); });
    }
    if (!visible) {
      const io = new IntersectionObserver(([entry]) => {
        visible = entry?.isIntersecting ?? false;
        sync();
      });
      io.observe(el);
      onDestroy(() => { io.disconnect(); });
    }
    onDestroy(() => {
      stop();
      draw?.lose();
      draw = null;
    });
    sync();
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default { id, mount, autoInit };
