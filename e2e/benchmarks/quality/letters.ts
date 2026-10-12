import { AGENCY_BAR, bandForMean } from './bar.ts';
import type { CaseJudgments, Grade } from './types.ts';
const order: Grade[] = ['A','B','C','D','E','F'];
/** Informational reviewer letters, separate from the complete eight-score rubric roll-up. */
export function informationalLetters(rating: CaseJudgments, eligibility: 'pass'|'fail'|'inconclusive' = 'inconclusive') {
  const names = [...new Set(rating.samples.map(s=>s.page??'whole-case'))];
  const pages = names.map(page=>{
    const samples = rating.samples.filter(s=>(s.page??'whole-case')===page);
    let derivedLetters = 0;
    const grades = samples.map(s=>{
      if(s.grade!==null) return order.indexOf(s.grade);
      if(rating.origin==='missing-evidence' || AGENCY_BAR.criteria.some(c=>!['craft','accessibility'].includes(c.id) && s.criteria[c.id]===null)) return null;
      const scored=AGENCY_BAR.criteria.filter(c=>typeof s.criteria[c.id]==='number');
      if(!scored.length) return null;
      const weight=scored.reduce((n,c)=>n+c.weight,0);
      const partialMean=scored.reduce((n,c)=>n+c.weight*s.criteria[c.id]!,0)/weight;
      derivedLetters++;
      return order.indexOf(bandForMean(partialMean));
    });
    let letter: Grade|null = null;
    if(rating.origin!=='missing-evidence' && samples.length===6 && grades.every(g=>g!==null)) {
      const sorted = (grades as number[]).sort((a,b)=>a-b);
      let index = Math.ceil((sorted[2]!+sorted[3]!)/2);
      if(eligibility!=='pass') index=Math.max(index,1);
      // Partial criterion evidence cannot produce an informational A.
      if(samples.some(s=>Object.values(s.criteria).includes(null))) index=Math.max(index,1);
      const scores=Object.fromEntries(Object.keys(samples[0]!.criteria).map(id=>{
        const values=samples.map(s=>s.criteria[id]).filter((v):v is number=>typeof v==='number').sort((a,b)=>a-b);
        return [id,values.length===6?(values[2]!+values[3]!)/2:null];
      }));
      for(const cap of AGENCY_BAR.caps) {
        const applies=cap.criterion==='any' ? Object.values(scores).some(v=>v!==null&&v<cap.below!)
          : cap.criterion!=='eligibility' && scores[cap.criterion]!==null && scores[cap.criterion]!==undefined && scores[cap.criterion]!<cap.below!;
        if(applies) index=Math.max(index,order.indexOf(cap.maxGrade));
      }
      letter=order[index]!;
    }
    return {page,letter,derivedLetters};
  });
  const letter = pages.length && pages.every(p=>p.letter!==null) ? order[Math.max(...pages.map(p=>order.indexOf(p.letter!)))]! : null;
  return {label:rating.origin==='stub'?'SYNTHETIC' as const:'UNCALIBRATED' as const,letter,pages,policy:'Median of six reviewer letters per page (ties take the weaker band); weakest page is the site letter. When a reviewer omits its overall letter despite scoring required criteria, derive that sample letter using only its scored criteria and their normalized weights; record the count. Partial evidence and incomplete eligibility cannot yield A. These letters do not fill null criteria, compute M, establish eligibility or accept a draft.'};
}
