// Default scenario plugin bindings (plan §3.3 of plugin-driven-flow-plan).
//
// Both the web client (`EntryShell.handleCreate`) and the daemon
// (`/api/projects` + `/api/runs`) need to know which bundled scenario
// plugin to bind when the caller didn't pick one explicitly. Keeping
// the mapping in contracts lets both sides import the same table so the
// client and the server never disagree about what counts as the
// "default" plugin for a given project kind / task kind.
//
// Kind → scenario plugin mapping. Web prototypes keep their specialised
// seed; surfaces whose bundled examples have been retired fall back to the
// generic od-new-generation router while retaining their product kind.
//
// Generic / catch-all kinds (template, other) keep od-new-generation,
// which runs discovery → plan → generate → critique without a
// surface-specific seed. Media kinds keep od-media-generation, which
// dispatches through the media contract instead of emitting HTML.

import type {
  ProjectKind,
  ProjectMetadata,
  ProjectScenarioTaskProfile,
} from '../api/projects.js';
import type { AppliedPluginSnapshot } from './apply.js';

export type TaskKind = AppliedPluginSnapshot['taskKind'];

// Plugin ids the kind/task-kind defaults can resolve to. Two tiers:
//   1. `od-*` scenarios (under `plugins/_official/scenarios/`) — generic
//      routers / pipelines without per-surface templates.
//   2. `example-*` scenarios (under `plugins/_official/examples/`) —
//      specialised bundled skills that ship a seed template + layout
//      vocabulary + checklist. Promoted to first-class defaults here so
//      the chip rail / project create paths bind them without the user
//      having to manually pick the skill.
// Kept as a string-literal union so a typo surfaces as a type error in
// both the web shell and the daemon resolver.
export type DefaultScenarioPluginId =
  | 'od-default'
  | 'od-new-generation'
  | 'od-media-generation'
  | 'od-plugin-authoring'
  | 'od-figma-migration'
  | 'od-code-migration'
  | 'od-tune-collab'
  | 'example-web-clone'
  | 'example-web-prototype';

export const DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID =
  'od-default' satisfies DefaultScenarioPluginId;

const AUTOMATIC_STRATEGY_TASK_PROFILE_BY_ROUTE_ID = {
  prototype: 'prototype',
  marketing: 'marketing',
} as const satisfies Record<string, ProjectScenarioTaskProfile>;

/**
 * Resolve the product-owned OD Next route selected by a task-type surface.
 *
 * Keyed by the exact first-level task type, not by broad project kind and not
 * by second-level scene. A second-level scene refines WHAT to build, never
 * WHETHER the parent task type's route applies, so surfaces fold a nested
 * scene onto its parent before asking: `wireframe` and `mobile` are catalog
 * action ids, never route ids, and stay unrouted here on purpose.
 */
export function automaticStrategyTaskProfileForRouteId(
  routeId: string | null | undefined,
): ProjectScenarioTaskProfile | null {
  if (!routeId) return null;
  return AUTOMATIC_STRATEGY_TASK_PROFILE_BY_ROUTE_ID[
    routeId as keyof typeof AUTOMATIC_STRATEGY_TASK_PROFILE_BY_ROUTE_ID
  ] ?? null;
}

/**
 * Re-derive the OD Next route from exact project metadata alone.
 *
 * This is the fail-closed half of the routing contract: the web hand-off and
 * the daemon both run it against the metadata a create actually carries, so a
 * claimed route survives only when the metadata independently describes the
 * same OD Next task.
 *
 * `intent` is the only field that can move a project OFF a route, because it
 * is the only one that names a different pipeline (`web-clone`,
 * `live-artifact`, `webgl-experience`, `document`, …); the one intent that owns
 * its own route is admitted explicitly and every other intent is unrouted. The
 * retired `hyperframes` intent is therefore unrouted rather than silently
 * re-homed onto a semantically different generator.
 *
 * A second-level scene deliberately does NOT narrow the route. `fidelity` and
 * `platformTargets` describe WHAT a Prototype should be — the Prototype task
 * profile already branches on wireframe/lo-fi fidelity and on mobile platform
 * targets — so the Wireframe and Mobile scenes ride the Prototype route with
 * their refinements intact. They stay in the parameter type to record that the
 * route decision has seen them and chosen not to gate on them.
 */
export function automaticStrategyTaskProfileForProjectMetadata(
  metadata: Pick<ProjectMetadata, 'kind' | 'intent' | 'fidelity' | 'platform' | 'platformTargets'>
    | null
    | undefined,
): ProjectScenarioTaskProfile | null {
  if (metadata?.intent === 'marketing') {
    return metadata.kind === 'prototype' ? 'marketing' : null;
  }
  if (metadata?.intent != null) return null;
  if (metadata?.kind !== 'prototype') return null;
  return 'prototype';
}

export const DEFAULT_SCENARIO_PLUGIN_BY_KIND: Record<ProjectKind, DefaultScenarioPluginId> = {
  // Prototypes bind to web-prototype's seed template (single-file HTML,
  // 1280×800 frame, section layouts library, P0 checklist).
  prototype: 'example-web-prototype',
  // Deck templates are no longer bundled; keep deck creation available
  // through the generic generation scenario.
  deck:      'od-new-generation',
  template:  'od-new-generation',
  brand:     'od-new-generation',
  image:     'od-media-generation',
  video:     'od-media-generation',
  audio:     'od-media-generation',
  other:     'od-new-generation',
};

export const DEFAULT_SCENARIO_PLUGIN_BY_TASK_KIND: Record<TaskKind, DefaultScenarioPluginId> = {
  'new-generation':  'od-new-generation',
  'figma-migration': 'od-figma-migration',
  'code-migration':  'od-code-migration',
  'tune-collab':     'od-tune-collab',
};

export function defaultScenarioPluginIdForKind(
  kind: ProjectKind | undefined,
): DefaultScenarioPluginId | null {
  if (!kind) return null;
  return DEFAULT_SCENARIO_PLUGIN_BY_KIND[kind] ?? null;
}

export function defaultScenarioPluginIdForProjectMetadata(
  metadata: Pick<ProjectMetadata, 'kind' | 'intent'> | null | undefined,
): DefaultScenarioPluginId | null {
  if (metadata?.intent === 'live-artifact') return 'od-new-generation';
  if (metadata?.intent === 'web-clone') return 'example-web-clone';
  // Legacy WebGL projects fall back to the maintained prototype scenario now
  // that the standalone WebGL example catalog has been retired.
  if (metadata?.intent === 'webgl-experience') return 'example-web-prototype';
  // Historical HyperFrames projects keep their readable data but bind no
  // default scenario: the generator is retired, so falling through to the
  // kind-based media default would silently substitute a different pipeline.
  if (metadata?.intent === 'hyperframes') return null;
  if (metadata?.intent === 'marketing') return 'example-web-prototype';
  return defaultScenarioPluginIdForKind(metadata?.kind);
}

/**
 * Return the only OD Next profile an exact daemon-owned automatic binding may
 * carry. Broad kinds such as `image` and `video` deliberately resolve to no
 * profile unless the product metadata names an approved route.
 */
export function defaultScenarioTaskProfileForProjectMetadata(
  metadata: Pick<ProjectMetadata, 'kind' | 'intent' | 'fidelity' | 'platform' | 'platformTargets'>
    | null
    | undefined,
  pluginId: string,
): ProjectScenarioTaskProfile | null {
  const taskProfile = automaticStrategyTaskProfileForProjectMetadata(metadata);
  if (taskProfile === 'prototype' || taskProfile === 'marketing') {
    return pluginId === 'example-web-prototype' ? taskProfile : null;
  }
  if (taskProfile === 'ppt') return null;
  return null;
}

export function defaultScenarioPluginIdForTaskKind(
  taskKind: TaskKind | undefined,
): DefaultScenarioPluginId | null {
  if (!taskKind) return null;
  return DEFAULT_SCENARIO_PLUGIN_BY_TASK_KIND[taskKind] ?? null;
}
