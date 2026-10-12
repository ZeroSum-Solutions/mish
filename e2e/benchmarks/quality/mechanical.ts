import { VIEWPORTS } from './settings.ts';
import { captureEvidenceErrors } from './evidence.ts';
import { digest } from './api.ts';
import type { BenchmarkRun, Captures, CaseRun, CaptureFact } from './types.ts';
import type { EligibilityResult } from './bar.ts';
export interface MechanicalFinding { id:string; amount:number; detail:string; evidence:string[]; }
export function measureMechanical(item:CaseRun, captures:Captures) {
  const findings:MechanicalFinding[]=[]; const missing:string[]=[];
  const add=(id:string,detail:string,amount=1,evidence=['run.json'])=>findings.push({id,detail,amount,evidence});
  const terminal=item.run?.status;
  if(item.status!=='succeeded') {
    if(['failed','canceled','cancelled'].includes(String(terminal))) add('generation',`Generation ${terminal}`);
    else missing.push('Generation termination is unverified');
  }
  missing.push(...item.failures.filter(f=>f!==`Generation ${terminal}`));
  if(!item.siteCheck) missing.push('Site check unavailable');
  else for(const rule of item.siteCheck.rules.filter(r=>!r.ok)) add(`site-check/${rule.id}`,`Site check ${rule.id}: ${rule.detail}`);
  const pages=item.files.filter(f=>/\.html?$/iu.test(f.name)&&!f.name.startsWith('_brand-build/'));
  if(!pages.length) missing.push('No pages to capture');
  const used:CaptureFact[]=[];
  for(const page of pages) for(const viewport of VIEWPORTS) {
    const facts=captures.facts.filter(f=>f.caseId===item.caseId&&f.page===page.name&&f.viewport.width===viewport.width&&f.viewport.height===viewport.height);
    const key=`${page.name}/${viewport.width}`;
    if(facts.length!==1){missing.push(`Missing or duplicate capture: ${key}`);continue;}
    const fact=facts[0]!;used.push(fact);const evidence=[fact.evidenceFile??fact.screenshot];
    if(fact.error){missing.push(`Capture ${key}: ${fact.error}`);continue;}
    const invalid=captureEvidenceErrors(fact);if(invalid.length){missing.push(...invalid.map(error=>`${error}: ${key}`));continue;}
    if(fact.sectionEvidence.status==='complete'&&fact.sectionEvidence.value.count===0) missing.push(`No section evidence ${key}`);
    if(!Number.isFinite(fact.horizontalOverflowPx) || fact.horizontalOverflowPx<0) {missing.push(`Invalid overflow evidence: ${key}`);continue;}
    if(fact.horizontalOverflowPx>1) add(`overflow/${key}`,`Horizontal overflow ${key}: ${fact.horizontalOverflowPx}px`,fact.horizontalOverflowPx,evidence);
    for(const [kind,values] of [['console',fact.consoleErrors],['image',fact.brokenImages],['remote',fact.blockedRequests]] as const) for(const value of new Set(values)) add(`${kind}/${key}/${digest(value)}`,`${kind==='console'?'Console errors':kind==='image'?'Broken images':'Blocked remote requests'} ${key}: ${value}`,1,evidence);
    for(const name of ['sectionEvidence','conversion','forms','keyboard','motion','resources'] as const) {
      const observation=fact[name]; if(!observation || observation.status!=='complete') missing.push(`Missing ${name} evidence ${key}: ${observation?.reason??'unavailable'}`);
    }
    if(fact.sections.some(s=>s.error)) missing.push(`Unread section capture ${key}`);
    if(fact.conversion?.status==='complete' && (!fact.conversion.value.exists||!fact.conversion.value.resolves)) add(`conversion/${key}`,`Declared conversion does not resolve ${key}`,1,evidence);
    if(fact.forms?.status==='complete' && fact.forms.value.some(form=>form.requests.length>0)) missing.push(`Form truthfulness needs confirmation ${key}; observed submit requests were blocked and no real submission is proven`);
    if(fact.forms?.status==='complete' && fact.forms.value.some(form=>!form.exercised)) missing.push(`Unexercised form ${key}; truthfulness is not verified`);
    if(fact.keyboard?.status==='complete') {
      const k=fact.keyboard.value;
      const actionAbsent=fact.conversion.status==='complete'&&!fact.conversion.value.exists;
      if(k.exhausted || k.trapDetected || (!k.primaryReachable&&!actionAbsent)) missing.push(`Keyboard access needs confirmation ${key}; bounded walk is exhausted or suspected reachability/trap evidence is inconclusive`);
      // Focus visibility is a heuristic observation, never confirmed eligibility by itself.
    }
    if(fact.resources?.status==='complete') for(const request of fact.resources.value.requests) {
      if(request.failure && request.status!==null&&request.status<400) missing.push(`Resource byte measurement unavailable ${key}: ${request.url}`);
      else if(request.status!==null&&request.status>=400 || request.status===null&&request.failure) add(`resource/${key}/${digest(request.url.replace(/^https?:\/\/[^/]+/u,''))}`,`Broken local resource ${key}: ${request.url}`,1,evidence);
    }
  }
  const eligibility:EligibilityResult[]=(['horizontal-overflow','resource-hygiene','conversion','keyboard-access'] as const).map(id=>{
    const prefixes=id==='horizontal-overflow'?['overflow/']:id==='resource-hygiene'?['console/','image/','remote/','resource/']:id==='conversion'?['conversion/']:['keyboard/'];
    const failed=findings.filter(f=>prefixes.some(p=>f.id.startsWith(p)));
    const primaryAbsent=id==='keyboard-access'&&used.some(f=>f.conversion.status==='complete'&&!f.conversion.value.exists);
    return {id,outcome:failed.length?'fail':missing.length||primaryAbsent?'inconclusive':'pass',evidence:failed.length?failed.flatMap(f=>f.evidence):used.map(f=>f.evidenceFile??f.screenshot),...(primaryAbsent?{reason:'The primary action is absent; its keyboard access cannot be judged.'}:{})};
  });
  // These require human/authoritative fact and image provenance judgments. Models cannot clear them.
  for(const id of ['placeholder-content','factual-imagery','invented-fact'] as const) eligibility.push({id,outcome:'inconclusive',evidence:used.map(f=>f.evidenceFile??f.screenshot),reason:'Required content/provenance judgment is not mechanically substantiated by this harness; model findings remain advisory.'});
  eligibility.push({id:'required-evidence',outcome:missing.length?'inconclusive':'pass',evidence:['captures.json','run.json'],...(missing.length?{reason:missing.join('; ')}:{})});
  return {findings,missing:[...new Set(missing)],eligibility,outcome:findings.length?'failed' as const:missing.length?'inconclusive' as const:'passed' as const};
}
export function matchingCaseIds(run:BenchmarkRun) {return run.cases.map(c=>c.caseId).sort().join(',');}
