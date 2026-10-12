/**
 * Spine handling for the fast lane.
 *
 * A family recipe is a spine (section ids and types, asset ids, destination keys, brand
 * geometry) plus text. The model only ever sees and returns the text. These helpers cut the
 * editable text out of a recipe, map every text slot to its schema limit, and merge model text
 * back into the spine without letting the model touch anything locked.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type PathSegment = string | number;

/**
 * Keys whose subtrees the model never edits, split by where they live. `assets`, `destinations`
 * and `type` are structural at every depth (asset references, link targets, section-type tags),
 * never text, so they lock wherever they occur. The rest are recipe/brand metadata that only
 * ever belongs at one place in the tree; locking them by name alone would also swallow a
 * same-named text slot elsewhere, such as a section's own `wordmark` nav text — those lock by
 * path instead.
 */
export const LOCKED_ANYWHERE_KEYS: ReadonlySet<string> = new Set(['assets', 'destinations', 'type']);
/** Locked only as a direct child of the recipe root. */
export const LOCKED_ROOT_KEYS: ReadonlySet<string> = new Set(['schemaVersion', 'family', 'revision']);
/** Locked only as a direct child of `brand`. */
export const LOCKED_BRAND_KEYS: ReadonlySet<string> = new Set(['wordmark', 'language', 'colors', 'fonts', 'displayGlyphSet']);
/** Every key name locked somewhere in the tree. Locking itself is path-aware; see `isLockedAt`. */
export const LOCKED_KEYS: ReadonlySet<string> = new Set([...LOCKED_ANYWHERE_KEYS, ...LOCKED_ROOT_KEYS, ...LOCKED_BRAND_KEYS]);

/** True when `key` at path `at` (as `pathLabel` prints it) names a locked subtree. */
function isLockedAt(key: string, at: string): boolean {
  if (LOCKED_ANYWHERE_KEYS.has(key)) return true;
  if (at === key) return LOCKED_ROOT_KEYS.has(key);
  if (at === `brand.${key}`) return LOCKED_BRAND_KEYS.has(key);
  return false;
}

/** Kept in the template so a section can be matched back; never taken from the model. */
export const ANCHOR_KEY = 'id';

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const asObject = (value: Json | undefined): JsonObject => (isObject(value) ? value : {});

/**
 * The text the model may write: string leaves outside locked subtrees, ids kept as anchors.
 * `lockedPaths` names individual slots (as `pathLabel` prints them) to keep from the spine too.
 * A null leaf is a nullable slot an earlier run left empty, so it stays in the template as null:
 * the model still sees the slot with its limit and its atom kind and may fill it on this run.
 */
export function editableTemplate(value: Json, key?: string, lockedPaths: ReadonlySet<string> = new Set(), at = ''): Json | undefined {
  if (key !== undefined && isLockedAt(key, at)) return undefined;
  if (typeof value === 'string' || value === null) return lockedPaths.has(at) ? undefined : value;
  if (Array.isArray(value)) {
    const items = value.map((item, index) => editableTemplate(item, undefined, lockedPaths, `${at}[${index}]`));
    if (items.every((item) => item === undefined)) return undefined;
    return items.map((item) => (item === undefined ? {} : item));
  }
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const [childKey, child] of Object.entries(value)) {
      const editable = editableTemplate(child, childKey, lockedPaths, at ? `${at}.${childKey}` : childKey);
      if (editable !== undefined) out[childKey] = editable;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

/**
 * Text-slot paths whose value in `next` is identical to `previous`, walked the same way
 * `editableTemplate` walks the tree: a locked-by-key subtree never enters the result (it is never
 * sent to the model or to Jev either way, so there is nothing to gain by naming it), and the
 * section anchor (`id`) never does either, matching `collectFaithfulnessSlots`'s own exclusion —
 * an unchanged id is not a reason to hide the id from the model, which still needs it to match a
 * streamed section answer back to its unit.
 *
 * On a re-target, `previous` is the recipe this build is re-targeting FROM (the project's current,
 * already-verified manifest) and `next` is the spine it is re-targeting TO. A path this returns is
 * one a fresh fill would answer with the text it already has, so the caller adds it to
 * `lockedPaths` and both the fill step (via `editableTemplate`/`mergeIntoSpine`) and the
 * faithfulness check (via `collectFaithfulnessSlots`) skip it, exactly as an explicit `--lock`
 * path already does.
 *
 * `previous` being `undefined` (a first build, no prior recipe) returns an empty set, so a first
 * build's behaviour is unchanged: every editable slot still ships.
 *
 * Comparison is plain string equality, and only between two strings: a slot that is still `null`
 * on both sides is never reported unchanged, because there is no text there for a fresh fill to
 * repeat, only an open nullable slot the new brief may or may not fill this time — locking it
 * would silently and permanently drop it from `editableTemplate`'s output (locked paths are
 * excluded, not kept as null), contradicting that function's own contract for a null leaf. A slot
 * that goes from a string to `null`, or `null` to a string, is a real change and is excluded the
 * same way a changed string pair is. Nothing here calls the model or Jev. Arrays match
 * items by the `id` anchor when both sides carry one, exactly the way `mergeIntoSpine` already
 * matches a candidate section back to its spine counterpart, falling back to position only when an
 * item carries no anchor. This is what makes the walk safe against a reordered, inserted or
 * removed section: matching by position alone could compare a shifted-in section's text against
 * an unrelated former neighbour and, on an accidental exact-text coincidence, wrongly read it as
 * unchanged. Matching by `id` finds the section's TRUE former counterpart (or none, if the id is
 * new), so a section that moved is still recognised as itself and a section that was actually
 * replaced is never compared against text that merely happened to sit at the same index.
 *
 * There is no cross-slot derivation among editable text in any bundled family today: the fast
 * lane already fills the brand block and each section as independently fillable units (see
 * `unitsOf`), and every bundled family's compiler (`plugins/_official/examples/agency-<family>`,
 * `compiler/scripts/render.ts`) reads each `content`/`text` field exactly once when rendering. So
 * no path here needs widening to a set of dependents beyond itself today. This function returns a
 * flat set with no notion of dependents, and nothing downstream widens it — if a family ever grows
 * a text slot computed from another slot (the way `destinations` already computes a link target
 * from a locked, non-text field), a caller folding this result into `lockedPaths` would need to
 * exclude that dependent path itself before unioning; no hook for that exists yet.
 */
export function unchangedTextPaths(previous: Json | undefined, next: Json): Set<string> {
  const out = new Set<string>();
  if (previous === undefined) return out;
  const walk = (nextNode: Json, prevNode: Json | undefined, key: string | undefined, at: string): void => {
    if (key !== undefined && (isLockedAt(key, at) || key === ANCHOR_KEY)) return;
    if (typeof nextNode === 'string' || nextNode === null) {
      // A still-null nullable slot is an open slot, not unchanged text: there is nothing there
      // for a fresh fill to repeat, only a fact the brief may or may not supply this time. Only a
      // non-null string equal to its former self is text a fresh fill would answer identically.
      if (typeof nextNode === 'string' && nextNode === prevNode) out.add(at);
      return;
    }
    if (Array.isArray(nextNode)) {
      const prevItems = Array.isArray(prevNode) ? prevNode : [];
      nextNode.forEach((item, index) => {
        const anchor = isObject(item) ? item[ANCHOR_KEY] : undefined;
        const counterpart = typeof anchor === 'string'
          ? prevItems.find((candidate) => isObject(candidate) && candidate[ANCHOR_KEY] === anchor)
          : prevItems[index];
        walk(item, counterpart, undefined, `${at}[${index}]`);
      });
      return;
    }
    if (isObject(nextNode)) {
      const prevObject = isObject(prevNode) ? prevNode : {};
      for (const [childKey, child] of Object.entries(nextNode)) {
        walk(child, prevObject[childKey], childKey, at ? `${at}.${childKey}` : childKey);
      }
    }
  };
  walk(next, previous, undefined, '');
  return out;
}

/**
 * Resolve a schema node to the one object the walkers read. Three JSON Schema forms are folded
 * in: a local `$ref` (keywords written next to it, such as `x-atom` or `x-mock`, are kept and win
 * over the target's own), an `allOf` (properties merged), and a `oneOf`/`anyOf` whose only
 * non-`null` branch is the real shape (that branch is entered, and a `{ "type": "null" }` branch
 * shows up as `null` in the resolved node's `type` list, so the node still reads as nullable).
 * A `oneOf` with more than one non-null branch is left as written: there is no single shape to
 * walk into.
 */
function derefSchema(node: Json | undefined, root: JsonObject, depth = 0): JsonObject | undefined {
  if (!isObject(node) || depth > 32) return undefined;
  let current: JsonObject = node;
  const ref = current.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/')) {
    const target = ref
      .slice(2)
      .split('/')
      .reduce<Json | undefined>((acc, segment) => (isObject(acc) ? acc[segment] : undefined), root);
    const resolved = derefSchema(target, root, depth + 1);
    if (!resolved) return undefined;
    const { $ref: _ref, ...siblings } = current;
    current = { ...resolved, ...siblings };
  }
  const alternatives = Array.isArray(current.oneOf) ? current.oneOf : Array.isArray(current.anyOf) ? current.anyOf : undefined;
  if (alternatives) {
    const branches = alternatives.map((branch) => derefSchema(branch, root, depth + 1)).filter((branch): branch is JsonObject => branch !== undefined);
    const isNull = (branch: JsonObject) => branch.type === 'null';
    const shapes = branches.filter((branch) => !isNull(branch));
    const only = shapes[0];
    if (shapes.length === 1 && only) {
      const { oneOf: _oneOf, anyOf: _anyOf, ...wrapper } = current;
      const ownTypes = Array.isArray(only.type) ? only.type : only.type === undefined ? [] : [only.type];
      const types = [...new Set([...ownTypes, ...(branches.some(isNull) ? ['null'] : [])])];
      current = { ...only, ...wrapper, ...(types.length > 0 ? { type: types } : {}) };
    }
  }
  if (Array.isArray(current.allOf)) {
    const merged: JsonObject = { ...current };
    const properties: JsonObject = isObject(current.properties) ? { ...current.properties } : {};
    for (const part of current.allOf) {
      const resolved = derefSchema(part, root, depth + 1);
      if (!resolved) continue;
      if (isObject(resolved.properties)) Object.assign(properties, resolved.properties);
      for (const carry of ['maxLength', 'prefixItems', 'items']) {
        if (merged[carry] === undefined && resolved[carry] !== undefined) merged[carry] = resolved[carry];
      }
    }
    merged.properties = properties;
    return merged;
  }
  return current;
}

/** True when a resolved schema node admits `null`. */
function admitsNull(node: JsonObject | undefined): boolean {
  const types = node?.type;
  return types === 'null' || (Array.isArray(types) && types.includes('null'));
}

/**
 * Walks the schema alongside the template and keeps whatever `leaf` reads off the schema node of
 * each string slot, dropping the slots it reads nothing from. The result has the template's
 * shape, so limits and atom kinds travel beside the template through the same reshaping.
 */
function shapeFromSchema(
  schema: Json | undefined,
  template: Json,
  root: JsonObject,
  leaf: (node: JsonObject | undefined) => Json | undefined,
  group?: (node: JsonObject | undefined) => Json | undefined,
): Json | undefined {
  const node = derefSchema(schema, root);
  // A null leaf is an empty nullable slot, a text slot like any other: it keeps its limit and kind.
  if (typeof template === 'string' || template === null) return leaf(node);
  // A group (object or array) the reader claims whole, such as a nullable KPI card, stops here.
  const claimed = group?.(node);
  if (claimed !== undefined) return claimed;
  if (Array.isArray(template)) {
    const prefix = Array.isArray(node?.prefixItems) ? node.prefixItems : [];
    const items = template.map((item, index) => shapeFromSchema(asObject(prefix[index] ?? node?.items), item, root, leaf, group));
    return items.every((item) => item === undefined) ? undefined : items.map((item) => item ?? {});
  }
  if (isObject(template)) {
    const properties = isObject(node?.properties) ? node.properties : {};
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(template)) {
      const value = shapeFromSchema(asObject(properties[key]), child, root, leaf, group);
      if (value !== undefined) out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

/** A limits object with the template's shape: each string leaf becomes its schema maxLength. */
export function limitsFor(schema: JsonObject, template: Json, root: JsonObject = schema): Json | undefined {
  return shapeFromSchema(schema, template, root, (node) => (typeof node?.maxLength === 'number' ? node.maxLength : undefined));
}

/**
 * The slots a family schema marks nullable, with the kind of fact each one holds: a node whose
 * schema type admits `null` and which names an `x-atom` kind (`phone`, `email`, `address`,
 * `plain`, or a group kind such as `kpi-item`). Same shape as the limits object. Usually the node
 * is a string leaf; a group (a whole repeat item or a section's content array) that is nullable
 * as one piece carries its kind at the group's own position instead of at its leaves, because the
 * family contract accepts `null` only for the whole group. A slot that is absent here must stay a
 * string.
 */
export function atomKindsFor(schema: JsonObject, template: Json, root: JsonObject = schema): Json | undefined {
  const kindOf = (node: JsonObject | undefined) => {
    const kind = node?.['x-atom'];
    return admitsNull(node) && typeof kind === 'string' ? kind : undefined;
  };
  return shapeFromSchema(schema, template, root, kindOf, kindOf);
}

/**
 * The fewest items a repeatable array may honestly hold, at the array's own position (not its
 * leaves) — same shape convention as `atomKindsFor`'s group kind, but for a whole array rather
 * than a nullable card. Added for `practice`. A family declares this by giving an array's schema
 * node a `minItems` lower than its `maxItems` (`contract.ts`'s own `items.min` / `items.count`,
 * see a family's `slots.ts`); an array whose `minItems` equals its `maxItems` is not variable at
 * all and is skipped here, exactly like every other family that has never used this convention (in
 * which case this returns `undefined` for that path and the model sees no minimum at all — it must
 * keep the template's own length, the prior behavior, byte for byte). This is what lets
 * `prompt.ts`'s ARRAY MINIMA block tell the model it may return fewer than `maxItems` items —
 * without it, a family's own `min` was only ever a post-hoc validation floor the CONTRACT
 * enforced after the fact, never something the fill prompt itself communicated; a brief starved
 * for facts (a solo practitioner, a single product) had no way to learn it could submit a short,
 * honest array instead of padding to match what TEMPLATE showed.
 */
export function arrayMinimaFor(schema: JsonObject, template: Json, root: JsonObject = schema): Json | undefined {
  return shapeFromSchema(schema, template, root, () => undefined, (node) => {
    const min = node?.minItems;
    const max = node?.maxItems;
    return node?.type === 'array' && typeof min === 'number' && typeof max === 'number' && min < max ? min : undefined;
  });
}

/**
 * Path labels of the lists a family marks `x-drop: 'items'`: a list whose unsupported items may be
 * removed after the faithfulness repairs (down to `minItems`). Opt-in per list, because some lists
 * are procedures — dropping a middle step publishes a gapped procedure (Sol review of #286).
 */
export function droppableListPathsFor(schema: JsonObject, template: Json, root: JsonObject = schema): ReadonlySet<string> {
  const shape = shapeFromSchema(schema, template, root, () => undefined, (node) => (node?.type === 'array' && node['x-drop'] === 'items' ? 1 : undefined));
  return new Set(arrayMinimaPathsOf(shape).keys());
}

/**
 * The text slots under schema nodes carrying `keyword: true`, as path labels. The mark sits on any
 * schema node (next to a `$ref` or an `x-atom` too) and is inherited by every string leaf under
 * it. A null leaf under a mark is included, as its path.
 */
function markedPathsFor(keyword: string, schema: JsonObject, template: Json, root: JsonObject): Set<string> {
  const out = new Set<string>();
  const walk = (schemaNode: Json | undefined, value: Json, inherited: boolean, at: string): void => {
    const node = derefSchema(schemaNode, root);
    const marked = inherited || node?.[keyword] === true;
    if (typeof value === 'string' || value === null) {
      if (marked) out.add(at);
      return;
    }
    if (Array.isArray(value)) {
      const prefix = Array.isArray(node?.prefixItems) ? node.prefixItems : [];
      value.forEach((item, index) => walk(prefix[index] ?? node?.items, item, marked, `${at}[${index}]`));
      return;
    }
    if (isObject(value)) {
      const properties = isObject(node?.properties) ? node.properties : {};
      for (const [key, child] of Object.entries(value)) walk(properties[key], child, marked, at ? `${at}.${key}` : key);
    }
  };
  walk(schema, template, false, '');
  return out;
}

/**
 * The text slots a family schema marks as illustrative sample data with `"x-mock": true`, as
 * path labels (see `markedPathsFor`). Such a slot is still filled like any other (the page shows
 * it under a fixed sample-data caption); only the faithfulness gate skips it, since it makes no
 * claim about the client.
 */
export function mockPathsFor(schema: JsonObject, template: Json, root: JsonObject = schema): Set<string> {
  return markedPathsFor('x-mock', schema, template, root);
}

/**
 * G6 (claim and name honesty in every family): the text slots a family schema marks
 * `"x-alt-text": true` — image alt text and photo captions, which describe what a STOCK or
 * placeholder photo shows rather than assert a fact about the client. Deliberately its OWN
 * marker, not `x-mock`: `x-mock` removes a slot from the faithfulness gate ENTIRELY, Jev
 * included, and is reserved for slots that are genuinely illustrative SAMPLE DATA a family shows
 * under a visible caption. An alt-text field is neither — it is real, required copy a live build
 * must still write and that Jev's own probabilistic judgment must still see; only the two NEW,
 * narrower deterministic checks this marker exists for (`run.ts`'s `deterministicSentenceClaimFlags`/
 * `deterministicProperNounFlags` calls) skip it, because a generic photo caption ("a wooden deck
 * off a back porch") legitimately describes ordinary scene content with no brief anchor at all —
 * see `run.ts`'s own call sites for exactly which two checks read this marker.
 */
export function altTextPathsFor(schema: JsonObject, template: Json, root: JsonObject = schema): Set<string> {
  return markedPathsFor('x-alt-text', schema, template, root);
}

/**
 * A g6-r1 audit round-5 firm directive follow-up introduced a `"x-heading": true` marker and a
 * `headingPathsFor` reader here, declaring some template text (a section title, a maben
 * placeholder card's title/excerpt/meta) a genuine fixed HEADING exempt from the faithfulness
 * gate whenever the fill left it unchanged from the reference and a heuristic
 * (`template-chrome.ts`'s `isClaimBearingHeading`) judged it non-claim-bearing. It was REMOVED in
 * g6-sol-r12 (Sol's own closure review of the g6-sol-r11 audit that had just re-verified it):
 * an in-memory "Ships nationwide" at halcyon's own declared heading path satisfied every one of
 * `isClaimBearingHeading`'s word-list tests and so was exempted, while `main` — which has never
 * had this mechanism — flags it as an unsupported claim. See `template-chrome.ts`'s own module
 * docblock for the full removal note. No schema declares `"x-heading": true` any more.
 */

/**
 * The text slots a family schema declares template LABELS with `"x-label": true` — a nav link
 * name, a section label, a row key such as "Postcode" or "Bus", a period such as "per month" — as
 * path labels (see `markedPathsFor`). A declared label the fill left exactly as the reference
 * wrote it is template chrome, not a fact (see template-chrome.ts). A slot without the mark is
 * never treated as a label, however short: the reference itself holds facts ("Free", a city).
 */
export function labelPathsFor(schema: JsonObject, template: Json, root: JsonObject = schema): Set<string> {
  return markedPathsFor('x-label', schema, template, root);
}

/**
 * An object with the template's shape holding `marker` at every string (or null) leaf whose path
 * label is in `paths`, and nothing else; `undefined` when no leaf is marked. The prompt's SAMPLE
 * block is built this way from `mockPathsFor`, so it travels beside the template exactly like the
 * limits and nullable objects.
 */
export function shapeOfPaths(template: Json, paths: ReadonlySet<string>, marker: string, at = ''): Json | undefined {
  if (typeof template === 'string' || template === null) return paths.has(at) ? marker : undefined;
  if (Array.isArray(template)) {
    const items = template.map((item, index) => shapeOfPaths(item, paths, marker, `${at}[${index}]`));
    return items.every((item) => item === undefined) ? undefined : items.map((item) => item ?? {});
  }
  if (isObject(template)) {
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(template)) {
      const value = shapeOfPaths(child, paths, marker, at ? `${at}.${key}` : key);
      if (value !== undefined) out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

/** The atom kinds whose text is a machine-read contact target (a `mailto:`, `tel:` or link). */
export type ContactKind = 'email' | 'phone' | 'url';
const CONTACT_KINDS: ReadonlySet<string> = new Set<ContactKind>(['email', 'phone', 'url']);
/** A slot key that names an email or phone even where the schema carries no `x-atom` kind. */
const CONTACT_KEY = /(?:^|[a-z])(email|phone)$/i;

/**
 * The text slots holding a contact atom, as path label -> kind: a schema node whose `x-atom` is
 * `email`, `phone` or `url` (nullable or not), or a slot whose key ends in `email`/`phone`
 * (`jobsEmail`, `phone`). `mergeIntoSpine` normalises these before the family compiler checks
 * their format (see `normalizeContactAtom`).
 */
export function contactPathsFor(schema: JsonObject, template: Json, root: JsonObject = schema): Map<string, ContactKind> {
  const kinds = shapeFromSchema(schema, template, root, (node) => {
    const kind = node?.['x-atom'];
    return typeof kind === 'string' && CONTACT_KINDS.has(kind) ? kind : undefined;
  });
  const out = new Map<string, ContactKind>();
  const walk = (value: Json | undefined, shape: Json | undefined, key: string | undefined, at: string): void => {
    if (typeof value === 'string' || value === null) {
      const byKey = key === undefined ? undefined : CONTACT_KEY.exec(key)?.[1]?.toLowerCase();
      const kind = typeof shape === 'string' ? shape : byKey;
      if (kind !== undefined) out.set(at, kind as ContactKind);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, Array.isArray(shape) ? shape[index] : undefined, undefined, `${at}[${index}]`));
      return;
    }
    if (isObject(value)) {
      for (const [childKey, child] of Object.entries(value)) walk(child, isObject(shape) ? shape[childKey] : undefined, childKey, at ? `${at}.${childKey}` : childKey);
    }
  };
  walk(template, kinds, undefined, '');
  return out;
}

/**
 * The text slots holding a PERSON'S NAME attributed to them by the page — a reviewer, a
 * testimonial's author, an attributed quote — as path labels: a schema node whose `x-atom` is
 * `person-name`. A supplied name is a fact like any other and must be checked, but names are a
 * category a Jev-style LLM judge can plausibly miss (a fabricated name reads as faithful prose
 * the same way a real one does), so `jev.ts`'s `deterministicAttributionFlags` checks every path
 * this returns by a hard string-presence test against the brief, never by LLM judgment alone. A
 * family marks a slot this way instead of `plain`/`atom` when it attributes a supplied quote or
 * review to a specific named person; a slot naming a thing (a product, a place, a business) is
 * never marked this way, only a slot naming a PERSON. Nullable like every other atom kind: a
 * brief that names no one gets `null`, never an invented reviewer name.
 */
export function personNamePathsFor(schema: JsonObject, template: Json, root: JsonObject = schema): Set<string> {
  const marks = shapeFromSchema(schema, template, root, (node) => (node?.['x-atom'] === 'person-name' ? true : undefined));
  const out = new Set<string>();
  const walk = (value: Json | undefined, shape: Json | undefined, at: string): void => {
    if (typeof value === 'string' || value === null) {
      if (shape === true) out.add(at);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, Array.isArray(shape) ? shape[index] : undefined, `${at}[${index}]`));
      return;
    }
    if (isObject(value)) {
      for (const [childKey, child] of Object.entries(value)) walk(child, isObject(shape) ? shape[childKey] : undefined, at ? `${at}.${childKey}` : childKey);
    }
  };
  walk(template, marks, '');
  return out;
}

/**
 * The text slots holding a QUOTE attributed to the brief itself — a testimonial, a review — as
 * path labels: a schema node whose `x-verify` is `quote`. See `jev.ts`'s `deterministicQuoteFlags`
 * for how these are traced against the brief; unlike `personNamePathsFor`'s atoms, a quote slot
 * is never nullable (a review item that exists always has its quote), so this reads `x-verify`
 * rather than `x-atom`.
 */
export function quotePathsFor(schema: JsonObject, template: Json, root: JsonObject = schema): Set<string> {
  const marks = shapeFromSchema(schema, template, root, (node) => (node?.['x-verify'] === 'quote' ? true : undefined));
  const out = new Set<string>();
  const walk = (value: Json | undefined, shape: Json | undefined, at: string): void => {
    if (typeof value === 'string' || value === null) {
      if (shape === true) out.add(at);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, Array.isArray(shape) ? shape[index] : undefined, `${at}[${index}]`));
      return;
    }
    if (isObject(value)) {
      for (const [childKey, child] of Object.entries(value)) walk(child, isObject(shape) ? shape[childKey] : undefined, at ? `${at}.${childKey}` : childKey);
    }
  };
  walk(template, marks, '');
  return out;
}

/**
 * The text slots holding a TRACEABLE fact — a practical detail, a gallery label, a place card, a
 * descriptor — as path labels: a schema node whose `x-verify` is `traceable`. Added by a round-10
 * audit pass (storefront-r6-grok.md item 7) as a new SHARED marker, deliberately positioned
 * between `quotePathsFor`'s full word-tracing (every content word AND the exact claim tokens, no
 * paraphrase credit) and the bare LLM judge (probabilistic, known to miss a plausible-sounding
 * invented detail the same way it misses an invented name — see `deterministicAttributionFlags`'s
 * own docblock): `jev.ts`'s `deterministicTraceableFlags` requires every stemmed content word to
 * trace to the brief, exactly like a quote's word-tracing half, but never requires a VERBATIM
 * contiguous run and never checks claim tokens on its own (a traceable row's own numbers are
 * already covered family-wide by `deterministicClaimFlags`, which runs on every slot regardless).
 * A row this marks is never nullable the way a `person-name`/`phone`/`email` atom is (it names a
 * FACT the family chose to render, not an optional contact detail), so — like `quotePathsFor` — it
 * reads `x-verify` rather than `x-atom`.
 */
export function traceablePathsFor(schema: JsonObject, template: Json, root: JsonObject = schema): Set<string> {
  const marks = shapeFromSchema(schema, template, root, (node) => (node?.['x-verify'] === 'traceable' ? true : undefined));
  const out = new Set<string>();
  const walk = (value: Json | undefined, shape: Json | undefined, at: string): void => {
    if (typeof value === 'string' || value === null) {
      if (shape === true) out.add(at);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, Array.isArray(shape) ? shape[index] : undefined, `${at}[${index}]`));
      return;
    }
    if (isObject(value)) {
      for (const [childKey, child] of Object.entries(value)) walk(child, isObject(shape) ? shape[childKey] : undefined, at ? `${at}.${childKey}` : childKey);
    }
  };
  walk(template, marks, '');
  return out;
}

/**
 * The text slots a family schema marks `x-verify: 'exact-date'` — a dedicated DATE slot (halcyon's
 * event dates), as path labels. G8 dry run: halcyon's event dates are copied verbatim from the
 * brief ("Thu 2 Oct"), but the prose gates expand a page "Thu"/"Oct" to "thursday"/"october"
 * (page-side only, g6-sol-r11) and so could never pass them; Sol ruled two gate exceptions for
 * this unsafe (g8fix-jev-sol-ruling.md, -ruling2.md). A slot this marks is checked instead by
 * `exact-date.ts`'s `deterministicExactDateFlags` — the whole value must EQUAL a date expression
 * the brief itself writes — which is stricter than the prose trace, and is exempt from the two
 * prose checks (`deterministicSentenceClaimFlags`/`deterministicProperNounFlags`) only. Jev and
 * every other deterministic check (the claim-number check included) still see it.
 */
export function exactDatePathsFor(schema: JsonObject, template: Json, root: JsonObject = schema): Set<string> {
  const marks = shapeFromSchema(schema, template, root, (node) => (node?.['x-verify'] === 'exact-date' ? true : undefined));
  const out = new Set<string>();
  const walk = (value: Json | undefined, shape: Json | undefined, at: string): void => {
    if (typeof value === 'string' || value === null) {
      if (shape === true) out.add(at);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, Array.isArray(shape) ? shape[index] : undefined, `${at}[${index}]`));
      return;
    }
    if (isObject(value)) {
      for (const [childKey, child] of Object.entries(value)) walk(child, isObject(shape) ? shape[childKey] : undefined, at ? `${at}.${childKey}` : childKey);
    }
  };
  walk(template, marks, '');
  return out;
}

/**
 * The text slots holding an HOURS/SCHEDULE DAY LABEL ("Mon-Thu", "Fri", "Sat-Sun") \u2014 as path
 * labels: a schema node whose `x-verify` is `hours-label`. Added for `practice` (a clinic's own
 * hours row): a round-4 Grok audit on that family found the day label used to sit only under
 * `x-label` (template chrome), which let an unchanged reference-recipe day label skip the
 * faithfulness gate entirely \u2014 publishing the reference clinic's own Mon-Thu/Fri/Sat-Sun schedule
 * for a brief that only ever stated Saturday hours. See `hours-label.ts` for how these are
 * checked (G8 final: the label's day SET must be exactly the day set the brief gives for that
 * row's hours; `hoursRowValuePathsFor` names the row's value). Never nullable, same as
 * `quotePathsFor`/`traceablePathsFor`; kept as its
 * own marker rather than folded into `traceable` so a family can adopt whichever check actually
 * fits an hours row's own day-token shape.
 */
export function hoursLabelPathsFor(schema: JsonObject, template: Json, root: JsonObject = schema): Set<string> {
  const marks = shapeFromSchema(schema, template, root, (node) => (node?.['x-verify'] === 'hours-label' ? true : undefined));
  const out = new Set<string>();
  const walk = (value: Json | undefined, shape: Json | undefined, at: string): void => {
    if (typeof value === 'string' || value === null) {
      if (shape === true) out.add(at);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, Array.isArray(shape) ? shape[index] : undefined, `${at}[${index}]`));
      return;
    }
    if (isObject(value)) {
      for (const [childKey, child] of Object.entries(value)) walk(child, isObject(shape) ? shape[childKey] : undefined, at ? `${at}.${childKey}` : childKey);
    }
  };
  walk(template, marks, '');
  return out;
}

/**
 * PR #137 rule 4: each hours group (`x-hours-group` on an `x-verify: 'hours-label'` node) -> its
 * label paths in page order. A group shows every row of the brief's hours clause, or none.
 */
export function hoursGroupsFor(schema: JsonObject, template: Json, root: JsonObject = schema): Map<string, string[]> {
  const marks = shapeFromSchema(schema, template, root, (node) => (
    node?.['x-verify'] === 'hours-label' && typeof node['x-hours-group'] === 'string' ? node['x-hours-group'] : undefined
  ));
  const out = new Map<string, string[]>();
  const walk = (value: Json | undefined, shape: Json | undefined, at: string): void => {
    if (typeof value === 'string' || value === null) {
      if (typeof shape === 'string') out.set(shape, [...(out.get(shape) ?? []), at]);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, Array.isArray(shape) ? shape[index] : undefined, `${at}[${index}]`));
      return;
    }
    if (isObject(value)) {
      for (const [childKey, child] of Object.entries(value)) walk(child, isObject(shape) ? shape[childKey] : undefined, at ? `${at}.${childKey}` : childKey);
    }
  };
  walk(template, marks, '');
  return out;
}

/** PR #137 rule 5: the slots a family schema marks `x-verify: 'hours-null'` (always null). */
export function hoursNullPathsFor(schema: JsonObject, template: Json, root: JsonObject = schema): Set<string> {
  const marks = shapeFromSchema(schema, template, root, (node) => (node?.['x-verify'] === 'hours-null' ? true : undefined));
  const out = new Set<string>();
  const walk = (value: Json | undefined, shape: Json | undefined, at: string): void => {
    if (typeof value === 'string' || value === null) {
      if (shape === true) out.add(at);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, Array.isArray(shape) ? shape[index] : undefined, `${at}[${index}]`));
      return;
    }
    if (isObject(value)) {
      for (const [childKey, child] of Object.entries(value)) walk(child, isObject(shape) ? shape[childKey] : undefined, at ? `${at}.${childKey}` : childKey);
    }
  };
  walk(template, marks, '');
  return out;
}

/**
 * Label path -> sibling path for every text slot whose schema node has `x-verify: <verify>` and a
 * string `<key>` naming a sibling key in the same object. Used for the hours gate's
 * `x-hours-heading` (a combined hours slot's column heading, e.g. "Open") and `x-hours-days` (the
 * slot holding the days an `x-verify: 'hours-value'` time belongs to).
 */
export function siblingPathsFor(schema: JsonObject, template: Json, verify: string, key: string, root: JsonObject = schema): Map<string, string> {
  const marks = shapeFromSchema(schema, template, root, (node) => (
    node?.['x-verify'] === verify && typeof node[key] === 'string' ? node[key] : undefined
  ));
  const out = new Map<string, string>();
  const walk = (value: Json | undefined, shape: Json | undefined, at: string, own: string | undefined): void => {
    if (typeof value === 'string' || value === null) {
      if (typeof shape === 'string' && own !== undefined) out.set(at, `${at.slice(0, at.length - own.length)}${shape}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, Array.isArray(shape) ? shape[index] : undefined, `${at}[${index}]`, undefined));
      return;
    }
    if (isObject(value)) {
      for (const [childKey, child] of Object.entries(value)) walk(child, isObject(shape) ? shape[childKey] : undefined, at ? `${at}.${childKey}` : childKey, childKey);
    }
  };
  walk(template, marks, '', undefined);
  return out;
}

/**
 * For every hours-label slot (`hoursLabelPathsFor`) whose schema node names its row's value slot
 * with `x-hours-value` (a SIBLING key: `"value"`, `"block1Value1"`), label path -> value path. G8
 * final: the hours-label gate checks that the label's days are the days the brief gives for THIS
 * row's hours, so it has to read the row's value. A label with no `x-hours-value` is a combined
 * slot ("Saturday, by appointment") whose own text carries the value.
 */
export function hoursRowValuePathsFor(schema: JsonObject, template: Json, root: JsonObject = schema): Map<string, string> {
  const marks = shapeFromSchema(schema, template, root, (node) => (
    node?.['x-verify'] === 'hours-label' && typeof node['x-hours-value'] === 'string' ? node['x-hours-value'] : undefined
  ));
  const out = new Map<string, string>();
  const walk = (value: Json | undefined, shape: Json | undefined, at: string, key: string | undefined): void => {
    if (typeof value === 'string' || value === null) {
      if (typeof shape === 'string' && key !== undefined) out.set(at, `${at.slice(0, at.length - key.length)}${shape}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, Array.isArray(shape) ? shape[index] : undefined, `${at}[${index}]`, undefined));
      return;
    }
    if (isObject(value)) {
      for (const [childKey, child] of Object.entries(value)) walk(child, isObject(shape) ? shape[childKey] : undefined, at ? `${at}.${childKey}` : childKey, childKey);
    }
  };
  walk(template, marks, '', undefined);
  return out;
}

/**
 * The text slots holding a BOOK/CONTACT DESTINATION the page turns into a live `tel:`/`mailto:`/
 * `https:` link \u2014 as path labels: a schema node whose `x-verify` is `destination`. Added for
 * `practice`: a destination is nullable like any other atom (a brief with no booking URL, phone
 * or email still shows the call to book, but never a link), so unlike `quotePathsFor` this
 * includes a `null` leaf's path too, matching `personNamePathsFor`'s nullable handling. This is
 * distinct from `contactPathsFor`'s own equality check: a slot marked `x-atom: 'destination'`
 * (rather than `email`/`phone`/`url`) carries no `ContactKind` at all, so `deterministicContactFlags`
 * never reaches it even though it is exactly as fabricable as any other contact atom \u2014 see
 * `jev.ts`'s `deterministicDestinationFlags` for how these are traced against the brief instead.
 */
export function destinationPathsFor(schema: JsonObject, template: Json, root: JsonObject = schema): Set<string> {
  const marks = shapeFromSchema(schema, template, root, (node) => (node?.['x-verify'] === 'destination' ? true : undefined));
  const out = new Set<string>();
  const walk = (value: Json | undefined, shape: Json | undefined, at: string): void => {
    if (typeof value === 'string' || value === null) {
      if (shape === true) out.add(at);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, Array.isArray(shape) ? shape[index] : undefined, `${at}[${index}]`));
      return;
    }
    if (isObject(value)) {
      for (const [childKey, child] of Object.entries(value)) walk(child, isObject(shape) ? shape[childKey] : undefined, at ? `${at}.${childKey}` : childKey);
    }
  };
  walk(template, marks, '');
  return out;
}

const WRAPPERS: ReadonlyArray<readonly [string, string]> = [['"', '"'], ["'", "'"], ['\u201c', '\u201d'], ['\u2018', '\u2019'], ['`', '`'], ['<', '>'], ['(', ')'], ['[', ']'], ['{', '}']];
const CLOSERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{', '>': '<' };
const OPENERS: ReadonlySet<string> = new Set(['(', '[', '{', '<']);

/** True when every bracket in `text` closes one opened before it, and all are closed. */
function balanced(text: string): boolean {
  const stack: string[] = [];
  for (const char of text) {
    if (OPENERS.has(char)) stack.push(char);
    else if (CLOSERS[char] !== undefined && stack.pop() !== CLOSERS[char]) return false;
  }
  return stack.length === 0;
}

/** How many of `open` and of `close` `text` holds, for a pair of two distinct marks. */
function counts(text: string, open: string, close: string): { opens: number; closes: number } {
  let opens = 0;
  let closes = 0;
  for (const char of text) {
    if (char === open) opens += 1;
    else if (char === close) closes += 1;
  }
  return { opens, closes };
}

/**
 * A contact atom as the model copied it out of the brief's prose, reduced to the atom itself:
 * surrounding whitespace and sentence punctuation after it (`.,;:!?`) are removed; a closing
 * bracket or curly quote at the end is removed only when it has no partner inside the value; and a
 * quote or bracket pair around the WHOLE value is unwrapped. A leading quote or bracket is never
 * removed on its own — only together with its matching closer — so a value that legitimately
 * starts with one ("(828) 555-0135", `"desk"@x.com`) keeps it. "intake@anchorline.com." becomes
 * "intake@anchorline.com"; a value that is not an email or phone stays invalid and the compiler
 * still refuses it.
 */
export function normalizeContactAtom(value: string): string {
  const pairOf = (text: string) => WRAPPERS.find(([open, close]) => text.length >= 2 && text.startsWith(open) && text.endsWith(close));
  let text = value.trim();
  for (let guard = 0; guard < 16; guard += 1) {
    const before = text;
    text = text.replace(/[.,;:!?\s]+$/u, '');
    const last = text.at(-1);
    const wrapper = last === undefined ? undefined : WRAPPERS.find(([, close]) => close === last);
    const pair = pairOf(text);
    const inner = pair ? text.slice(pair[0].length, -pair[1].length) : undefined;
    // A wrapping pair goes only when what it wraps is whole on its own: no bracket left open and
    // no second straight quote (`"desk"@x.com"` is not wrapped by its first and last marks).
    const whole = inner !== undefined && balanced(inner) && (pair![0] !== pair![1] || !inner.includes(pair![0]));
    if (pair && whole) {
      text = inner!;
    } else if (wrapper && wrapper[0] !== wrapper[1]) {
      // A lone closer: a bracket or curly quote with more closes than opens. A straight quote at
      // the end is ambiguous (it may close one earlier in the value), so it is left for the repair.
      const { opens, closes } = counts(text, wrapper[0], wrapper[1]);
      if (closes > opens) text = text.slice(0, -1);
    }
    text = text.trim();
    if (text === before) break;
  }
  return text;
}

/** Every path label in an atom-kinds object: the slots a model may answer with `null`. */
export function nullablePathsOf(kinds: Json | undefined, at = '', out = new Set<string>()): Set<string> {
  if (typeof kinds === 'string') out.add(at);
  else if (Array.isArray(kinds)) kinds.forEach((item, index) => nullablePathsOf(item, `${at}[${index}]`, out));
  else if (isObject(kinds)) for (const [key, child] of Object.entries(kinds)) nullablePathsOf(child, at ? `${at}.${key}` : key, out);
  return out;
}

/** The array-minima shape (`arrayMinimaFor`'s own shape convention: a number at an array's own
 * position) flattened to a path -> minimum map, the same way `nullablePathsOf` flattens atom
 * kinds. */
export function arrayMinimaPathsOf(minima: Json | undefined, at = '', out = new Map<string, number>()): ReadonlyMap<string, number> {
  if (typeof minima === 'number') out.set(at, minima);
  else if (Array.isArray(minima)) minima.forEach((item, index) => arrayMinimaPathsOf(item, `${at}[${index}]`, out));
  else if (isObject(minima)) for (const [key, child] of Object.entries(minima)) arrayMinimaPathsOf(child, at ? `${at}.${key}` : key, out);
  return out;
}

/**
 * Single-key wrappers left behind when asset and destination keys are stripped, such as a
 * repeat item reduced to `{"text": {...}}`. Models mis-close them, so they are collapsed on the
 * way to the model and restored on the way back by following the template.
 */
const WRAPPER_KEYS: ReadonlySet<string> = new Set(['text', 'content']);

/**
 * Collapse wrappers in `value` wherever the `guide` (the template) has one. A limits object is
 * shaped with the template as guide so both collapse at the same places even where the limits
 * object lacks keys such as `id`.
 */
export function toModelShape(value: Json, guide: Json = value): Json {
  if (Array.isArray(guide)) {
    return Array.isArray(value) ? value.map((item, index) => toModelShape(item, guide[index] ?? item)) : value;
  }
  if (isObject(guide)) {
    const keys = Object.keys(guide);
    const only = keys[0];
    if (keys.length === 1 && only !== undefined && WRAPPER_KEYS.has(only) && isObject(guide[only])) {
      return isObject(value) && isObject(value[only]) ? toModelShape(value[only]!, guide[only]!) : value;
    }
    if (!isObject(value)) return value;
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value)) out[key] = toModelShape(child, key in guide ? guide[key]! : child);
    return out;
  }
  return value;
}

export function fromModelShape(answer: Json | undefined, template: Json): Json | undefined {
  if (answer === undefined) return undefined;
  if (Array.isArray(template)) {
    if (!Array.isArray(answer)) return answer;
    return answer.map((item, index) => (index < template.length ? (fromModelShape(item, template[index]!) ?? item) : item));
  }
  if (isObject(template)) {
    const keys = Object.keys(template);
    const only = keys[0];
    if (keys.length === 1 && only !== undefined && WRAPPER_KEYS.has(only) && isObject(template[only]) && isObject(answer) && !(only in answer)) {
      return { [only]: fromModelShape(answer, template[only]!) ?? answer };
    }
    if (!isObject(answer)) return answer;
    const out: JsonObject = { ...answer };
    for (const [key, child] of Object.entries(template)) {
      if (key in answer) out[key] = fromModelShape(answer[key], child) ?? answer[key]!;
    }
    return out;
  }
  return answer;
}

/** Limits shown to the model: the schema maximum with headroom, because models count loosely. */
export function softLimits(limits: Json | undefined, ratio = 0.85): Json | undefined {
  if (typeof limits === 'number') return Math.max(8, Math.floor(limits * ratio));
  if (Array.isArray(limits)) return limits.map((item) => softLimits(item, ratio) ?? {});
  if (isObject(limits)) {
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(limits)) {
      const soft = softLimits(child, ratio);
      if (soft !== undefined) out[key] = soft;
    }
    return out;
  }
  return undefined;
}

/**
 * Last-resort deterministic repair: cut every string over its hard limit at a word boundary.
 * Returns the clipped value and the paths that were cut, so the caller can report them. A
 * nulled slot has no length to cut, so it passes through untouched and is never reported.
 */
export function clipToLimits(value: Json, limits: Json | undefined, clipped: string[] = [], at = ''): Json {
  if (typeof value === 'string') {
    if (typeof limits !== 'number' || value.length <= limits) return value;
    const head = value.slice(0, limits);
    // Prefer cutting at the end of a complete sentence within the window: the last '.', '!' or
    // '?' followed by a space (or sitting at the very end of `head`), so long as it is not so
    // early that almost the whole slot would be thrown away (an abbreviation like "Mr." near the
    // start must not win). A truncated sentence ("...tracking each") reads as visibly broken in a
    // way a clause cut at a word boundary does not, so this is checked before the word-boundary
    // fallback below, never after it.
    const sentenceEnd = Math.max(
      ...['. ', '! ', '? '].map((terminator) => head.lastIndexOf(terminator)),
      /[.!?]$/.test(head) ? head.length - 1 : -1,
    );
    if (sentenceEnd > limits * 0.4) {
      clipped.push(at);
      return head.slice(0, sentenceEnd + 1).trimEnd();
    }
    const boundary = head.lastIndexOf(' ');
    const cut = (boundary > limits * 0.6 ? head.slice(0, boundary) : head).replace(/[\s,;:–-]+$/u, '');
    clipped.push(at);
    return cut || head;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => clipToLimits(item, Array.isArray(limits) ? limits[index] : undefined, clipped, `${at}[${index}]`));
  }
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = clipToLimits(child, isObject(limits) ? limits[key] : undefined, clipped, at ? `${at}.${key}` : key);
    }
    return out;
  }
  return value;
}

export type MergeReport = {
  applied: number;
  missing: string[];
  lockedPaths?: ReadonlySet<string>;
  /** Slots that accept `null`, as path labels; see `atomKindsFor` and `nullablePathsOf`. */
  nullablePaths?: ReadonlySet<string>;
  /** Paths the candidate answered with `null`: a fact the brief does not state. */
  nulled?: string[];
  /**
   * Illustrative sample-data slots (`x-mock`, see `mockPathsFor`), as path labels. The page shows
   * them under a fixed sample-data caption, so an empty or null answer there is not a refusal to
   * state a fact: the slot keeps the spine's own sample text and is reported in `sampleKept`, not
   * in `missing`.
   */
  samplePaths?: ReadonlySet<string>;
  /** Sample slots the candidate left empty or null, which kept the spine's sample text. */
  sampleKept?: string[];
  /** Contact atoms (see `contactPathsFor`): their text is normalised before it lands. */
  contactPaths?: ReadonlyMap<string, ContactKind>;
  /**
   * Repeatable arrays that may hold fewer items than the spine's own template length, with the
   * fewest each one needs; see `arrayMinimaFor`. Added for `practice`. Without this, a candidate
   * array shorter than the spine's is merged against the spine's FULL length regardless — the
   * spine's own extra positions have no candidate to draw from, so `mergeIntoSpine` reports each
   * one `missing`, exactly as if the model had left a required field empty. A family's own schema
   * `min` was useless as a fill-time instruction without this: telling a model it MAY submit
   * fewer items (`prompt.ts`'s ARRAY MINIMA block) and then still requiring the old fixed length
   * here would punish it for doing the honest thing.
   */
  arrayMinima?: ReadonlyMap<string, number>;
};

/** Whether `lockedPaths` holds `itemPath` itself or any path under it — i.e. whether the array
 * item at `itemPath` has at least one field a faithfulness repair (or any other caller) locked
 * against being overwritten. Used by `mergeIntoSpine`'s array-minima trim, below, to keep a tail
 * item the candidate omitted instead of reading its absence as "the model dropped it". */
function hasLockedDescendant(itemPath: string, lockedPaths: ReadonlySet<string> | undefined): boolean {
  if (!lockedPaths) return false;
  for (const path of lockedPaths) {
    if (path === itemPath || path.startsWith(`${itemPath}.`) || path.startsWith(`${itemPath}[`)) return true;
  }
  return false;
}

/**
 * Write model text into the spine. Locked subtrees, locked paths and anchors always come from
 * the spine. An array item that carries an anchor is matched by that anchor only, so a dropped
 * item is reported as missing rather than filled from whatever moved into its position; items
 * without an anchor are matched by position. A string the candidate lacks or leaves empty keeps
 * the spine's text and is reported as missing. `null` lands only on a nullable path, where it
 * means the brief states no such fact; `null` anywhere else counts as empty, so a required slot
 * the model nulled is reported as missing and takes the caller's existing repair path. A slot the
 * spine already holds null in is a text leaf too, so re-targeting fills it back in: a string
 * candidate lands and counts as applied, a null candidate keeps it null, and anything else is
 * reported as missing the same way an empty string is.
 */
export function mergeIntoSpine(spine: Json, candidate: Json | undefined, report: MergeReport, key?: string, at = ''): Json {
  if (key !== undefined && (isLockedAt(key, at) || key === ANCHOR_KEY)) return spine;
  if (typeof spine === 'string' || spine === null) {
    if (report.lockedPaths?.has(at)) return spine;
    if (candidate === null && report.nullablePaths?.has(at)) {
      report.nulled?.push(at);
      if (spine !== null) report.applied += 1;
      return null;
    }
    const raw = typeof candidate === 'string' ? candidate.trim() : '';
    const text = raw && report.contactPaths?.has(at) ? normalizeContactAtom(raw) : raw;
    if (!text && typeof spine === 'string' && spine.trim() && report.samplePaths?.has(at)) {
      report.sampleKept?.push(at);
      return spine;
    }
    if (!text) {
      report.missing.push(at);
      return spine;
    }
    if (text !== spine) report.applied += 1;
    return text;
  }
  // A whole group the family lets be null (see `atomKindsFor`): the brief states no such content.
  if (candidate === null && report.nullablePaths?.has(at) && !report.lockedPaths?.has(at) && (Array.isArray(spine) || isObject(spine))) {
    report.nulled?.push(at);
    report.applied += 1;
    return null;
  }
  if (Array.isArray(spine)) {
    const list = Array.isArray(candidate) ? candidate : [];
    // A repeatable array this path's own family schema allows to be shorter than the template
    // (see `MergeReport.arrayMinima`'s own doc): the spine itself is trimmed to the candidate's
    // own length first — never below the family's minimum, never beyond the template's own
    // length — so a model that honestly submitted fewer items is merged against exactly that
    // many spine slots, not padded out with positions no candidate item can ever fill.
    const min = report.arrayMinima?.get(at);
    let trimLength = min === undefined ? spine.length : Math.max(min, Math.min(spine.length, list.length));
    // Never trim away a tail item that still carries a LOCKED path: this array-minima allowance
    // is for an honest FIRST fill submitting fewer items than the template, not for a
    // faithfulness REPAIR whose candidate only covers the flagged unit and can just as easily
    // under-count on a whim — a repair that returns 2 provider cards when the 3rd was never
    // flagged (fully locked) must not read as "the 3rd was dropped"; the 3rd item's own locked
    // leaves already resist the missing candidate below and keep their spine text unchanged,
    // exactly as if `list` had echoed them back untouched.
    for (let index = spine.length - 1; index >= trimLength; index--) {
      if (hasLockedDescendant(`${at}[${index}]`, report.lockedPaths)) { trimLength = index + 1; break; }
    }
    const trimmedSpine = min === undefined ? spine : spine.slice(0, trimLength);
    return trimmedSpine.map((item, index) => {
      // A dropped optional section (`null` in a `sections` slot, see `sections.ts`) is not a text
      // slot: it stays dropped and is never reported missing.
      if (item === null && at === 'sections') return item;
      const anchor = isObject(item) ? item[ANCHOR_KEY] : undefined;
      const source = typeof anchor === 'string'
        ? list.find((entry) => isObject(entry) && entry[ANCHOR_KEY] === anchor)
        : list[index];
      return mergeIntoSpine(item, source, report, undefined, `${at}[${index}]`);
    });
  }
  if (isObject(spine)) {
    const source = isObject(candidate) ? candidate : {};
    const out: JsonObject = {};
    for (const [childKey, child] of Object.entries(spine)) {
      out[childKey] = mergeIntoSpine(child, source[childKey], report, childKey, at ? `${at}.${childKey}` : childKey);
    }
    return out;
  }
  return spine;
}

export function pathLabel(path: PathSegment[]): string {
  return path.map((segment, index) => (typeof segment === 'number' ? `[${segment}]` : index === 0 ? segment : `.${segment}`)).join('');
}

export function getAtPath(value: Json | undefined, path: PathSegment[]): Json | undefined {
  let current: Json | undefined = value;
  for (const segment of path) {
    if (typeof segment === 'number') current = Array.isArray(current) ? current[segment] : undefined;
    else current = isObject(current) ? current[segment] : undefined;
    if (current === undefined) return undefined;
  }
  return current;
}

/** Merge a candidate for one subtree of the spine, leaving every other subtree untouched. */
export function mergeAtPath(spine: Json, path: PathSegment[], candidate: Json | undefined, report: MergeReport): Json {
  const at = pathLabel(path);
  const last = path.at(-1);
  const key = typeof last === 'string' ? last : undefined;
  const replace = (node: Json, remaining: PathSegment[]): Json => {
    if (remaining.length === 0) return mergeIntoSpine(node, candidate, report, key, at);
    const [head, ...rest] = remaining;
    if (typeof head === 'number' && Array.isArray(node) && head < node.length) {
      return node.map((item, index) => (index === head ? replace(item, rest) : item));
    }
    if (typeof head === 'string' && isObject(node) && head in node) {
      return { ...node, [head]: replace(node[head]!, rest) };
    }
    throw new Error(`mergeAtPath: no such path ${at}`);
  };
  return replace(spine, path);
}

export type Unit = { label: string; path: PathSegment[]; template: Json; limits: Json | undefined };

/** The brand block and each section, as independently fillable units. */
export function unitsOf(template: Json, limits: Json | undefined): Unit[] {
  if (!isObject(template)) throw new Error('template must be an object');
  const units: Unit[] = [];
  if (template.brand !== undefined) {
    units.push({ label: 'brand', path: ['brand'], template: template.brand, limits: getAtPath(limits, ['brand']) });
  }
  const sections = Array.isArray(template.sections) ? template.sections : [];
  sections.forEach((section, index) => {
    // A dropped optional section (`null`, see `sections.ts`) has nothing to fill: no unit, no call.
    if (section === null) return;
    const id = isObject(section) && typeof section.id === 'string' ? section.id : `section-${index}`;
    units.push({ label: id, path: ['sections', index], template: section, limits: getAtPath(limits, ['sections', index]) });
  });
  return units;
}
