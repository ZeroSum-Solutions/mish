/**
 * iridescence — clean-room implementation from the effect description only ("Iridescent surface -
 * gemstone adjacent"). A slowly undulating surface fills the host behind its content, coloured by
 * thin-film interference: a fragment shader builds a soft height field, treats it as the local film
 * thickness (plus a view-angle term from the surface normal), and turns that into per-channel phase
 * with red, green and blue at different wavelengths, so bands of colour shift through the spectrum
 * the way oil on water or a cut opal does. `depth` darkens the troughs for a gem-like body, `sheen`
 * adds a specular glint that follows the pointer while `interactive` is on. No library: raw
 * `canvas.getContext('webgl')`.
 *
 * Fallbacks: the host always carries a static multi-hue CSS gradient (shifted by `hue`). When WebGL
 * is missing, a shader fails, or the context is lost, no canvas stays in the DOM and that gradient
 * is the effect. The loop runs only while the host is on screen (IntersectionObserver), motion is
 * allowed and `speed > 0`; otherwise one still frame is drawn. destroy() stops the loop, loses the
 * context and removes the canvas.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-iridescence` and `data-genui-mounted`, and returns a handle
 * whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'iridescence';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const GL_CLASS = `${PREFIX}--gl`;
const CANVAS_CLASS = `${PREFIX}__canvas`;

export interface IridescenceOptions {
  [key: string]: string | number | boolean;
  /** Flow speed; 0 holds a still frame. */
  speed: number;
  /** Size of the undulation; larger gives finer ripples. */
  scale: number;
  /** Film thickness: how many colour bands cross each swell, 0.5–8. */
  thickness: number;
  /** Rotates the whole palette, in degrees. */
  hue: number;
  /** Strength of the specular glint, 0–1. */
  sheen: number;
  /** How far the troughs darken for a gem-like body, 0–1. */
  depth: number;
  /** Move the glint toward the pointer. */
  interactive: boolean;
}

export const defaults: IridescenceOptions = {
  speed: 0.4,
  scale: 1.1,
  thickness: 1.6,
  hue: 0,
  sheen: 0.55,
  depth: 0.45,
  interactive: true,
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** The custom properties `mount` writes for a set of options (used by the CSS fallback). */
export function toVars(options: IridescenceOptions): Record<string, string> {
  return { hue: `${options.hue}deg` };
}

const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
// Uniforms: r resolution, m light point (0..1), t time, s scale, k thickness, h hue (turns),
// g sheen, d depth.
const FRAG = `precision mediump float;
uniform vec2 r,m;uniform float t,s,k,h,g,d;
float H(vec2 p){return .5*sin(p.x*1.7+t*.6+1.5*sin(p.y*1.3-t*.4))
+.35*sin(p.y*2.3-t*.5+sin(p.x*1.9+t*.3))+.15*sin((p.x+p.y)*3.1+t*.8);}
void main(){vec2 u=(gl_FragCoord.xy-.5*r)/r.y,p=u*s*2.5;float e=.01,a=H(p);
vec3 n=normalize(vec3(-(vec2(H(p+vec2(e,0.)),H(p+vec2(0.,e)))-a)/e*.2,1.));
float f=k*(a*.5+.5)+(1.-n.z)*2.5+u.x*.3;
vec3 c=.5+.5*cos(6.2832*(f*vec3(1.,1.23,1.44)+h));
c=mix(mix(c,vec3(dot(c,vec3(.33))),.18),vec3(.72,.74,.9),.15);
c*=mix(1.,.3+.7*smoothstep(-.9,.9,a),d);
vec3 L=normalize(vec3((m-.5)*vec2(r.x/r.y,1.)-u,.7));
c+=g*(pow(max(dot(reflect(-L,n),vec3(0.,0.,1.)),0.),28.)*.9+.12*pow(1.-n.z,2.)*8.);
gl_FragColor=vec4(c/(1.+c*.2),1.);}`;

export function mount(el: HTMLElement, opts: Partial<IridescenceOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));

    let reduced = false;
    let visible = true;
    let raf = 0;
    let last = 0;
    let time = 0;
    let draw: (() => void) | null = null;
    // Light point, eased toward the pointer target; starts upper-left.
    let lx = 0.3; let ly = 0.75; let tx = lx; let ty = ly;
    const hasRaf = typeof requestAnimationFrame === 'function';
    const stop = (): void => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    };
    const tick = (now: number): void => {
      time += Math.min(0.1, last ? (now - last) / 1000 : 0) * options.speed;
      last = now;
      lx += (tx - lx) * 0.06;
      ly += (ty - ly) * 0.06;
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
      const [uR, uM, uT] = [loc('r'), loc('m'), loc('t')];
      gl.uniform1f(loc('s'), clamp(options.scale, 0.2, 10));
      gl.uniform1f(loc('k'), clamp(options.thickness, 0.5, 8));
      gl.uniform1f(loc('h'), options.hue / 360);
      gl.uniform1f(loc('g'), clamp(options.sheen, 0, 1));
      gl.uniform1f(loc('d'), clamp(options.depth, 0, 1));
      const ratio = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 1.5);
      draw = (): void => {
        const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
        const h = Math.max(1, Math.round(canvas.clientHeight * ratio));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        gl.viewport(0, 0, w, h);
        gl.uniform2f(uR, w, h);
        gl.uniform2f(uM, lx, ly);
        gl.uniform1f(uT, time + 7);
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
        // Only steers the glint while the loop runs; a still frame never reacts to the pointer.
        el.addEventListener('pointermove', (event) => {
          const rect = el.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          tx = (event.clientX - rect.left) / rect.width;
          ty = 1 - (event.clientY - rect.top) / rect.height;
        }, { passive: true, signal });
        el.addEventListener('pointerleave', () => { tx = 0.3; ty = 0.75; }, { passive: true, signal });
      }
      onDestroy(() => { stop(); draw = null; gl.getExtension('WEBGL_lose_context')?.loseContext(); canvas.remove(); });

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
