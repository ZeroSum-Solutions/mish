/**
 * warp-text — clean-room implementation from the effect description only ("Type warped through a
 * shader"). The host's own words are painted, word by word at their laid-out positions, into an
 * offscreen 2D canvas; that bitmap becomes a WebGL texture and a fragment shader samples it
 * through slow, travelling sine warps with a slight RGB split and a two-colour gradient fill. With
 * `interactive`, the pointer adds a soft lens bulge. No library: raw `canvas.getContext('webgl')`.
 *
 * Accessibility: the real text stays in the DOM (only made transparent while the shader draws), so
 * it is read once, selectable and translatable; the canvas is aria-hidden. Fallbacks: without
 * WebGL or a 2D context, or when a shader fails, no canvas is added and the text shows a static
 * CSS gradient fill. Under reduced motion the canvas is hidden and the loop stops. The loop runs
 * only while the host is on screen (IntersectionObserver); destroy() stops it, loses the context
 * and removes the canvas.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-warp-text` and `data-genui-mounted`, and returns a handle
 * whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'warp-text';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const GL_CLASS = `${PREFIX}--gl`;
const CANVAS_CLASS = `${PREFIX}__canvas`;

export interface WarpTextOptions {
  [key: string]: string | number | boolean;
  /** Gradient start colour (left), as #rgb or #rrggbb. */
  from: string;
  /** Gradient end colour (right), as #rgb or #rrggbb. */
  to: string;
  /** Peak displacement of the warp, in CSS px (0–40). */
  amplitude: number;
  /** Wave count across the text (0.1–8). */
  frequency: number;
  /** Flow speed; 0 holds a still frame. */
  speed: number;
  /** RGB split, in CSS px (0–6). */
  chroma: number;
  /** A soft lens bulge follows the pointer. */
  interactive: boolean;
}

export const defaults: WarpTextOptions = {
  from: '#7dd3fc',
  to: '#c084fc',
  amplitude: 5,
  frequency: 1.5,
  speed: 1,
  chroma: 0.8,
  interactive: true,
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Parse #rgb / #rrggbb to 0..1 floats; anything else falls back to `fallback`. */
export function parseColor(color: string, fallback = defaults.from): [number, number, number] {
  const re = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
  let hex = re.exec(color.trim())?.[1] ?? re.exec(fallback)?.[1] ?? 'fff';
  if (hex.length === 3) hex = hex.replace(/./g, '$&$&');
  const n = parseInt(hex, 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Room around the text the warp may spill into, in CSS px. */
const padFor = (o: WarpTextOptions): number =>
  Math.ceil(clamp(o.amplitude, 0, 40) * (o.interactive ? 2 : 1) + clamp(o.chroma, 0, 6) + 4);

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: WarpTextOptions): Record<string, string> {
  return { from: options.from, to: options.to, pad: `${padFor(options)}px` };
}

const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
// x text texture, r canvas px, t time, f waves, c chroma px, a amplitude px, m pointer px + strength.
const FRAG = `precision mediump float;
uniform sampler2D x;uniform vec2 r,a;uniform float t,f,c;uniform vec3 m,A,B;
float S(vec2 p){return texture2D(x,p/r).a;}
void main(){vec2 p=gl_FragCoord.xy,u=p/r;float k=6.2832*f;
vec2 d=vec2(sin(u.y*k*.7+t*1.3+sin(u.x*k*.5-t)),sin(u.x*k+t*1.7+.8*sin(u.y*k*.4+t*.6)))*a;
vec2 e=p-m.xy;float g=m.z*exp(-dot(e,e)/(r.y*r.y*.12));
d=d*(1.+2.*g)-e*g*.22;vec2 q=p+d;
vec3 s=vec3(S(q+vec2(c,0.)),S(q),S(q-vec2(c,0.)));
vec3 col=mix(A,B,clamp(u.x+.12*sin(t*.7+u.y*3.),0.,1.));
gl_FragColor=vec4(col*s,max(s.r,max(s.g,s.b)));}`;

export function mount(el: HTMLElement, opts: Partial<WarpTextOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    const pad = padFor(options);

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
    const text = document.createElement('canvas');
    const ctx = text.getContext('2d');
    const attrs: WebGLContextAttributes = { antialias: false, depth: false, powerPreference: 'low-power' };
    const gl = ctx && (canvas.getContext('webgl', attrs) ?? canvas.getContext('experimental-webgl', attrs)) as WebGLRenderingContext | null;
    const program = gl && build(gl);
    if (ctx && gl && program) {
      el.append(canvas);
      el.classList.add(GL_CLASS);
      const loc = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(program, name);
      const [uR, uT, uA, uC, uM] = [loc('r'), loc('t'), loc('a'), loc('c'), loc('m')];
      gl.uniform1f(loc('f'), clamp(options.frequency, 0.1, 8));
      gl.uniform3fv(loc('A'), parseColor(options.from));
      gl.uniform3fv(loc('B'), parseColor(options.to, defaults.to));
      gl.uniform1i(loc('x'), 0);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const) {
        gl.texParameteri(gl.TEXTURE_2D, key, value);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      let ratio = 1;
      let box = el.getBoundingClientRect();
      let pointer = [0, 0, 0];
      let target = 0;
      // Paint every word of the host at its laid-out position, then upload it as the texture.
      const paint = (): void => {
        ratio = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2);
        box = el.getBoundingClientRect();
        const w = Math.max(1, Math.round((box.width + pad * 2) * ratio));
        const h = Math.max(1, Math.round((box.height + pad * 2) * ratio));
        canvas.width = text.width = w;
        canvas.height = text.height = h;
        ctx.setTransform(ratio, 0, 0, ratio, (pad - box.left) * ratio, (pad - box.top) * ratio);
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'middle';
        const walker = document.createTreeWalker(el, 4);
        const range = document.createRange();
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const parent = node.parentElement;
          if (!parent || parent === canvas) continue;
          const cs = getComputedStyle(parent);
          ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          (ctx as { letterSpacing?: string }).letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
          const value = node.nodeValue ?? '';
          for (const match of value.matchAll(/\S+/g)) {
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            const rect = typeof range.getClientRects === 'function' ? range.getClientRects()[0] : undefined;
            if (!rect) continue;
            const word = cs.textTransform === 'uppercase' ? match[0].toUpperCase() : match[0];
            ctx.fillText(word, rect.left, rect.top + rect.height / 2);
          }
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, text);
        gl.viewport(0, 0, w, h);
        gl.uniform2f(uR, w, h);
        const amp = clamp(options.amplitude, 0, 40) * ratio;
        gl.uniform2f(uA, amp, amp * 0.6);
        gl.uniform1f(uC, clamp(options.chroma, 0, 6) * ratio);
      };
      draw = (): void => {
        pointer[2] = (pointer[2] ?? 0) + (target - (pointer[2] ?? 0)) * 0.08;
        gl.uniform1f(uT, time);
        gl.uniform3fv(uM, pointer);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      };
      paint();

      const repaint = (): void => { if (draw) { paint(); if (!raf) draw(); } };
      addEventListener('resize', repaint, { passive: true, signal });
      (document as { fonts?: FontFaceSet }).fonts?.ready.then(() => { if (!signal.aborted) repaint(); }, () => {});
      if (options.interactive) {
        el.addEventListener('pointermove', (event) => {
          const rect = el.getBoundingClientRect();
          pointer = [(event.clientX - rect.left + pad) * ratio, (rect.bottom - event.clientY + pad) * ratio, pointer[2] ?? 0];
          target = 1;
        }, { passive: true, signal });
        el.addEventListener('pointerleave', () => { target = 0; }, { passive: true, signal });
      }
      canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        stop();
        draw = null;
        canvas.remove();
        el.classList.remove(GL_CLASS);
      }, { signal });
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
