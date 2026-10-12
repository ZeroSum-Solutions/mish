/**
 * T54: the upgrade entries land on the configured console's plan surface
 * (`billing=plan`), never on a hardcoded pricing page. AMR is an upstream paid
 * service this fork does not operate, so without a configured console origin
 * every upgrade link is unavailable (`null`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  amrPlansUrlForProfile,
  amrPlansUrlForWorkspace,
  setRuntimeAmrConsoleOrigin,
} from '../../src/runtime/amr-guidance';

// 站位用的内部环境 console origin。真实内部主机名不进公开 bundle,
// 打包时由 CI secret 注入、再由 daemon 在运行时报给客户端。
const RUNTIME_CONSOLE_ORIGIN = 'https://vela.example.invalid';

afterEach(() => {
  setRuntimeAmrConsoleOrigin(null);
});

describe('升级按钮的落点:console 的套餐页', () => {
  it('is unavailable on every profile when no console origin is configured', () => {
    for (const profile of ['prod', 'test', 'feature-test', 'local', ' unknown ', null]) {
      expect(amrPlansUrlForProfile(profile)).toBeNull();
    }
  });

  it('opens the configured console plan surface, prod included', () => {
    setRuntimeAmrConsoleOrigin(RUNTIME_CONSOLE_ORIGIN);
    for (const profile of ['prod', 'feature-test', ' unknown ', null]) {
      const url = amrPlansUrlForProfile(profile);
      expect(url).toBe(`${RUNTIME_CONSOLE_ORIGIN}/dashboard?source=mish&billing=plan`);
      expect(url).not.toContain('/pricing');
    }
  });

  it('工作区版带上 workspaceId,并且用同一个意图', () => {
    setRuntimeAmrConsoleOrigin(RUNTIME_CONSOLE_ORIGIN);
    const url = amrPlansUrlForWorkspace('feature-test', ' workspace-a ');
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.origin).toBe(RUNTIME_CONSOLE_ORIGIN);
    expect(parsed.pathname).toBe('/dashboard');
    expect(parsed.searchParams.get('workspaceId')).toBe('workspace-a');
    expect(parsed.searchParams.get('billing')).toBe('plan');
  });

  it('没有工作区身份时仍然失败关闭', () => {
    setRuntimeAmrConsoleOrigin(RUNTIME_CONSOLE_ORIGIN);
    expect(amrPlansUrlForWorkspace('feature-test', null)).toBeNull();
    expect(amrPlansUrlForWorkspace('feature-test', '   ')).toBeNull();
  });
});
