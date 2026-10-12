import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildDiagnosticsZip } from "../src/zip.js";
import { buildRunEventLogSources } from "../src/agent-logs.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "diagnostics-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function exportSyntheticStderr(chunk: string, redaction: { username?: string } = {}, separator = "\n"): Promise<string> {
  const runsDir = join(tempDir, "runs");
  const runDir = join(runsDir, "synthetic-run");
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "events.jsonl"), [
    { event: "stderr", data: { chunk }, marker: "safe-marker" },
    { event: "error", data: { code: "SAFE_ERROR_MARKER" } },
  ].map((record) => JSON.stringify(record)).join(separator) + separator, "utf8");
  const result = await buildDiagnosticsZip({
    context: { app: { name: "mish" }, source: "synthetic-test" },
    sources: await buildRunEventLogSources(runsDir),
    redaction,
  });
  const zip = await JSZip.loadAsync(result.zip);
  return await zip.file("runs/synthetic-run/events.jsonl")!.async("string");
}

describe("buildDiagnosticsZip", () => {
  it.each([
    ['owner@example.com-staging', '[REDACTED]-staging'],
    ['owner@example.com2026', '[REDACTED]2026'],
    ['logs/owner@example.com-2026-10-11', 'logs/[REDACTED]-2026-10-11'],
  ])("redacts an ordinary email prefix before a hyphen or numeric suffix: %s", async (chunk, expected) => {
    const exported = await exportSyntheticStderr(chunk!);
    expect(JSON.parse(exported.split('\n')[0]!).data.chunk).toBe(expected);
    expect(exported).not.toContain('owner@example.com');
    expect(await exportSyntheticStderr(expected!)).toBe(exported);
  });

  it.each([
    'pnpm@10.33.2',
    '/workspace/node_modules/.pnpm/express@4.21.2/node_modules/express/lib/router/index.js:284',
    '@types/node@20.1.0 public-marker',
  ])("preserves public package versions rather than treating numeric suffixes as email domains: %s", async (chunk) => {
    const exported = await exportSyntheticStderr(chunk);
    expect(JSON.parse(exported.split('\n')[0]!).data.chunk).toBe(chunk);
  });

  it.each([
    ['<!-- alice@example.com-->', '<!-- [REDACTED]-->'],
    ['alice@example.com- public-marker', '[REDACTED]- public-marker'],
    ['alice@example.com-. public-marker', '[REDACTED]-. public-marker'],
    ['Contact alice@example.xn--p1ai public-marker', 'Contact [REDACTED] public-marker'],
  ])("redacts email domains while retaining ordinary trailing delimiters: %s", async (chunk, expected) => {
    const exported = await exportSyntheticStderr(chunk!);
    expect(JSON.parse(exported.split('\n')[0]!).data.chunk).toBe(expected);
    expect(await exportSyntheticStderr(expected!)).toBe(exported);
  });

  it.each([
    '?email=qa%40example.test&public=ok',
    'https://example.test/help?email=Synthetic.Owner%2Bsupport%40example.invalid&public=ok',
  ])("redacts an email with a percent-encoded @ separator while preserving public URL fields: %s", async (chunk) => {
    const exported = await exportSyntheticStderr(chunk);
    const record = JSON.parse(exported.split('\n')[0]!);
    expect(record.data.chunk).toBe(chunk.replace(/(?<=email=)[^&]+/, '[REDACTED]'));
    expect(record.data.chunk).not.toContain('%40');
    expect(record.data.chunk).toContain('&public=ok');
    expect(await exportSyntheticStderr(record.data.chunk)).toBe(exported);
  });

  it.each([
    'Contact Synthetic.Owner+support@example.invalid public-marker',
    'https://example.invalid/help?contact=Synthetic.Owner+support@example.invalid&page=2',
    '/Users/Synthetic.Owner+support@example.invalid/logs/public-marker',
    JSON.stringify({ email: 'Synthetic.Owner+support@example.invalid', marker: 'public-marker' }),
    JSON.stringify({ message: JSON.stringify({ contact: 'Synthetic.Owner+support@example.invalid', marker: 'public-marker' }) }),
  ])("omits email addresses from exported text and JSON without losing event records: %s", async (chunk) => {
    const exported = await exportSyntheticStderr(chunk);
    expect(exported).not.toContain('Synthetic.Owner+support@example.invalid');
    const records = exported.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({ event: 'stderr', marker: 'safe-marker' });
    expect(records[0].data.chunk).toContain('[REDACTED]');
    expect(records[1]).toEqual({ event: 'error', data: { code: 'SAFE_ERROR_MARKER' } });
    expect(await exportSyntheticStderr(records[0].data.chunk)).toBe(exported);
  });

  it("redacts emails in archive names, missing-file notices and summary fields without merging files", async () => {
    const first = 'first.person@example.invalid';
    const second = 'second.person@example.invalid';
    await writeFile(join(tempDir, 'first.log'), 'first-public-marker');
    await writeFile(join(tempDir, 'second.log'), 'second-public-marker');
    const result = await buildDiagnosticsZip({
      context: { app: { name: 'mish' }, source: 'synthetic-test' },
      sources: [
        { name: `logs/${first}.log`, absolutePath: join(tempDir, 'first.log'), kind: 'text' },
        { name: `logs/${second}.log`, absolutePath: join(tempDir, 'second.log'), kind: 'text' },
        { name: 'logs/missing.log', absolutePath: join(tempDir, first, 'missing.log'), kind: 'text' },
      ],
      summaries: { 'contact.json': { contact: first, [second]: 'public-summary-marker' } },
    });
    const zip = await JSZip.loadAsync(result.zip);
    const names = Object.keys(zip.files);
    expect(names.join('\n')).not.toContain(first);
    expect(names.join('\n')).not.toContain(second);
    const contents = await Promise.all(Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.async('string')));
    expect(contents.join('\n')).not.toContain(first);
    expect(contents.join('\n')).not.toContain(second);
    expect(contents).toContain('first-public-marker');
    expect(contents).toContain('second-public-marker');
    expect(contents.join('\n')).toContain('public-summary-marker');
    expect(await zip.file('logs/missing.log')!.async('string')).toContain('file unavailable');
    const again = await buildDiagnosticsZip({
      context: { app: { name: 'mish' }, source: 'synthetic-test' },
      sources: [
        { name: `logs/${first}.log`, absolutePath: join(tempDir, 'first.log'), kind: 'text' },
        { name: `logs/${second}.log`, absolutePath: join(tempDir, 'second.log'), kind: 'text' },
      ],
    });
    expect(Object.keys((await JSZip.loadAsync(again.zip)).files).filter((name) => name.startsWith('logs/')))
      .toEqual(names.filter((name) => name.startsWith('logs/') && name !== 'logs/missing.log'));
  });

  it("preserves public text and long non-email runs", async () => {
    for (const chunk of ['public-marker alice at example dot invalid', 'a'.repeat(80000), `public-marker ${'a.'.repeat(40000)}@invalid`, `a@${'a.'.repeat(40000)}invalid`]) {
      const exported = await exportSyntheticStderr(chunk);
      const records = exported.trimEnd().split('\n').map((line) => JSON.parse(line));
      expect(records[0].data.chunk).toBe(chunk);
    }
  });

  it("redacts a maximum-length dotted email domain followed by sentence punctuation", async () => {
    const email = `a@${['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.')}`;
    const exported = await exportSyntheticStderr(`Contact ${email}. public-marker`);
    expect(exported).not.toContain(email);
    expect(JSON.parse(exported.split('\n')[0]!).data.chunk).toBe('Contact [REDACTED]. public-marker');
  });

  it("keeps distinct public JSON fields when email-shaped keys redact to the same marker", async () => {
    const chunk = JSON.stringify({
      'first.person@example.invalid': 'first-public-field',
      'second.person@example.invalid': 'second-public-field',
      '[REDACTED]': 'existing-public-field',
    });
    const exported = await exportSyntheticStderr(chunk);
    expect(exported).not.toContain('@example.invalid');
    const record = JSON.parse(exported.split('\n')[0]!);
    expect(Object.values(JSON.parse(record.data.chunk))).toEqual(['first-public-field', 'second-public-field', 'existing-public-field']);
    expect(await exportSyntheticStderr(record.data.chunk)).toBe(exported);
  });

  it("does not expose a guess-verifiable digest of an email-bearing archive name", async () => {
    const original = 'logs/person@example.invalid';
    await writeFile(join(tempDir, 'email.log'), 'public-marker');
    const result = await buildDiagnosticsZip({
      context: { app: { name: 'mish' }, source: 'synthetic-test' },
      sources: [{ name: original, absolutePath: join(tempDir, 'email.log'), kind: 'text' }],
    });
    const zip = await JSZip.loadAsync(result.zip);
    expect(Object.keys(zip.files).join('\n')).not.toContain(createHash('sha256').update(original).digest('hex').slice(0, 16));
    expect(await zip.file('logs/[REDACTED]-1')!.async('string')).toBe('public-marker');
  });

  it("does not overwrite an existing public archive name matching an email-name ordinal", async () => {
    const original = 'logs/person@example.invalid';
    const publicName = 'logs/[REDACTED]-1';
    await writeFile(join(tempDir, 'email.log'), 'email-file-public-marker');
    await writeFile(join(tempDir, 'public.log'), 'existing-file-public-marker');
    const result = await buildDiagnosticsZip({
      context: { app: { name: 'mish' }, source: 'synthetic-test' },
      sources: [
        { name: original, absolutePath: join(tempDir, 'email.log'), kind: 'text' },
        { name: publicName, absolutePath: join(tempDir, 'public.log'), kind: 'text' },
      ],
    });
    const zip = await JSZip.loadAsync(result.zip);
    expect(await zip.file(publicName)!.async('string')).toBe('existing-file-public-marker');
    expect(await zip.file('logs/[REDACTED]-2')!.async('string')).toBe('email-file-public-marker');
  });

  it.each([
    "x ?key=[REDACTED]&page=2 y",
    "Gemini request failed https://generativelanguage.googleapis.com/v1/models?key=[REDACTED]&alt=json (403)",
  ])("preserves an already-redacted query credential and public suffix: %s", async (chunk) => {
    const exported = await exportSyntheticStderr(chunk);
    const records = exported.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toEqual({ event: "stderr", data: { chunk }, marker: "safe-marker" });
    expect(records[1]).toEqual({ event: "error", data: { code: "SAFE_ERROR_MARKER" } });
  });

  it.each([
    String.raw`?token=\ "SECRET"`,
    '?api_key= SECRET',
    '?api_key=abc"defSECRET"',
  ])("redacts known credentials across ambiguous query boundaries: %s", async (value) => {
    const secret = "PRIVACY_SYNTHETIC_QUERY_BOUNDARY_CREDENTIAL";
    const exported = await exportSyntheticStderr(`x ${value.replace("SECRET", secret)} y`);
    expect(exported).not.toContain(secret);
    const records = exported.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({ event: "stderr", marker: "safe-marker" });
    expect(records[0].data.chunk).toContain("[REDACTED]");
    expect(records[1]).toEqual({ event: "error", data: { code: "SAFE_ERROR_MARKER" } });
  });

  it.each([
    '?token={"session":"SECRET"} tail',
    '?token={"session":"SECRET',
    '?token=abc{"session":"SECRET"} tail',
    '?token=["SECRET"] tail',
  ])("redacts a query value containing a credential container: %s", async (value) => {
    const secret = "PRIVACY_SYNTHETIC_QUERY_CONTAINER_CREDENTIAL";
    const exported = await exportSyntheticStderr(`provider-error-marker ${value.replace("SECRET", secret)}`);
    expect(exported).not.toContain(secret);
    const records = exported.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({ event: "stderr", marker: "safe-marker" });
    expect(records[0].data.chunk).toContain("provider-error-marker");
    expect(records[0].data.chunk).toContain("[REDACTED]");
    expect(records[1]).toEqual({ event: "error", data: { code: "SAFE_ERROR_MARKER" } });
  });

  it.each([
    "session_token=Cookie: sid=FIRST; sessionid=SECOND",
    "token=Authorization: Digest username=p, credential=FIRST, response=SECOND",
    "session_token=Cookie:sid=FIRST; sessionid=SECOND",
    "token=Authorization:Digest username=p, credential=FIRST, response=SECOND",
  ])("keeps header credential context across a scalar boundary: %s", async (value) => {
    const first = "PRIVACY_SYNTHETIC_OVERLAPPING_HEADER_FIRST";
    const second = "PRIVACY_SYNTHETIC_OVERLAPPING_HEADER_SECOND";
    const exported = await exportSyntheticStderr(`x ${value.replace("FIRST", first).replace("SECOND", second)}`);
    expect(exported).not.toContain(first);
    expect(exported).not.toContain(second);
    const records = exported.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({ event: "stderr", marker: "safe-marker" });
    expect(records[0].data.chunk).toContain("[REDACTED]");
    expect(records[1]).toEqual({ event: "error", data: { code: "SAFE_ERROR_MARKER" } });
  });

  it.each([
    ['?api_key="SECRET"'],
    ["&token='SECRET'"],
    ['?api_key= "SECRET"'],
    [String.raw`?api_key=\"SECRET\"`],
  ])("redacts a query value beginning with a quote: %s", async (value) => {
    const secret = "PRIVACY_SYNTHETIC_QUOTED_QUERY_CREDENTIAL";
    const exported = await exportSyntheticStderr(`x ${value!.replace("SECRET", secret)} y`);
    expect(exported).not.toContain(secret);
    const records = exported.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({ event: "stderr", marker: "safe-marker" });
    expect(records[0].data.chunk).toContain("[REDACTED]");
    expect(records[1]).toEqual({ event: "error", data: { code: "SAFE_ERROR_MARKER" } });
  });

  it("preserves public fields following an empty query credential", async () => {
    const exported = await exportSyntheticStderr("x ?token=&page=2 y");
    const records = exported.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toEqual({ event: "stderr", data: { chunk: "x ?token=[REDACTED]&page=2 y" }, marker: "safe-marker" });
    expect(records[1]).toEqual({ event: "error", data: { code: "SAFE_ERROR_MARKER" } });
  });

  it.each(['"', "'"])("preserves the public suffix after a quoted masked URL: %s", async (quote) => {
    const secret = "PRIVACY_SYNTHETIC_QUOTED_URL_CREDENTIAL";
    const chunk = `fetch failed: ${quote}https://api.example.com/v1/items?api_key=${secret}${quote} (status 401)`;
    const exported = await exportSyntheticStderr(chunk);
    expect(exported).not.toContain(secret);
    const records = exported.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toEqual({ event: "stderr", data: { chunk: chunk.replace(secret, "[REDACTED]") }, marker: "safe-marker" });
    expect(records[1]).toEqual({ event: "error", data: { code: "SAFE_ERROR_MARKER" } });
  });

  it.each([
    ["repeated assignments", "token=".repeat(2000) + "SECRET"],
    ["embedded cookie assignment", "token=prefix/cookie=SECRET"],
  ])("masks a scalar once without revisiting its contents: %s", async (_name, value) => {
    const secret = "PRIVACY_SYNTHETIC_SCALAR_CREDENTIAL";
    const exported = await exportSyntheticStderr(`provider-error-marker ${value!.replace("SECRET", secret)} publicDetail=visible`);
    expect(exported).not.toContain(secret);
    const records = exported.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toEqual({ event: "stderr", data: { chunk: "provider-error-marker token=[REDACTED] publicDetail=visible" }, marker: "safe-marker" });
    expect(records[1]).toEqual({ event: "error", data: { code: "SAFE_ERROR_MARKER" } });
  });

  it.each([
    'Config{token=SECRET}',
    '(password=SECRET)',
    '[api_key=SECRET]',
    '?client_secret=[REDACTED]SECRET',
    '?client_secret=[REDACTED]{"value":"SECRET"}',
    '?token=[REDACTED]SECRET',
    '?token=[REDACTED]{"value":"SECRET"}',
  ])("redacts known fields following punctuation: %s", async (template) => {
    const secret = "PRIVACY_SYNTHETIC_BOUNDARY_CREDENTIAL";
    const exported = await exportSyntheticStderr("provider-error-marker " + template.replace("SECRET", secret));
    expect(exported).not.toContain(secret);
    const records = exported.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({ event: "stderr", marker: "safe-marker" });
    expect(records[0].data.chunk).toContain("provider-error-marker");
    expect(records[0].data.chunk).toContain("[REDACTED]");
    expect(records[1]).toEqual({ event: "error", data: { code: "SAFE_ERROR_MARKER" } });
  });

  it.each([
    ["Cookie", "sid=FIRST; sessionid=SECOND"],
    ["Set-Cookie", "sid=FIRST; sessionid=SECOND; Secure; HttpOnly"],
    ["Authorization", "Digest username=public, credential=FIRST, response=SECOND"],
    ["Proxy-Authorization", "AWS4-HMAC-SHA256 Credential=FIRST, SignedHeaders=host, Signature=SECOND"],
    ["auth", "Digest username=public, credential=FIRST, response=SECOND"],
  ])("masks the whole compound credential header: %s", async (header, value) => {
    const first = "PRIVACY_SYNTHETIC_HEADER_FIRST";
    const second = "PRIVACY_SYNTHETIC_HEADER_SECOND";
    const chunk = `provider-error-marker ${header}: ${value!.replace("FIRST", first).replace("SECOND", second)}`;
    const exported = await exportSyntheticStderr(chunk);
    expect(exported).not.toContain(first);
    expect(exported).not.toContain(second);
    const records = exported.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toEqual({ event: "stderr", data: { chunk: `provider-error-marker ${header}: [REDACTED]` }, marker: "safe-marker" });
    expect(records[1]).toEqual({ event: "error", data: { code: "SAFE_ERROR_MARKER" } });
  });

  it.each([
    ["client_secret array", 'client_secret=["SECRET"]'],
    ["x-api-key object", 'x-api-key: {"v":"SECRET"}'],
    ["accessToken object", 'accessToken:{"v":"SECRET"}'],
    ["private_key array", 'private_key=["SECRET"]'],
    ["spaced token separator", 'token : ["SECRET"]'],
    ["spaced api key separator", 'api_key = ["SECRET"]'],
    ["truncated cookie quote", 'cookie="SECRET'],
    ["truncated dsn quote", "dsn='SECRET"],
    ["container with trailing prose", 'token={"session":"SECRET"} trailing text'],
    ["container after earlier bracket", 'see [1] token={"session":"SECRET"}'],
    ["cookie after earlier bracket", 'see [1] cookie:["SECRET"]'],
    ["malformed bare scalar adjacent container", 'token=prefix{"session":"SECRET"}'],
    ["malformed bare scalar adjacent quote", 'token=prefix"SECRET"'],
    ["bare client secret scalar", 'client_secret=SECRET publicDetail=visible'],
    ["bare camelCase token scalar", 'accessToken:SECRET publicDetail=visible'],
    ["bare private key scalar", "private_key" + "=SECRET publicDetail=visible"],
  ])("uses the canonical sensitive key rule for bare assignments: %s", async (_name, value) => {
    const secret = "PRIVACY_SYNTHETIC_BARE_CREDENTIAL";
    const chunk = "provider-error-marker " + value!.replace("SECRET", secret);
    const exported = await exportSyntheticStderr(chunk);
    expect(exported).not.toContain(secret);
    const records = exported.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({ event: "stderr", marker: "safe-marker" });
    expect(records[0].data.chunk).toContain("provider-error-marker");
    expect(records[0].data.chunk).toContain("[REDACTED]");
    if (_name!.endsWith("scalar")) expect(records[0].data.chunk).toContain("publicDetail=visible");
    expect(records[1]).toEqual({ event: "error", data: { code: "SAFE_ERROR_MARKER" } });
  });

  it("preserves public bare assignments and a clean prefixed JSON suffix", async () => {
    const chunk = 'provider-error-marker publicDetail=visible status: ready upstream={"publicDetail":"visible","port":7}';
    const exported = await exportSyntheticStderr(chunk);
    expect(JSON.parse(exported.trimEnd().split("\n")[0]!).data.chunk).toBe(chunk);
  });

  it.each([
    ["quoted key before array", (secret: string) => `provider-error-marker "cookie": ["${secret}"]`],
    ["bare token before object", (secret: string) => `provider-error-marker token={"session":"${secret}"}`],
    ["bare api key before array", (secret: string) => `provider-error-marker api_key=["${secret}"]`],
    ["quoted key before pretty array", (secret: string) => `provider-error-marker "cookie":\n[\n "${secret}"\n]`],
    ["bare cookie before pretty array", (secret: string) => `provider-error-marker cookie:\n[\n "${secret}"\n]`],
    ["malformed quoted assignment before valid suffix", (secret: string) => `provider-error-marker password='${secret} {"publicDetail":"${secret}"}`],
  ] as const)("keeps sensitive prefix context across a parseable suffix: %s", async (_name, buildChunk) => {
    const secret = "PRIVACY_SYNTHETIC_SPLIT_CREDENTIAL";
    const exported = await exportSyntheticStderr(buildChunk(secret));
    expect(exported).not.toContain(secret);
    const records = exported.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({ event: "stderr", marker: "safe-marker" });
    expect(records[0].data.chunk).toContain("provider-error-marker");
    expect(records[0].data.chunk).toContain("[REDACTED]");
    expect(records[1]).toEqual({ event: "error", data: { code: "SAFE_ERROR_MARKER" } });
  });

  it("conservatively masks malformed text tails while preserving independent JSONL events", async () => {
    const exported = await exportSyntheticStderr('warn: missing "token": expected string\npublic-tail-marker');
    const records = exported.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(records[0].data.chunk).toBe("warn: missing [REDACTED]");
    expect(exported).not.toContain("public-tail-marker");
    expect(records[1]).toEqual({ event: "error", data: { code: "SAFE_ERROR_MARKER" } });
  });

  it("preserves every CRLF separator in complete multi-record JSONL", async () => {
    const exported = await exportSyntheticStderr('{"apiKey":"PRIVACY_SYNTHETIC_CRLF_SECRET"}', {}, "\r\n");
    expect(exported).not.toContain("PRIVACY_SYNTHETIC_CRLF_SECRET");
    expect(exported.split("\r\n")).toHaveLength(3);
    const records = exported.trimEnd().split("\r\n").map((line) => JSON.parse(line));
    expect(JSON.parse(records[0].data.chunk)).toEqual({ apiKey: "[REDACTED]" });
    expect(records[1]).toEqual({ event: "error", data: { code: "SAFE_ERROR_MARKER" } });
  });

  it.each([
    ["quoted key prefix username", '/Users/alice/proj upstream={"apiKey":"PRIVACY_SYNTHETIC_STATE_SECRET\\'],
    ["assignment prefix username", '/home/alice/proj api_key="PRIVACY_SYNTHETIC_STATE_SECRET'],
    ["earliest malformed assignment", 'password=\'PRIVACY_SYNTHETIC_STATE_SECRET {"cookie":["public"]'],
    ["parseable prefix before multiline secret", 'loaded {}\nerror: {\n "cookie": [\n "PRIVACY_SYNTHETIC_STATE_SECRET"\n ],\n "tags": []'],
    ["stray parseable suffix after multiline secret", 'error: {\n "cookie": [\n "PRIVACY_SYNTHETIC_STATE_SECRET"\n ],\n "tags": []'],
  ])("masks malformed chunk state without bypassing privacy: %s", async (_name, chunk) => {
    const exported = await exportSyntheticStderr(chunk!, { username: "alice" });
    expect(exported).not.toContain("PRIVACY_SYNTHETIC_STATE_SECRET");
    expect(exported).not.toContain("/Users/alice");
    expect(exported).not.toContain("/home/alice");
    const records = exported.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(records[0].data.chunk).toContain("[REDACTED]");
    expect(records[1]).toEqual({ event: "error", data: { code: "SAFE_ERROR_MARKER" } });
  });

  it("preserves a long nonsecret backslash run", async () => {
    const chunk = "safe-prefix " + "\\".repeat(20000) + " safe-suffix";
    const exported = await exportSyntheticStderr(chunk);
    expect(JSON.parse(exported.trimEnd().split("\n")[0]!).data.chunk).toBe(chunk);
  });

  it("masks real double-encoded credentials containing quotes and escaped-newline key prefixes", async () => {
    const secret = 'PRIVACY_SYNTHETIC_QUOTE_HEAD"PRIVACY_SYNTHETIC_QUOTE_TAIL';
    for (const chunk of [
      `upstream=${JSON.stringify(JSON.stringify({ password: secret }))}`,
      `upstream=\\n${JSON.stringify(JSON.stringify({ apiKey: secret }))}`,
    ]) {
      const exported = await exportSyntheticStderr(chunk);
      expect(exported).not.toContain("PRIVACY_SYNTHETIC_QUOTE_HEAD");
      expect(exported).not.toContain("PRIVACY_SYNTHETIC_QUOTE_TAIL");
      const records = exported.trimEnd().split("\n").map((line) => JSON.parse(line));
      expect(records[0].data.chunk).toContain("[REDACTED]");
      expect(records[1]).toEqual({ event: "error", data: { code: "SAFE_ERROR_MARKER" } });
    }
  });

  it("preserves long interior whitespace in public JSON strings", async () => {
    const publicDetail = "safe-prefix" + " ".repeat(20000) + "safe-suffix";
    const exported = await exportSyntheticStderr(JSON.stringify({ publicDetail }));
    const record = JSON.parse(exported.trimEnd().split("\n")[0]!);
    expect(JSON.parse(record.data.chunk)).toEqual({ publicDetail });
  });

  it.each([
    ["prefixed sensitive array", (secret: string) => `provider-error-marker upstream=${JSON.stringify({ cookie: [secret], publicDetail: "public-marker" })}`, true],
    ["prefixed sensitive object", (secret: string) => `provider-error-marker upstream=${JSON.stringify({ cookie: { session: secret }, publicDetail: "public-marker" })}`, true],
    ["prefixed pretty container", (secret: string) => `provider-error-marker upstream=${JSON.stringify({ cookie: [secret], publicDetail: "public-marker" }, null, 2)}`, true],
    ["prefixed nested encoded object", (secret: string) => `provider-error-marker upstream=${JSON.stringify({ detail: JSON.stringify({ apiKey: secret }), publicDetail: "public-marker" })}`, true],
    ["unterminated double assignment", (secret: string) => `provider-error-marker api_key="${secret}`, false],
    ["unterminated single assignment", (secret: string) => `provider-error-marker password='${secret}`, false],
    ["trailing backslash fragment", (secret: string) => `provider-error-marker upstream={"apiKey":"${secret}\\`, false],
    ["trailing backslash assignment", (secret: string) => `provider-error-marker api_key="${secret}\\`, false],
  ] as const)("redacts prefixed containers and incomplete credentials: %s", async (_name, buildChunk, validSuffix) => {
    const secret = "PRIVACY_SYNTHETIC_FINAL_CREDENTIAL";
    const exported = await exportSyntheticStderr(buildChunk(secret));
    expect(exported).not.toContain(secret);
    const records = exported.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({ event: "stderr", marker: "safe-marker" });
    expect(records[0].data.chunk).toContain("[REDACTED]");
    expect(records[1]).toEqual({ event: "error", data: { code: "SAFE_ERROR_MARKER" } });
    if (validSuffix) {
      expect(records[0].data.chunk).toContain("provider-error-marker");
      const suffix = JSON.parse(records[0].data.chunk.split("upstream=")[1]);
      expect(suffix.publicDetail).toBe("public-marker");
      if (suffix.detail) expect(JSON.parse(suffix.detail)).toEqual({ apiKey: "[REDACTED]" });
    }
  });

  it.each(["client_secret", "accessToken", "x-api-key", "cookie", "dsn", "private_key", "clientSecret"].flatMap((field) =>
    ["plain", "truncated", "escaped", "escaped-truncated"].map((format) => [field, format] as const)))(
    "redacts sensitive key family in prefixed fragments: %s %s", async (field, format) => {
      const secret = "PRIVACY_SYNTHETIC_FRAGMENT_CREDENTIAL";
      const json = JSON.stringify({ [field]: secret, publicDetail: 'safe "quoted" detail' });
      const quoted = format.startsWith("escaped") ? json.replace(/"/g, '\\"') : json;
      const fragment = format.endsWith("truncated") ? quoted.slice(0, quoted.indexOf(secret) + secret.length) : quoted;
      const exported = await exportSyntheticStderr(`provider-error-marker upstream=${fragment}`);
      expect(exported).not.toContain(secret);
      const records = exported.trimEnd().split("\n").map((line) => JSON.parse(line));
      expect(records[0]).toMatchObject({ event: "stderr", marker: "safe-marker" });
      expect(records[0].data.chunk).toContain("provider-error-marker");
      expect(records[0].data.chunk).toContain("[REDACTED]");
      expect(records[1]).toEqual({ event: "error", data: { code: "SAFE_ERROR_MARKER" } });
      // Escaped/truncated fragments are malformed JSON; they may be masked
      // conservatively. Only a valid suffix must retain its public fields.
      if (format === "plain") {
        const fragment = records[0].data.chunk.split("upstream=")[1];
        const parsed = JSON.parse(fragment);
        expect(parsed).toEqual({ [field]: "[REDACTED]", publicDetail: 'safe "quoted" detail' });
      }
    },
  );

  it.each(["array", "object"] as const)("redacts string leaves of sensitive %s values while preserving numeric metadata", async (shape) => {
    const secret = "PRIVACY_SYNTHETIC_COOKIE_CREDENTIAL";
    const cookie = shape === "array" ? [secret, { value: secret, count: 7 }, false] : { session: secret, count: 7, enabled: false };
    const exported = await exportSyntheticStderr(JSON.stringify({ cookie, tokenCount: 42, message: "public-marker" }, null, 2));
    expect(exported).not.toContain(secret);
    const record = JSON.parse(exported.trimEnd().split("\n")[0]!);
    expect(JSON.parse(record.data.chunk)).toEqual({
      cookie: shape === "array" ? ["[REDACTED]", { value: "[REDACTED]", count: 7 }, false] : { session: "[REDACTED]", count: 7, enabled: false },
      tokenCount: 42, message: "public-marker",
    });
  });

  it("retains other log events when structural JSON nesting exceeds the redaction bound", async () => {
    const secret = "PRIVACY_SYNTHETIC_STRUCTURAL_CREDENTIAL";
    const chunk = "[".repeat(6000) + JSON.stringify({ apiKey: secret }) + "]".repeat(6000);
    const exported = await exportSyntheticStderr(chunk);
    expect(exported).not.toContain(secret);
    const records = exported.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({ event: "stderr", marker: "safe-marker" });
    expect(records[0].data.chunk).toContain("[REDACTED]");
    expect(records[1]).toEqual({ event: "error", data: { code: "SAFE_ERROR_MARKER" } });
    let subtree = JSON.parse(records[0].data.chunk);
    let depth = 0;
    while (Array.isArray(subtree)) { subtree = subtree[0]; depth += 1; }
    expect(depth).toBeGreaterThan(0);
    expect(depth).toBeLessThanOrEqual(64);
    expect(subtree).toBe("[REDACTED]");
  });

  it.each([
    ["JSON apiKey", (secret: string) => JSON.stringify({ apiKey: secret, message: "provider-error-marker", detail: 'safe "quoted" C:\\fixture\\public.txt' })],
    ["JSON api_key", (secret: string) => JSON.stringify({ api_key: secret, message: "provider-error-marker", detail: 'safe "quoted" C:\\fixture\\public.txt' })],
    ["JSON pretty apiKey", (secret: string) => JSON.stringify({ apiKey: secret, message: "provider-error-marker", detail: 'safe "quoted" C:\\fixture\\public.txt' }, null, 2)],
    ["prefixed quoted apiKey", (secret: string) => `provider-error-marker upstream=${JSON.stringify({ apiKey: secret, not_apiKey: "safe-nonsecret-marker" })}`],
    ["quoted api_key assignment", (secret: string) => `provider-error-marker api_key="${secret}"`],
    ["single-quoted api_key assignment", (secret: string) => `provider-error-marker api_key='${secret}'`],
  ] as const)("redacts quoted secret fields in actual-format stderr JSONL: %s", async (_label, stderrChunk) => {
    const secret = "PRIVACY_SYNTHETIC_QUOTED_CREDENTIAL";
    const runsDir = join(tempDir, "runs");
    const runDir = join(runsDir, "synthetic-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "events.jsonl"), [
      { id: 1, event: "stderr", data: { chunk: stderrChunk(secret) }, timestamp: 1 },
      { id: 2, event: "error", data: { code: "AGENT_EXECUTION_FAILED", message: "safe-error-marker" }, timestamp: 2 },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");

    const sources = await buildRunEventLogSources(runsDir);
    expect(sources).toHaveLength(1);
    const result = await buildDiagnosticsZip({
      context: { app: { name: "mish" }, source: "synthetic-test" },
      sources,
    });
    const zip = await JSZip.loadAsync(result.zip);
    const exported = await zip.file("runs/synthetic-run/events.jsonl")!.async("string");
    expect(exported).not.toContain(secret);
    const records = exported.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ id: 1, event: "stderr", timestamp: 1 });
    expect(records[0].data.chunk).toContain("provider-error-marker");
    expect(records[0].data.chunk).toContain("[REDACTED]");
    expect(records[1]).toEqual({
      id: 2, event: "error", data: { code: "AGENT_EXECUTION_FAILED", message: "safe-error-marker" }, timestamp: 2,
    });
    if (_label.startsWith("JSON")) {
      expect(JSON.parse(records[0].data.chunk)).toMatchObject({
        message: "provider-error-marker", detail: 'safe "quoted" C:\\fixture\\public.txt',
      });
    }
    if (_label.startsWith("prefixed")) {
      expect(JSON.parse(records[0].data.chunk.split("upstream=")[1])).toEqual({
        apiKey: "[REDACTED]", not_apiKey: "[REDACTED]",
      });
    }
  });

  it("bounds nested JSON-string redaction without leaking credentials or breaking JSONL", async () => {
    const secret = "PRIVACY_SYNTHETIC_DEEPLY_WRAPPED_CREDENTIAL";
    let chunk = JSON.stringify({ apiKey: secret });
    for (let depth = 0; depth < 10; depth += 1) chunk = JSON.stringify({ detail: chunk });
    const logPath = join(tempDir, "nested-events.jsonl");
    await writeFile(logPath, JSON.stringify({ event: "stderr", data: { chunk }, marker: "safe-marker" }) + "\r\n", "utf8");
    const result = await buildDiagnosticsZip({
      context: { app: { name: "mish" }, source: "synthetic-test" },
      sources: [{ name: "runs/nested/events.jsonl", absolutePath: logPath, kind: "text" }],
    });
    const zip = await JSZip.loadAsync(result.zip);
    const exported = await zip.file("runs/nested/events.jsonl")!.async("string");
    expect(exported).not.toContain(secret);
    expect(exported.endsWith("\r\n")).toBe(true);
    expect(JSON.parse(exported)).toMatchObject({ event: "stderr", marker: "safe-marker" });
    let subtree = JSON.parse(exported).data.chunk;
    let decoded = 0;
    while (subtree !== "[REDACTED]" && decoded < 8) {
      subtree = JSON.parse(subtree).detail;
      decoded += 1;
    }
    expect(decoded).toBeGreaterThan(0);
    expect(subtree).toBe("[REDACTED]");
  });

  it("packages logs with redacted manifest and machine info", async () => {
    const logPath = join(tempDir, "daemon.log");
    await writeFile(logPath, "GET /api?token=abc123 ok\n", "utf8");

    const result = await buildDiagnosticsZip({
      context: {
        app: { name: "mish", version: "1.2.3", packaged: false },
        source: "test",
        namespace: "default",
      },
      sources: [{ name: "logs/daemon/latest.log", absolutePath: logPath, kind: "text" }],
      redaction: { username: "alice" },
    });

    const zip = await JSZip.loadAsync(result.zip);
    const log = await zip.file("logs/daemon/latest.log")!.async("string");
    expect(log).toContain("token=[REDACTED]");

    const manifest = JSON.parse(await zip.file("summary/manifest.json")!.async("string"));
    expect(manifest.app.name).toBe("mish");
    expect(manifest.namespace).toBe("default");
    expect(manifest.files[0].name).toBe("logs/daemon/latest.log");
    expect(manifest.warnings).toEqual([]);

    const machine = JSON.parse(await zip.file("summary/machine-info.json")!.async("string"));
    expect(typeof machine.platform).toBe("string");
    expect(machine.hostname).toBe("[REDACTED]");
    expect(machine.username).toBe("[REDACTED]");
  });

  it("includes redacted in-memory summaries for failures that happened before a run existed", async () => {
    const result = await buildDiagnosticsZip({
      context: { app: { name: "mish" }, source: "test" },
      sources: [],
      redaction: { username: "alice" },
      summaries: {
        "runtime-health.json": {
          amr: { sessionState: "reauth_required", credentialRevision: "safe-digest" },
          note: "/Users/alice/private",
        },
      },
    });

    const zip = await JSZip.loadAsync(result.zip);
    const runtimeHealth = await zip.file("summary/runtime-health.json")!.async("string");
    expect(runtimeHealth).toContain('"sessionState": "reauth_required"');
    expect(runtimeHealth).toContain('/Users/<USER>/private');
    expect(runtimeHealth).not.toContain('/Users/alice');
  });

  it("records a warning placeholder when a file cannot be read", async () => {
    const result = await buildDiagnosticsZip({
      context: {
        app: { name: "mish" },
        source: "test",
      },
      sources: [{ name: "logs/missing.log", absolutePath: join(tempDir, "no-such.log"), kind: "text" }],
    });

    const zip = await JSZip.loadAsync(result.zip);
    const placeholder = await zip.file("logs/missing.log")!.async("string");
    expect(placeholder).toContain("file unavailable");
    expect(result.manifest.warnings.length).toBe(1);
  });
});
