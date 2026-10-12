import type { Grade } from './types.ts';
import type { Score } from './score.ts';
export interface HumanRatings {schema:'quality-human-check/2';rater:string;runId:string;fixtureDigest:string;rubricDigest:string;ratedAt:string;cases:Array<{caseId:string;grade:Grade;criteria:Record<string,number|null>;note:string}>;}
/** Agreement is descriptive, never gate authority or a claim of calibrated acceptance. */
export function humanAgreement(inputs:unknown[],score:Score,judgedAt:string) {
  const letters=['A','B','C','D','E','F']; const raters=new Set<string>();
  const cases=inputs.flatMap(input=>{
    const human=input as HumanRatings;
    if(!human || human.schema!=='quality-human-check/2' || human.runId!==score.runId || human.fixtureDigest!==score.fixtureDigest||human.rubricDigest!==score.protocols.rubric) throw new Error('Human packet identity differs');
    if(typeof human.rater!=='string'||!human.rater.trim()||raters.has(human.rater)||!Array.isArray(human.cases)||human.cases.length!==score.cases.length) throw new Error('Incomplete or duplicate human rater/case set');raters.add(human.rater);
    if(!Number.isFinite(Date.parse(human.ratedAt))||!Number.isFinite(Date.parse(judgedAt))||Date.parse(human.ratedAt)>Date.parse(judgedAt)) throw new Error('Blind human ratings must come before model judging');
    const seen=new Set<string>();
    return human.cases.map(rating=>{
      const model=score.cases.find(c=>c.caseId===rating.caseId);
      if(!model||seen.has(rating.caseId)||!letters.includes(rating.grade)||typeof rating.note!=='string'||!rating.criteria||Object.keys(rating.criteria).length!==Object.keys(model.criteria).length) throw new Error('Invalid or incomplete human rating');seen.add(rating.caseId);
      const criteria=Object.fromEntries(Object.entries(model.criteria).map(([id,value])=>{
        const h=rating.criteria[id];if(h!==null&&(!Number.isInteger(h)||h!<1||h!>5)) throw new Error('Human criterion must be 1 to 5 or not assessable');
        return [id,{human:h,model:value,delta:h!==null&&value!==null?value-h!:null,agree:h!==null&&value!==null?value===h:null}];
      }));
      const letterGap=model.grade===null?null:Math.abs(letters.indexOf(rating.grade)-letters.indexOf(model.grade));
      return {caseId:rating.caseId,rater:human.rater,humanGrade:rating.grade,advisoryBand:model.grade,letterGap,twoLetterGap:letterGap!==null&&letterGap>=2,criteria,note:rating.note};
    });
  });
  const ids=Object.keys(score.cases[0]!.criteria);
  return {schema:'quality-human-agreement/1',runId:score.runId,raterCount:raters.size,prdAcceptanceClaim:false,calibrationStatus:'not calibrated; gaps of two letters require investigation',cases,criterionAgreement:Object.fromEntries(ids.map(id=>{
    const assessable=cases.map(c=>c.criteria[id]!).filter(c=>c.agree!==null);return [id,{agree:assessable.filter(c=>c.agree).length,assessable:assessable.length}];
  }))};
}
