import assert from 'node:assert/strict';
import test from 'node:test';
import { SectionStream, SseParser, parseJsonObject, type StreamedUnit } from '../src/stream.ts';

const document = {
  brand: { name: 'A "quoted" {name}', descriptor: 'x]y\\z' },
  sections: [
    { id: 's1', text: { a: '1' }, items: { k: [{ text: { t: '}' } }] } },
    { id: 's2', text: { a: '[2]' } },
    { id: 's3', text: { a: '3' } },
  ],
};

function collect(text: string, chunk: number): StreamedUnit[] {
  const stream = new SectionStream();
  const out: StreamedUnit[] = [];
  for (let index = 0; index < text.length; index += chunk) out.push(...stream.push(text.slice(index, index + chunk)));
  assert.equal(stream.text(), text);
  return out;
}

test('SectionStream yields the brand and each section as it closes, at any chunk size', () => {
  const text = JSON.stringify(document, null, 2);
  for (const chunk of [1, 3, 7, 50, 10_000]) {
    const units = collect(text, chunk);
    assert.deepEqual(units.map((unit) => (unit.kind === 'brand' ? 'brand' : `section:${unit.index}`)), ['brand', 'section:0', 'section:1', 'section:2'], `chunk ${chunk}`);
    assert.deepEqual(units[0]!.value, document.brand);
    assert.deepEqual(units[2]!.value, document.sections[1]);
  }
});

test('SectionStream handles sections listed before the brand', () => {
  const text = JSON.stringify({ sections: document.sections, brand: document.brand });
  const units = collect(text, 5);
  assert.deepEqual(units.map((unit) => unit.kind), ['section', 'section', 'section', 'brand']);
});

test('SectionStream ignores nested objects that are not units', () => {
  const text = JSON.stringify({ meta: { nested: { deeper: [1, 2] } }, brand: { name: 'B' }, sections: [{ id: 'only' }] });
  const units = collect(text, 4);
  assert.deepEqual(units, [{ kind: 'brand', value: { name: 'B' } }, { kind: 'section', index: 0, value: { id: 'only' } }]);
});

test('SseParser splits data lines across chunks and skips the DONE sentinel', () => {
  const parser = new SseParser();
  const first = parser.push('data: {"a":1}\n\ndata: {"b"');
  const second = parser.push(':2}\r\ndata: [DONE]\n\n');
  assert.deepEqual(first, ['{"a":1}']);
  assert.deepEqual(second, ['{"b":2}']);
});

test('parseJsonObject tolerates fences and prose around the object', () => {
  assert.deepEqual(parseJsonObject('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonObject('Here you go: {"a": {"b": [1]}} thanks'), { a: { b: [1] } });
  assert.throws(() => parseJsonObject('no object here'), /not a JSON object/);
});

// G8 dry run (ownedinstitution x DeepSeek, `now-showing`): the model closed the object early after each
// card group's last key, on every retry. The parser recovers exactly that, and nothing else.
const CARD_TEMPLATE = { id: 'now-showing', content: { label: 'x', card1Title: 'x', card1Alt: 'x', card2Title: 'x', card2Alt: 'x' } };

test('parseJsonObject: stray closers after a card group are removed when the result has the template shape', () => {
  const broken = '{"id": "now-showing", "content": {"label": "Now showing", "card1Title": "Slow Light", "card1Alt": "Frames."}, "card2Title": "Warp and Weft", "card2Alt": "Cloth."}}}';
  assert.throws(() => parseJsonObject(broken), 'without a template it still fails');
  assert.deepEqual(parseJsonObject(broken, CARD_TEMPLATE), {
    id: 'now-showing', content: { label: 'Now showing', card1Title: 'Slow Light', card1Alt: 'Frames.', card2Title: 'Warp and Weft', card2Alt: 'Cloth.' },
  });
});

test('parseJsonObject: a recovery that would not match the template shape still fails', () => {
  // A missing key cannot be recovered by removing braces.
  assert.throws(() => parseJsonObject('{"id": "now-showing", "content": {"label": "x", "card1Title": "x"}, "card1Alt": "x"}}', CARD_TEMPLATE));
  // A genuinely nested object the template does not have is refused too.
  assert.throws(() => parseJsonObject('{"id": "now-showing", "content": {"label": "x", "card1Title": "x", "card1Alt": "x", "card2Title": "x", "card2Alt": {"a": "x"}}}}', CARD_TEMPLATE));
});

test('parseJsonObject: valid JSON and fenced answers parse exactly as before', () => {
  const valid = { id: 'now-showing', content: { label: 'a', card1Title: 'b', card1Alt: 'c }, not a closer', card2Title: 'd', card2Alt: 'e' } };
  assert.deepEqual(parseJsonObject(JSON.stringify(valid), CARD_TEMPLATE), valid);
  assert.deepEqual(parseJsonObject(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``, CARD_TEMPLATE), valid);
});
