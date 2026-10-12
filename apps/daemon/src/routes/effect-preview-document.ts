import { findRealTagOffset } from '@mish/contracts/runtime/html-injection-points';
import { PREVIEW_CONTENT_SIZE_REPORTER } from '../preview-content-size.js';

// The frame has an opaque origin. Only fixed keyboard and content-size messages cross the
// boundary; the host checks their Window source and opaque origin before handling them.
// One script element carries both bridges; the demo CSP allows its inline script.
const KEYBOARD_BRIDGE = `document.addEventListener("keydown",function(e){
if(e.key==="Escape"){e.preventDefault();parent.postMessage({type:"mishh-effect-preview-escape"},"*");return}
if(e.key!=="Tab"||e.altKey||e.ctrlKey||e.metaKey)return;
var nodes=Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')).filter(function(n){return !n.disabled&&n.tabIndex>=0&&!n.closest('[hidden],[aria-hidden="true"]')&&getComputedStyle(n).display!=="none"&&getComputedStyle(n).visibility!=="hidden"});
if(!nodes.length||(e.shiftKey&&document.activeElement===nodes[0])||(!e.shiftKey&&document.activeElement===nodes[nodes.length-1])){e.preventDefault();parent.postMessage({type:"mishh-effect-preview-tab",backward:e.shiftKey},"*")}
})`;

// The demo body is the content root. Measuring starts after load, once the component script ran.
const SIZE_BRIDGE = `(function(){var start=(${PREVIEW_CONTENT_SIZE_REPORTER})(function(width,height){parent.postMessage({type:"mishh-effect-preview-size",width:width,height:height},"*")},null);
if(document.readyState==="complete")start();else addEventListener("load",start);})()`;

const BRIDGE = `<script>${KEYBOARD_BRIDGE};${SIZE_BRIDGE}</script>`;

export function effectPreviewDocument(html: string): string {
  const offset = findRealTagOffset(html, /<\/body(?=[\s/>])/i);
  return offset < 0 ? html + BRIDGE : html.slice(0, offset) + BRIDGE + html.slice(offset);
}
