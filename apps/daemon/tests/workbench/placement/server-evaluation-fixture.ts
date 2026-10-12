// Owned single process mirroring startDaemonRuntime: native bootstrap, stage it for the
// server module, optionally replace the owned root, then evaluate the actual server module.
import { mkdirSync, readdirSync, renameSync } from 'node:fs';
import * as bootstrapModule from '../../../src/workbench/placement/owner-bootstrap.js';

const config = JSON.parse(process.argv[2]!) as { env: Record<string, string>; replace: boolean };
Object.assign(process.env, config.env);
const bootstrap = bootstrapModule.preparePlacementBootstrap({ projectRoot: '/nonexistent-project-root' });
if (bootstrap.mode !== 'coordinated') throw new Error('coordinated bootstrap required');
// Absent on the pre-correction candidate (RED capture); the supported entrypoint stages it.
(bootstrapModule as { stagePlacementBootstrapForServerEvaluation?: (b: typeof bootstrap) => void }).stagePlacementBootstrapForServerEvaluation?.(bootstrap);
const root = bootstrap.canonicalDataRoot;
if (config.replace) { renameSync(root, `${root}-retained`); mkdirSync(root, { mode: 0o700 }); }
const report: Record<string, unknown> = { fixturePid: process.pid, root };
try { await import('../../../src/server.js'); report.evaluated = true; }
catch (error) { report.evaluated = false; report.reason = (error as { reason?: string }).reason ?? String(error); }
report.rootEntries = readdirSync(root).sort();
bootstrap.owner.close();
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(0);
