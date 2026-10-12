import { CULT_PREVIEW_MESSAGE_SOURCE } from '@open-design/contracts';
import { findRealTagOffset, HTML_TAG_PATTERNS } from '@open-design/contracts/runtime/html-injection-points';
import { PREVIEW_CONTENT_SIZE_REPORTER } from './preview-content-size.js';

/**
 * The private harness waits for two animation frames before reporting paint. Browsers can
 * suspend those callbacks in inactive frames. Keep readiness owned by the served document:
 * actual visible content, stable across timer probes, with no animation-frame dependency.
 * The frame remains opaque and script-only; the parent validates the sending frame window.
 */
const READINESS_SCRIPT = `<script data-cult-readiness>(function(){
  var source=${JSON.stringify(CULT_PREVIEW_MESSAGE_SOURCE)},ready=false,failed=false,visibleSince=null,start=performance.now();
  function send(type,reason){try{var message={source:source,type:type};if(reason!==undefined)message.reason=String(reason).slice(0,200);parent.postMessage(message,"*");}catch(e){}}
  var observeSize=(${PREVIEW_CONTENT_SIZE_REPORTER})(function(width,height){try{parent.postMessage({source:source,type:"size",width:width,height:height},"*");}catch(e){}},"root");
  function fail(reason){failed=true;send("error",reason);}
  window.addEventListener("error",function(event){fail("threw: "+(event.error&&event.error.message||event.message||"runtime error"));});
  window.addEventListener("unhandledrejection",function(event){fail("threw: "+(event.reason&&event.reason.message||event.reason||"unhandled rejection"));});
  function visible(element){
    var bounds=element.getBoundingClientRect();
    if(bounds.width<=0||bounds.height<=0||bounds.bottom<=0||bounds.top>=innerHeight||bounds.right<=0||bounds.left>=innerWidth)return false;
    for(var node=element;node;node=node.parentElement){var style=getComputedStyle(node);if(style.display==="none"||style.visibility==="hidden"||style.visibility==="collapse"||Number(style.opacity)<0.95)return false;}
    return true;
  }
  function painted(){
    var root=document.getElementById("root");if(!root)return false;
    var text=root.querySelectorAll("h1,h2,h3,h4,h5,h6,p,button,label,span,a,li,td,th,pre");
    for(var i=0;i<text.length;i++)if(text[i].textContent.trim()&&visible(text[i]))return true;
    var graphics=root.querySelectorAll("svg,canvas,img,video,input");
    for(var j=0;j<graphics.length;j++){
      var element=graphics[j];if(!visible(element))continue;
      if(element.tagName.toLowerCase()==="img"&&(!element.complete||element.naturalWidth<=0))continue;
      if(element.tagName.toLowerCase()==="video"&&element.readyState<2)continue;
      if(element.tagName.toLowerCase()==="svg"&&!element.querySelector("path,rect,circle,ellipse,line,polyline,polygon,text,use,image"))continue;
      return true;
    }
    return false;
  }
  function probe(){
    if(ready||failed)return;
    var now=performance.now();
    if(painted()){
      if(visibleSince===null)visibleSince=now;
      if(now-visibleSince>=100){ready=true;send("ready");observeSize();return;}
    }else visibleSince=null;
    if(now-start>=7000){fail("rendered no visible content");return;}
    setTimeout(probe,100);
  }
  setTimeout(probe,0);
})();</script>`;

/** Splice only at an actual document boundary; malformed fragments stay unchanged. */
export function withCultPreviewReadiness(html: string): string {
  const bodyEnd = findRealTagOffset(html, HTML_TAG_PATTERNS.bodyClose);
  return bodyEnd < 0 ? html : html.slice(0, bodyEnd) + READINESS_SCRIPT + html.slice(bodyEnd);
}
