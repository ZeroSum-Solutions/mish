/** Deterministic JSON: object keys sorted recursively, two-space indent, trailing newline. */

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = sortKeys(child);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/**
 * The committed catalog.json layout: sorted keys, top-level fields indented, each row compact on
 * its own line. Keeps the file under the CI changed-file blob guard (1 MiB) at the full 291-item
 * snapshot while diffs stay one line per changed row.
 */
export function catalogFileText(catalog: { rows: readonly unknown[] }): string {
  const sorted = sortKeys(catalog) as Record<string, unknown>;
  const fields = Object.keys(sorted).map((key) => {
    if (key === 'rows') {
      const rows = (sorted.rows as unknown[]).map((row) => `    ${JSON.stringify(row)}`);
      return `  "rows": [\n${rows.join(',\n')}\n  ]`;
    }
    return `  ${JSON.stringify(key)}: ${JSON.stringify(sorted[key])}`;
  });
  return `{\n${fields.join(',\n')}\n}\n`;
}
