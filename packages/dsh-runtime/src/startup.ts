import type { Context } from '@deepseek-ai/cordis';
import { parseCmdline } from '@deepseek-ai/dsh-cmdline';
import { Command } from 'commander';

export const name = 'mish-startup';
export const inject = ['cmdlineArgs'];
export const MISH_STARTUP_SERVICE = 'mishStartup';

export interface MishStartupValues {
  mode: 'models' | 'probe' | 'stdio';
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mishStartup?: MishStartupValues;
  }
}

export function apply(ctx: Context): void {
  const program = new Command()
    .name('dsh --profile mish')
    .description('Run the Mishh Mashh JSONL profile adapter.')
    .helpOption('-h, --help', 'show this help')
    .option('--models', 'print the Harness model catalog and exit')
    .option('--probe', 'print profile compatibility and exit')
    .option('--stdio', 'serve one Mishh Mashh run over JSONL stdio')
    .action((options: { models?: boolean; probe?: boolean; stdio?: boolean }) => {
      const modes = [options.models, options.probe, options.stdio].filter(Boolean);
      if (modes.length !== 1) {
        program.error('error: exactly one of --models, --probe, or --stdio is required');
      }
      let mode: MishStartupValues['mode'] = 'stdio';
      if (options.models) mode = 'models';
      else if (options.probe) mode = 'probe';
      ctx.provide(MISH_STARTUP_SERVICE, { mode });
    });
  parseCmdline(ctx, program);
}
