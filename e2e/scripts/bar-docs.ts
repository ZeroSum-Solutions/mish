import { writeFile } from 'node:fs/promises';
import { renderAgencyBarMarkdown } from '../benchmarks/quality/bar.ts';

await writeFile(new URL('../../docs/quality/agency-bar.md', import.meta.url), renderAgencyBarMarkdown());
