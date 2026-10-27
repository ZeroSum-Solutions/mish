// The page's interactive background: one canvas behind the content, drawn in the page's own two colours.
// Effects use the names of Mish's Design DNA `visual_effects.background` so a captured style can pick one:
//   glaze    soft pools of ink that drift and gather toward the pointer, over clay speckle (editorial)
//   mesh     large blended colour fields that follow the pointer (modern)
//   grid     a dot grid that bends away from the pointer (raw)
//   bubbles  floating rings the pointer pushes aside (playful)
// Motion stops for people who ask their device for reduced motion: they get one still frame.

export const EFFECTS = ['glaze', 'mesh', 'grid', 'bubbles'] as const;
export type Effect = (typeof EFFECTS)[number];

export const backgroundCss = '#bg{position:fixed;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none}';

export function backgroundHtml(effect: string): string {
  return (EFFECTS as readonly string[]).includes(effect) ? `<canvas id="bg" aria-hidden="true" data-effect="${effect}"></canvas>` : '';
}

// Runs in the browser. Reads --bg and --text from the page so the effect always matches the theme.
export const backgroundJs = `(function(){
var c=document.getElementById('bg');if(!c)return;var x=c.getContext('2d'),kind=c.dataset.effect,S=getComputedStyle(document.documentElement);
var BG=S.getPropertyValue('--bg').trim(),INK=S.getPropertyValue('--text').trim();
function rgb(h){h=h.replace('#','');return[0,2,4].map(function(i){return parseInt(h.substr(i,2),16)})}
var I=rgb(INK),W,H,P={x:.5,y:.4,tx:.5,ty:.4},t0=0,still=matchMedia('(prefers-reduced-motion: reduce)').matches;
function ink(a){return'rgba('+I[0]+','+I[1]+','+I[2]+','+a+')'}
var rnd=(function(s){return function(){s=(s*16807)%2147483647;return(s-1)/2147483646}})(7);
var blobs=[],speck=[],dots=[],rings=[];
function size(){var d=Math.min(devicePixelRatio||1,2);W=c.width=innerWidth*d;H=c.height=innerHeight*d;x.setTransform(1,0,0,1,0,0);x.scale(d,d);W=innerWidth;H=innerHeight;
 blobs=[];for(var i=0;i<6;i++)blobs.push({a:rnd()*6.28,r:.18+rnd()*.22,sp:.00006+rnd()*.00008,cx:.15+rnd()*.7,cy:.1+rnd()*.8,o:.05+rnd()*.07});
 speck=[];for(var j=0;j<Math.round(W*H/2600);j++)speck.push([rnd()*W,rnd()*H,.4+rnd()*1.2,.04+rnd()*.12]);
 dots=[];var g=34;for(var yy=g/2;yy<H+g;yy+=g)for(var xx=g/2;xx<W+g;xx+=g)dots.push([xx,yy]);
 rings=[];for(var k=0;k<14;k++)rings.push({x:rnd()*W,y:rnd()*H,r:14+rnd()*46,vy:-.1-rnd()*.25,px:0,py:0})}
function pool(cx,cy,r,a){var g=x.createRadialGradient(cx,cy,0,cx,cy,r);g.addColorStop(0,ink(a));g.addColorStop(1,ink(0));x.fillStyle=g;x.fillRect(cx-r,cy-r,r*2,r*2)}
function draw(t){P.x+=(P.tx-P.x)*.04;P.y+=(P.ty-P.y)*.04;x.fillStyle=BG;x.fillRect(0,0,W,H);var m=Math.max(W,H);
 if(kind==='glaze'||kind==='mesh'){blobs.forEach(function(b){var a=b.a+t*b.sp*(kind==='mesh'?2:1);pool(b.cx*W+Math.cos(a)*m*.12,b.cy*H+Math.sin(a*1.3)*m*.1,b.r*m*(kind==='mesh'?1.3:1),b.o*(kind==='mesh'?1.4:1))});
  pool(P.x*W,P.y*H,m*(kind==='mesh'?.4:.26),kind==='mesh'?.16:.2);
  if(kind==='glaze'){speck.forEach(function(s){var d=Math.hypot(s[0]-P.x*W,s[1]-P.y*H),l=Math.max(0,1-d/(m*.3));x.fillStyle=ink(s[3]*(.5+l*1.8));x.fillRect(s[0],s[1],s[2],s[2])})}}
 else if(kind==='grid'){dots.forEach(function(d){var dx=d[0]-P.x*W,dy=d[1]-P.y*H,dist=Math.hypot(dx,dy),f=Math.max(0,1-dist/220),px=d[0]+dx/(dist||1)*f*22,py=d[1]+dy/(dist||1)*f*22;x.fillStyle=ink(.18+f*.4);x.beginPath();x.arc(px,py,1.3+f*1.6,0,6.28);x.fill()})}
 else{rings.forEach(function(r){var dx=r.x-P.x*W,dy=r.y-P.y*H,d=Math.hypot(dx,dy);if(d<140){r.px+=dx/(d||1)*.9;r.py+=dy/(d||1)*.9}r.px*=.94;r.py*=.94;r.x+=r.px;r.y+=r.vy+r.py;if(r.y<-r.r*2){r.y=H+r.r;r.x=rnd()*W}x.strokeStyle=ink(.2);x.lineWidth=1.2;x.beginPath();x.arc(r.x,r.y,r.r,0,6.28);x.stroke()})}}
function frame(t){draw(t);if(!still)requestAnimationFrame(frame)}
addEventListener('pointermove',function(e){P.tx=e.clientX/innerWidth;P.ty=e.clientY/innerHeight},{passive:true});
addEventListener('resize',function(){size();if(still)draw(0)});
size();requestAnimationFrame(frame)})()`;
