/**
 * In-frame content measurement shared by served preview documents (the GenUI effect documents, the
 * 21st.dev previews and the Cult preview harness). It reports the bottom edge of the content root's visible descendants
 * from the document top, or the document scroll height when the content overflows the frame
 * viewport (a full page, a scroll effect, a viewport-filling canvas). Values are integers in
 * 1..4096 and equal sizes are not resent. The host clamps the height to its stage and never
 * resizes the frame viewport from it, so a viewport-relative document cannot loop.
 * Usage: `(REPORTER)(post(width, height), rootId | null)` returns a function that starts it.
 */
export const PREVIEW_CONTENT_SIZE_REPORTER = `function(post,rootId){var last="",resize=null,observed=new Set();
function root(){return(rootId&&document.getElementById(rootId))||document.body;}
function clips(style){return /^(hidden|clip|auto|scroll)$/.test(style.overflowY)||/^(hidden|clip|auto|scroll)$/.test(style.overflow);}
function measure(){var node=root();if(!node)return;var bottom=0,elements=[node],stack=[],limit=512;
var rootStyle=getComputedStyle(node),rootRect=node.getBoundingClientRect();
if(rootStyle.display!=="none")for(var i=node.children.length-1;i>=0;i--)stack.push({element:node.children[i],clip:clips(rootStyle)?rootRect.bottom:Infinity});
while(stack.length){if(elements.length>limit){bottom=Math.max(bottom,innerHeight);break;}
var entry=stack.pop(),element=entry.element,style=getComputedStyle(element);if(style.display==="none")continue;
elements.push(element);var rect=element.getBoundingClientRect(),edge=Math.min(rect.bottom,entry.clip);
if(style.visibility!=="hidden"&&style.visibility!=="collapse"&&rect.width>0&&rect.height>0&&rect.top<edge)bottom=Math.max(bottom,edge+scrollY);
var clip=clips(style)?Math.min(entry.clip,rect.bottom):entry.clip;
for(var j=element.children.length-1;j>=0;j--)stack.push({element:element.children[j],clip:clip});}
if(resize){var next=new Set(elements);observed.forEach(function(element){if(!next.has(element))resize.unobserve(element);});
next.forEach(function(element){if(!observed.has(element))resize.observe(element);});observed=next;}
var doc=document.documentElement,scroll=Math.max(doc.scrollHeight,document.body?document.body.scrollHeight:0);
if(scroll>innerHeight+1)bottom=Math.max(bottom,scroll);
var height=Math.min(4096,Math.ceil(bottom)),width=Math.round(innerWidth);
if(!(height>=1)||!(width>=1&&width<=4096))return;var key=width+":"+height;if(key===last)return;last=key;post(width,height);}
return function(){if(typeof ResizeObserver!=="undefined")resize=new ResizeObserver(measure);
measure();addEventListener("resize",measure);
if(typeof MutationObserver!=="undefined"&&document.body)new MutationObserver(measure).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:["style","class","hidden"]});};}`;
