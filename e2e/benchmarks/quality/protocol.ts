import { readFileSync } from 'node:fs';
import { digest } from './api.ts';
/** Any evaluator-source change requires a fresh protocol packet, not silent historical rescoring. */
export const EVALUATOR_PROTOCOL_DIGEST=digest(Buffer.concat(['score.ts','mechanical.ts','evidence.ts','samples.ts','bar.ts'].map(file=>readFileSync(new URL(file,import.meta.url)))));
