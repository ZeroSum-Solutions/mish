/**
 * Conservative credential patterns. A reusable unit is copied into other
 * projects, so a live key inside its source must never be persisted. Findings
 * report the kind and line only, never the matched value.
 */
const PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: 'anthropic-key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/u },
  { kind: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/u },
  { kind: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  { kind: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/u },
  { kind: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/u },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  { kind: 'stripe-secret', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/u },
  { kind: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/u },
];

export function findSecrets(text: string): Array<{ kind: string; line: number }> {
  const findings: Array<{ kind: string; line: number }> = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length && findings.length < 20; index++) {
    for (const { kind, pattern } of PATTERNS) if (pattern.test(lines[index]!)) findings.push({ kind, line: index + 1 });
  }
  return findings;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Text when the bytes hold no NUL and decode as UTF-8; that text is what a reader of the unit would see. */
export function textLike(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try { return UTF8.decode(bytes); } catch { return null; }
}

/**
 * File names that carry credentials by convention (dotenv files, private keys,
 * keystores, SSH identities). A unit never persists one, whatever its bytes
 * hold, because a binary or unrecognised secret format cannot be scanned.
 */
export function secretBearingFileName(relPath: string): boolean {
  const base = relPath.split('/').pop()!.toLowerCase();
  if (/^\.env(?:\..+)?$/u.test(base)) return true;
  if (/^id_[a-z0-9_-]+$/u.test(base)) return true;
  return /\.(?:pem|key|p12|pfx|jks|keystore|ppk)$/u.test(base);
}
