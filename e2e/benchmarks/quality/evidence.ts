import { CAPTURE_SETTINGS } from './settings.ts';
import type { CaptureFact } from './types.ts';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown)=>typeof v==='string';
const finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const integer=(v:unknown)=>finite(v)&&Number.isInteger(v);
const strings=(v:unknown)=>Array.isArray(v)&&v.every(text);
const list=(v:unknown,check:(item:Record<string,unknown>)=>boolean)=>Array.isArray(v)&&v.every(item=>object(item)&&check(item));
const box=(v:unknown)=>object(v)&&['x','y','width','height'].every(k=>typeof v[k]==='number'&&Number.isFinite(v[k]))&&finite(v.width)&&finite(v.height);
const dimensions=(v:unknown)=>object(v)&&finite(v.width)&&finite(v.height);
const motion=(v:unknown)=>object(v)&&integer(v.animationCount)&&finite(v.layoutShift)&&integer(v.movedElements)&&v.sampleFrames===CAPTURE_SETTINGS.motionSampleFrames;
/** JSON boundary validation prevents a malformed `complete` label from proving anything. */
export function captureEvidenceErrors(fact:CaptureFact):string[] {
  const errors:string[]=[];
  if(!finite(fact.horizontalOverflowPx)||!strings(fact.consoleErrors)||!strings(fact.brokenImages)||!strings(fact.blockedRequests)) errors.push('Malformed mechanical facts');
  if(!list(fact.sections,s=>text(s.id)&&text(s.selector)&&text(s.screenshot)&&box(s.box)&&(s.cropBox===undefined||box(s.cropBox))&&(s.error===undefined||text(s.error)))) errors.push('Malformed section captures');
  const checks:Record<string,(v:unknown)=>boolean>={
    sectionEvidence:v=>object(v)&&integer(v.count)&&Array.isArray(fact.sections)&&v.count===fact.sections.length,
    conversion:v=>object(v)&&typeof v.exists==='boolean'&&typeof v.resolves==='boolean'&&list(v.matches,m=>text(m.selector)&&text(m.label)&&(m.target===null||text(m.target))&&typeof m.resolves==='boolean')&&v.exists===((v.matches as unknown[]).length>0)&&v.resolves===(v.exists&&(v.matches as Record<string,unknown>[]).every(m=>m.resolves)),
    forms:v=>list(v,f=>text(f.selector)&&text(f.action)&&text(f.method)&&typeof f.exercised==='boolean'&&list(f.requests,r=>text(r.url)&&text(r.method)&&typeof r.blocked==='boolean')&&(f.reason===undefined||text(f.reason))),
    keyboard:v=>object(v)&&integer(v.tabStopCount)&&typeof v.trapDetected==='boolean'&&typeof v.primaryReachable==='boolean'&&typeof v.exhausted==='boolean'&&list(v.steps,s=>(s.selector===null||text(s.selector))&&text(s.label)&&(s.visibleFocus===null||typeof s.visibleFocus==='boolean')&&typeof s.primary==='boolean')&&(v.tabStopCount===0||(v.steps as unknown[]).length>0),
    motion:v=>object(v)&&motion(v.normal)&&motion(v.reduced),
    resources:v=>object(v)&&integer(v.imageBytes)&&integer(v.fontBytes)&&list(v.requests,r=>text(r.url)&&text(r.type)&&(r.status===null||integer(r.status)&&Number(r.status)>=100&&Number(r.status)<=599)&&(r.bytes===null||integer(r.bytes))&&(r.failure===undefined||text(r.failure)))&&list(v.fontFaces,f=>text(f.family)&&text(f.weight)&&text(f.style)&&text(f.status))&&list(v.requestedFonts,f=>text(f.family)&&text(f.weight)&&text(f.style)&&(f.available===null||typeof f.available==='boolean'))&&list(v.images,i=>text(i.src)&&dimensions(i.rendered)&&dimensions(i.natural)),
  };
  for(const [name,check] of Object.entries(checks)) {
    const observation=(fact as unknown as Record<string,unknown>)[name];
    if(!object(observation)||!['complete','missing','failed'].includes(String(observation.status))||observation.status==='complete'&&!check(observation.value)||observation.status!=='complete'&&(!text(observation.reason)||!String(observation.reason).trim())) errors.push(`Malformed ${name} observation`);
  }
  return errors;
}
