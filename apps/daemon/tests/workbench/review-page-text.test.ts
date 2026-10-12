import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { declaredFrameSources } from '../../src/workbench/review/cdp-worker.js';
import { renderReviewEvidenceMessage, renderReviewEvidenceParam } from '@open-design/contracts';
import {
  ev, evidenceRole, evidenceSelector, evidenceUrl, evidenceVocabulary, PageText, pathDepthOf, readPageText, UNVERIFIED, type EvidenceContext, type EvidenceParam, type EvidenceText,
} from '../../src/workbench/review/evidence.js';
import { consoleRecord, consoleSource, describeConsoleRecord } from '../../src/workbench/review/page-text.js';

// B4-2 round 7 (captain): taint by type. Page strings are PageText; evidence is
// EvidenceText; the only ways between them are a closed vocabulary, a URL
// checked against the run's serve log and allow-list, or the digest token.

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/** The text a reader sees for a parameter or message (the contract's renderer). */
const shown = (value: EvidenceParam | EvidenceText): string => 'kind' in value ? renderReviewEvidenceParam(value) : renderReviewEvidenceMessage(value);
const context = (served: string[] = [], allowed: string[] = []): EvidenceContext => ({ served: path => served.includes(path), allowedOrigin: origin => allowed.includes(origin) });

describe('PageText is opaque', () => {
  it('prints, interpolates and serializes only as its length+digest token', () => {
    const secret = PageText.of('SECRET value');
    const token = `<page text: 12 chars, sha256 ${sha('SECRET value').slice(0, 12)}>`;
    expect(shown(secret.token())).toBe(token);
    expect(String(secret)).toBe(token);
    expect(`${secret}`).toBe(token);
    expect(JSON.stringify({ secret })).toBe(JSON.stringify({ secret: token }));
    expect(readPageText(secret)).toBe('SECRET value');
  });

  it('the compiler refuses page text, plain strings and keys outside the template table inside evidence', () => {
    const text = PageText.of('SECRET');
    // @ts-expect-error a PageText is not evidence
    expect(() => ev('cta.unnamed', text)).toThrow(TypeError);
    // @ts-expect-error a plain string is not evidence either
    expect(() => ev('cta.unnamed', 'SECRET')).toThrow(TypeError);
    // @ts-expect-error nor is a template key outside the closed table
    expect(() => ev('free.text')).toThrow();
    // @ts-expect-error nor can a plain string be assigned to evidence
    const assigned: EvidenceText = 'SECRET';
    expect(assigned).toBe('SECRET');
    expect(shown(ev('cta.unnamed', text.token()))).toMatch(/^<page text: 6 chars/u);
    expect(() => ev('cta.unnamed')).toThrow(/takes 1 parameters/u);
  });
});

describe('URLs become evidence only through the serve log and allow-list', () => {
  it('keeps a served project path, digests any other project path (Sol round 6: <a href="/s3cr3t_path">)', () => {
    expect(shown(evidenceUrl(PageText.of('book.html?ref=a#x'), context(['book.html']), 'http://project.od-review.localhost/index.html'))).toBe(`http://project.od-review.localhost/book.html?~q5:${sha('ref=a').slice(0, 12)}`);
    const unserved = evidenceUrl(PageText.of('/s3cr3t_path'), context(['book.html']), 'http://project.od-review.localhost/index.html');
    expect(shown(unserved)).toBe(`http://project.od-review.localhost/~redacted:d1:${sha('/s3cr3t_path').slice(0, 12)}`);
  });

  it('keeps an allow-listed origin and digests every other origin (Sol round 6: page-chosen sourceURL host)', () => {
    expect(shown(evidenceUrl(PageText.of('https://good.example-cdn.com/a/b?q=1'), context([], ['https://good.example-cdn.com'])))).toBe(`https://good.example-cdn.com/~redacted:d2:${sha('/a/b?q=1').slice(0, 12)}:q3`);
    const unverified = evidenceUrl(PageText.of('https://s3cr3t.example.com/f.js'), context([], ['https://good.example-cdn.com']));
    expect(shown(unverified)).toBe(`~origin:${sha('https://s3cr3t.example.com').slice(0, 12)}/~redacted:d1:${sha('/f.js').slice(0, 12)}`);
    expect(shown(unverified)).not.toContain('s3cr3t');
  });

  it('keeps a known scheme, digests an unknown one, and never keeps userinfo or fragments', () => {
    expect(shown(evidenceUrl(PageText.of('data:text/html,<b>SECRET</b>'), UNVERIFIED))).toBe('data:~redacted');
    expect(shown(evidenceUrl(PageText.of('x-s3cr3t:payload'), UNVERIFIED))).toBe(`~origin:${sha('x-s3cr3t:').slice(0, 12)}:~redacted`);
    expect(shown(evidenceUrl(PageText.of('https://user:pw@good.example-cdn.com/p#frag'), context([], ['https://good.example-cdn.com'])))).not.toMatch(/user|pw|frag/u);
    expect(shown(evidenceUrl(PageText.of('not a url'), UNVERIFIED))).toBe('~unparseable-url');
  });

  it('caps a deep path at 200 segments and flags the cap', () => {
    expect(pathDepthOf(`/${Array(201).fill('a').join('/')}`)).toEqual({ pathDepth: 200, pathDepthCapped: true });
    expect(pathDepthOf('/a/b')).toEqual({ pathDepth: 2, pathDepthCapped: false });
  });
});

describe('console records keep no message body and a vouched-for source', () => {
  it.each([
    '//[2606:4700::1]/reset/SECRET?key=VALUE', '//例え.テスト/reset/SECRET?key=VALUE', 'https://cdn.example.com/~redacted:d1:deadbeefcafe',
    'data:text/html,<div>SECRET</div>', "https://host/x?q='SECRET'", 'url(//host/x?key=SECRET)', 'TypeError: cannot read SECRET of undefined',
  ])('%s', text => {
    const record = consoleRecord({ kind: 'console', text: PageText.of(text), source: null });
    expect(record).toMatchObject({ kind: 'console', level: 'error', count: 1, length: text.length, sha256: sha(text), source: null });
    expect(`${JSON.stringify(record)} ${shown(describeConsoleRecord(record))}`).not.toMatch(/SECRET|VALUE|deadbeefcafe|例え|2606/u);
  });

  it('a served project source keeps its path; an unserved or external source keeps digests, its origin only when allow-listed', () => {
    const ctx = context(['js/app.js'], ['https://good.example-cdn.com']);
    expect(consoleSource(PageText.of('http://project.od-review.localhost/js/app.js?v=3'), 11, 4, ctx)).toEqual({ origin: 'http://project.od-review.localhost', originSha256: null, path: '/js/app.js', pathQuerySha256: null, line: 12, column: 5 });
    expect(consoleSource(PageText.of('http://project.od-review.localhost/SECRET.js'), 0, 0, ctx)).toEqual({ origin: 'http://project.od-review.localhost', originSha256: null, path: null, pathQuerySha256: sha('/SECRET.js'), line: 1, column: 1 });
    expect(consoleSource(PageText.of('https://good.example-cdn.com/lib.js'), 0, 0, ctx)).toEqual({ origin: 'https://good.example-cdn.com', originSha256: null, path: null, pathQuerySha256: sha('/lib.js'), line: 1, column: 1 });
    const spoofed = consoleSource(PageText.of('https://s3cr3t.example.com/f.js'), 0, 0, ctx)!;
    expect(spoofed).toEqual({ origin: null, originSha256: sha('https://s3cr3t.example.com'), path: null, pathQuerySha256: sha('/f.js'), line: 1, column: 1 });
    expect(shown(describeConsoleRecord(consoleRecord({ kind: 'exception', text: PageText.of('x'), source: spoofed })))).not.toContain('s3cr3t');
    expect(consoleSource(PageText.of('data:text/javascript,SECRET'), 1, 1, ctx)).toEqual({ origin: 'data:', originSha256: null, path: null, pathQuerySha256: null, line: 2, column: 2 });
    expect(consoleSource(null, 0, 0, ctx)).toBeNull();
  });

  it('records the same message from the same place with the same id', () => {
    const where = consoleSource(PageText.of('http://project.od-review.localhost/a.js'), 1, 1, context(['a.js']));
    expect(consoleRecord({ kind: 'exception', text: PageText.of('boom'), source: where }).id).toBe(consoleRecord({ kind: 'exception', text: PageText.of('boom'), source: where }).id);
    expect(consoleRecord({ kind: 'exception', text: PageText.of('boom'), source: where }).id).not.toBe(consoleRecord({ kind: 'console', text: PageText.of('boom'), source: null }).id);
  });
});

describe('closed vocabularies', () => {
  it('roles keep ARIA roles and HTML tag names; anything else is the token', () => {
    for (const role of ['button', 'link', 'tab', 'doc-toc', 'a', 'input']) expect(shown(evidenceRole(PageText.of(role)))).toBe(role);
    for (const role of ['https://cdn.example.com/SECRET', 'button SECRET', '']) expect(shown(evidenceRole(PageText.of(role)))).toMatch(/^<page text: /u);
  });

  it('resource types keep the CDP vocabulary', () => {
    expect(shown(evidenceVocabulary(PageText.of('Stylesheet'), 'resourceType'))).toBe('Stylesheet');
    expect(shown(evidenceVocabulary(PageText.of('SECRET'), 'resourceType'))).toMatch(/^<page text: /u);
  });

  it('selectors are structural only: known-tag nth-of-type paths from body; any id, short or long, is the token (Sol round 7 BLOCK)', () => {
    for (const selector of ['body > main > p:nth-of-type(2)', 'body > main > svg > g:nth-of-type(2)', 'body > main > a']) expect(shown(evidenceSelector(PageText.of(selector)))).toBe(selector);
    for (const selector of ['#cta', '#CANARY_14', 'a#cta', 'body > #main-nav > a', '#sk_live_9f8a7b6c5d4e3f2a1b', 'p.tok-ab12cd34ef56ab78cd90', 'body > main > t4gs3cret-widget', 'div[data-token="SECRET"]', 'main > p']) {
      expect(shown(evidenceSelector(PageText.of(selector))), selector).toMatch(/^<page text: \d+ chars, sha256 [0-9a-f]{12}>$/u);
    }
  });

  it('custom elements become positional wildcards, so findings under them stay locatable (Sol round 8 WARN)', () => {
    expect(shown(evidenceSelector(PageText.of('body > *:nth-child(2) > a')))).toBe('body > *:nth-child(2) > a');
    expect(shown(evidenceSelector(PageText.of('body > main > *:nth-child(3) > p:nth-of-type(2)')))).toBe('body > main > *:nth-child(3) > p:nth-of-type(2)');
    for (const selector of ['body > x-card > a', 'body > *:nth-child(0) > a', 'body > *', '*:nth-child(1) > a']) expect(shown(evidenceSelector(PageText.of(selector))), selector).toMatch(/^<page text: /u);
  });
});

describe('the base URL comes from the real <base> href attribute', () => {
  const doc = 'http://project.od-review.localhost/index.html';
  it('resolves frame sources like Chrome', () => {
    expect(declaredFrameSources('<base href="https://good.example-cdn.com/"><iframe src="embed">', doc)).toEqual(['https://good.example-cdn.com/embed']);
    expect(declaredFrameSources('<base data-x=" href=https://wrong.example/" href="https://right.example/"><iframe src="embed">', doc)).toEqual(['https://right.example/embed']);
    expect(declaredFrameSources('<base href="https://right.example/a&#x2f;"><iframe src="embed">', doc)).toEqual(['https://right.example/a/embed']);
    expect(declaredFrameSources('<template><iframe src="https://good.example-cdn.com/t"></iframe></template><noscript><iframe src="https://good.example-cdn.com/n"></iframe></noscript>', doc)).toEqual([]);
    expect(declaredFrameSources('<script>document.write(\'<base href="https://good.example-cdn.com/">\')</script><iframe src="embed">', doc)).toEqual(['http://project.od-review.localhost/embed']);
  });
});
