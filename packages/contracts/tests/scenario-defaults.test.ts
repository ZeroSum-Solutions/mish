// Plan §3.3 of plugin-driven-flow-plan — kind → bundled scenario plugin
// mapping. Web (`EntryShell`) and daemon (`/api/projects`, `/api/runs`)
// share this resolver; the test pins the table so a drift between the
// two surfaces is impossible.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCENARIO_PLUGIN_BY_KIND,
  DEFAULT_SCENARIO_PLUGIN_BY_TASK_KIND,
  DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID,
  automaticStrategyTaskProfileForProjectMetadata,
  automaticStrategyTaskProfileForRouteId,
  defaultScenarioPluginIdForKind,
  defaultScenarioPluginIdForProjectMetadata,
  defaultScenarioPluginIdForTaskKind,
  defaultScenarioTaskProfileForProjectMetadata,
} from '../src/plugins/scenario-defaults.js';

describe('automaticStrategyTaskProfileForRouteId', () => {
  it('recognizes only the product-owned OD Next routes', () => {
    expect(automaticStrategyTaskProfileForRouteId('prototype')).toBe('prototype');
    expect(automaticStrategyTaskProfileForRouteId('marketing')).toBe('marketing');
    // HyperFrames is retired: the route id no longer resolves to any profile.
    expect(automaticStrategyTaskProfileForRouteId('hyperframes')).toBeNull();

    // Task types that own no OD Next route stay unrouted. `wireframe` and
    // `mobile` are catalog action ids, never route ids — the surfaces fold
    // them onto their parent Prototype route before asking.
    expect(automaticStrategyTaskProfileForRouteId('wireframe')).toBeNull();
    expect(automaticStrategyTaskProfileForRouteId('mobile')).toBeNull();
    expect(automaticStrategyTaskProfileForRouteId('deck')).toBeNull();
    expect(automaticStrategyTaskProfileForRouteId('image')).toBeNull();
    expect(automaticStrategyTaskProfileForRouteId('web-clone')).toBeNull();
    expect(automaticStrategyTaskProfileForRouteId('document')).toBeNull();
    expect(automaticStrategyTaskProfileForRouteId('webgl')).toBeNull();
    expect(automaticStrategyTaskProfileForRouteId('live-artifact')).toBeNull();
    expect(automaticStrategyTaskProfileForRouteId('figma')).toBeNull();
    expect(automaticStrategyTaskProfileForRouteId('template')).toBeNull();
    expect(automaticStrategyTaskProfileForRouteId(undefined)).toBeNull();
  });

  it('admits the Prototype route for the Wireframe and Mobile refinements', () => {
    expect(automaticStrategyTaskProfileForProjectMetadata({ kind: 'prototype' })).toBe('prototype');
    expect(automaticStrategyTaskProfileForProjectMetadata({ kind: 'deck' })).toBeNull();
    expect(automaticStrategyTaskProfileForProjectMetadata({
      kind: 'prototype',
      intent: 'marketing',
    })).toBe('marketing');
    // A retired HyperFrames intent resolves to no profile — never to the
    // Prototype or the broad-video route it superficially resembles.
    expect(automaticStrategyTaskProfileForProjectMetadata({
      kind: 'video',
      intent: 'hyperframes',
    })).toBeNull();

    // A second-level scene refines WHAT to build, never WHETHER the parent's
    // automatic route applies: the Prototype task profile already branches on
    // fidelity and on platform targets.
    expect(automaticStrategyTaskProfileForProjectMetadata({
      kind: 'prototype',
      fidelity: 'wireframe',
    })).toBe('prototype');
    expect(automaticStrategyTaskProfileForProjectMetadata({
      kind: 'prototype',
      platform: 'auto',
      platformTargets: ['mobile-ios', 'mobile-android'],
    })).toBe('prototype');

    expect(defaultScenarioTaskProfileForProjectMetadata({
      kind: 'prototype',
      fidelity: 'wireframe',
    }, 'example-web-prototype')).toBe('prototype');
    expect(defaultScenarioTaskProfileForProjectMetadata({
      kind: 'prototype',
      platformTargets: ['mobile-ios'],
    }, 'example-web-prototype')).toBe('prototype');
    // The profile stays pinned to the plugin that owns it.
    expect(defaultScenarioTaskProfileForProjectMetadata({
      kind: 'prototype',
      fidelity: 'wireframe',
    }, 'example-simple-deck')).toBeNull();
  });

  it('keeps non-OD-Next project metadata unrouted', () => {
    for (const metadata of [
      { kind: 'prototype' as const, intent: 'web-clone' as const },
      { kind: 'prototype' as const, intent: 'live-artifact' as const },
      { kind: 'prototype' as const, intent: 'webgl-experience' as const },
      { kind: 'other' as const, intent: 'document' as const },
      { kind: 'other' as const },
      { kind: 'image' as const },
      { kind: 'video' as const },
      { kind: 'audio' as const },
      { kind: 'template' as const },
      { kind: 'brand' as const },
    ]) {
      expect(automaticStrategyTaskProfileForProjectMetadata(metadata)).toBeNull();
    }
    expect(automaticStrategyTaskProfileForProjectMetadata(null)).toBeNull();
    expect(automaticStrategyTaskProfileForProjectMetadata(undefined)).toBeNull();
  });

});

describe('defaultScenarioPluginIdForKind', () => {
  it('maps every supported ProjectKind to a bundled scenario id', () => {
    const expected: Record<string, string> = {
      // Web prototypes retain their specialised seed. Surfaces whose
      // bundled examples were retired use the generic router.
      prototype: 'example-web-prototype',
      deck:      'od-new-generation',
      template:  'od-new-generation',
      brand:     'od-new-generation',
      image:     'od-media-generation',
      video:     'od-media-generation',
      audio:     'od-media-generation',
      other:     'od-new-generation',
    };
    for (const [kind, pluginId] of Object.entries(expected)) {
      expect(defaultScenarioPluginIdForKind(kind as never)).toBe(pluginId);
      expect(DEFAULT_SCENARIO_PLUGIN_BY_KIND[kind as never]).toBe(pluginId);
    }
  });

  it('returns null for an undefined kind so the daemon can skip the fallback', () => {
    expect(defaultScenarioPluginIdForKind(undefined)).toBeNull();
  });

  it('keeps live-artifact creation available through the generic scenario', () => {
    expect(defaultScenarioPluginIdForProjectMetadata({
      kind: 'prototype',
      intent: 'live-artifact',
    })).toBe('od-new-generation');
    expect(defaultScenarioPluginIdForProjectMetadata({
      kind: 'prototype',
      intent: 'webgl-experience',
    })).toBe('example-web-prototype');
    expect(defaultScenarioPluginIdForProjectMetadata({ kind: 'prototype' }))
      .toBe('example-web-prototype');
    expect(defaultScenarioPluginIdForProjectMetadata(undefined)).toBeNull();
  });

  it('keeps Marketing explicit, retires HyperFrames, and keeps ordinary media generic', () => {
    expect(defaultScenarioPluginIdForProjectMetadata({
      kind: 'prototype',
      intent: 'marketing',
    })).toBe('example-web-prototype');
    // Historical HyperFrames metadata must degrade to no default plugin
    // instead of silently falling through to kind-based media routing.
    expect(defaultScenarioPluginIdForProjectMetadata({
      kind: 'video',
      intent: 'hyperframes',
    })).toBeNull();
    expect(defaultScenarioPluginIdForProjectMetadata({
      kind: 'video',
      intent: 'hyperframes',
    })).not.toBe('od-media-generation');
    expect(defaultScenarioPluginIdForProjectMetadata({ kind: 'image' }))
      .toBe('od-media-generation');
    expect(defaultScenarioPluginIdForProjectMetadata({ kind: 'video' }))
      .toBe('od-media-generation');
  });

  it('limits automatic OD Next profiles to the approved routes', () => {
    expect(defaultScenarioTaskProfileForProjectMetadata(
      { kind: 'prototype' },
      'example-web-prototype',
    )).toBe('prototype');
    expect(defaultScenarioTaskProfileForProjectMetadata(
      { kind: 'deck' },
      'od-new-generation',
    )).toBeNull();
    expect(defaultScenarioTaskProfileForProjectMetadata(
      { kind: 'prototype', intent: 'marketing' },
      'example-web-prototype',
    )).toBe('marketing');
    // Retired HyperFrames projects keep no OD Next profile even when a
    // persisted snapshot still names the removed scenario.
    expect(defaultScenarioTaskProfileForProjectMetadata(
      { kind: 'video', intent: 'hyperframes' },
      'example-hyperframes',
    )).toBeNull();
    expect(defaultScenarioTaskProfileForProjectMetadata(
      { kind: 'image' },
      'od-media-generation',
    )).toBeNull();
    expect(defaultScenarioTaskProfileForProjectMetadata(
      { kind: 'video' },
      'od-media-generation',
    )).toBeNull();
    expect(defaultScenarioTaskProfileForProjectMetadata(
      { kind: 'audio' },
      'od-media-generation',
    )).toBeNull();
    expect(defaultScenarioTaskProfileForProjectMetadata(
      { kind: 'other' },
      'od-new-generation',
    )).toBeNull();
  });




  it('exposes the hidden free-form Home fallback plugin separately from kind defaults', () => {
    expect(DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID).toBe('od-default');
    expect(DEFAULT_SCENARIO_PLUGIN_BY_KIND.other).toBe('od-new-generation');
  });
});

describe('defaultScenarioPluginIdForTaskKind', () => {
  it('maps every taskKind to the matching scenario plugin', () => {
    expect(defaultScenarioPluginIdForTaskKind('new-generation')).toBe('od-new-generation');
    expect(defaultScenarioPluginIdForTaskKind('figma-migration')).toBe('od-figma-migration');
    expect(defaultScenarioPluginIdForTaskKind('code-migration')).toBe('od-code-migration');
    expect(defaultScenarioPluginIdForTaskKind('tune-collab')).toBe('od-tune-collab');
    expect(DEFAULT_SCENARIO_PLUGIN_BY_TASK_KIND['new-generation']).toBe('od-new-generation');
  });

  it('returns null when the taskKind is missing', () => {
    expect(defaultScenarioPluginIdForTaskKind(undefined)).toBeNull();
  });
});
