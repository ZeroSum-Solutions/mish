const REPLAY_BYTE_CEILING = 16_000;
const TRUNCATION_MARKER = '\n\n[Mishh Mashh truncated replay; full history remains stored.]\n\n';
const MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');

export interface ReplayBudgetInputs {
  /** An optional additional byte cap; it cannot enlarge the fixed ceiling. */
  byteLimit?: number | null;
  /** Already-derived remaining allowance in the labeled estimate's units. */
  estimatedTokenAllowance?: number | null;
}

export interface ReplayBudgetResult {
  status: 'empty' | 'unchanged' | 'truncated' | 'omitted' | 'invalid-budget';
  reason: 'zero-budget' | 'marker-does-not-fit' | 'invalid-byte-limit'
    | 'invalid-estimated-token-allowance' | null;
  /** Null means the caller must handle omission/refusal explicitly. */
  replay: string | null;
  originalBytes: number;
  bytes: number;
  byteLimit: number | null;
  truncated: boolean;
  /** No replay string is returned; a marker-only string is still transmitted. */
  omitted: boolean;
  /** Source bytes removed, excluding the newly inserted marker. */
  omittedBytes: number;
  estimatedReplayTokens: number | null;
  estimatedTokenAllowance: number | null;
  estimatedAllowanceStatus: 'unknown' | 'declared' | 'invalid';
  tokenEstimateMethod: 'utf8_bytes_div_3_ceil_v1';
  budgetConfidence: 'byte-bound-only' | 'byte-and-estimate-bound' | 'invalid';
  remainingBudgetConfidence: 'unverified';
  actualReplayTokens: null;
}

function isAllowance(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function takeHead(text: string, byteLimit: number): string {
  const points: string[] = [];
  let bytes = 0;
  for (const point of text) {
    bytes += Buffer.byteLength(point, 'utf8');
    if (bytes > byteLimit) break;
    points.push(point);
  }
  return points.join('');
}

function takeTail(text: string, byteLimit: number): string {
  let start = text.length;
  let bytes = 0;
  while (start > 0) {
    let next = start - 1;
    const code = text.charCodeAt(next);
    const previous = text.charCodeAt(next - 1);
    if (code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
      next -= 1;
    }
    bytes += Buffer.byteLength(text.slice(next, start), 'utf8');
    if (bytes > byteLimit) break;
    start = next;
  }
  return text.slice(start);
}

/**
 * Bounds only an authorized, already-serialized replay segment, including its
 * caller-supplied framing. Current input and attachments remain caller-owned.
 * Unknown allowance is not zero. The bytes/3 estimate is never a verified
 * token bound or proof of the model's actual remaining input budget.
 */
export function budgetSerializedReplay(
  serializedReplay: string,
  budget: ReplayBudgetInputs = {},
): ReplayBudgetResult {
  const originalBytes = Buffer.byteLength(serializedReplay, 'utf8');
  const allowance = budget.estimatedTokenAllowance;
  const invalidEstimate = allowance != null && !isAllowance(allowance);
  const invalidBytes = budget.byteLimit != null && !isAllowance(budget.byteLimit);
  const estimate = allowance != null && !invalidEstimate ? allowance : null;
  const result: ReplayBudgetResult = {
    status: 'invalid-budget',
    reason: null,
    replay: null,
    originalBytes,
    bytes: 0,
    byteLimit: null,
    truncated: false,
    omitted: originalBytes > 0,
    omittedBytes: originalBytes,
    estimatedReplayTokens: null,
    estimatedTokenAllowance: estimate,
    estimatedAllowanceStatus: invalidEstimate ? 'invalid' : estimate === null ? 'unknown' : 'declared',
    tokenEstimateMethod: 'utf8_bytes_div_3_ceil_v1',
    budgetConfidence: 'invalid',
    remainingBudgetConfidence: 'unverified',
    actualReplayTokens: null,
  };
  if (invalidBytes || invalidEstimate) {
    result.reason = invalidBytes ? 'invalid-byte-limit' : 'invalid-estimated-token-allowance';
    return result;
  }

  let byteLimit = Math.min(REPLAY_BYTE_CEILING, budget.byteLimit ?? REPLAY_BYTE_CEILING);
  // ceil(bytes/3) <= allowance is equivalent to bytes <= 3*allowance.
  // Multiply only when it tightens this small cap, avoiding integer overflow.
  if (estimate !== null && estimate < Math.ceil(byteLimit / 3)) {
    byteLimit = estimate * 3;
  }
  result.byteLimit = byteLimit;
  result.budgetConfidence = estimate === null ? 'byte-bound-only' : 'byte-and-estimate-bound';
  if (originalBytes <= byteLimit) {
    result.status = originalBytes === 0 ? 'empty' : 'unchanged';
    result.replay = serializedReplay;
    result.omitted = false;
    result.omittedBytes = 0;
  } else if (byteLimit < MARKER_BYTES) {
    result.status = 'omitted';
    result.reason = byteLimit === 0 ? 'zero-budget' : 'marker-does-not-fit';
    return result;
  } else {
    const retainedBudget = byteLimit - MARKER_BYTES;
    // Split the retained byte allowance evenly, favoring the head on odd
    // budgets. Spare bytes remain spare when the next code point cannot fit.
    const head = takeHead(serializedReplay, Math.ceil(retainedBudget / 2));
    const tail = takeTail(serializedReplay, Math.floor(retainedBudget / 2));
    result.replay = `${head}${TRUNCATION_MARKER}${tail}`;
    result.status = 'truncated';
    result.truncated = true;
    result.omitted = false;
    result.omittedBytes = originalBytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8');
  }
  result.bytes = Buffer.byteLength(result.replay, 'utf8');
  result.estimatedReplayTokens = Math.ceil(result.bytes / 3);
  return result;
}
