import { isObject, type Json } from './spine.ts';
/** Canonical full-record comparison. IDs are structural; every other value must agree before
 * two object records count as duplicate filler. Shared names, prices or titles alone never fail. */
function fingerprint(value: Json): Json {
  if (typeof value === 'string') return value.trim().replace(/\s+/g, ' ');
  if (Array.isArray(value)) return value.map(fingerprint);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).filter((key) => key !== 'id').sort().map((key) => [key, fingerprint(value[key]!)]));
  return value;
}
/** Only schema-declared variable arrays are checked. Fixed grids and
 * repeatable primitive values keep their existing contract. The helper never deletes a record. */
export function duplicateVariableItems(recipe: Json, minima: Json | undefined): string[] {
  const duplicates: string[] = [];
  const walk = (value: Json | undefined, shape: Json | undefined, at: string): void => {
    if (typeof shape === 'number' && Array.isArray(value)) {
      const seen = new Map<string, number>();
      value.forEach((item, index) => {
        if (!isObject(item)) return;
        const key = JSON.stringify(fingerprint(item));
        if (seen.has(key)) duplicates.push(`${at}[${index}] duplicates ${at}[${seen.get(key)}]`);
        else seen.set(key, index);
      });
    } else if (Array.isArray(shape) && Array.isArray(value)) shape.forEach((child, index) => walk(value[index], child, `${at}[${index}]`));
    else if (isObject(shape) && isObject(value)) for (const [key, child] of Object.entries(shape)) walk(value[key], child, at ? `${at}.${key}` : key);
  };
  walk(recipe, minima, '');
  return duplicates;
}
