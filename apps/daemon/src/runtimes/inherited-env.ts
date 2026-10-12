/**
 * Canonical ambient names for trusted Local CLI children. This is a name
 * boundary, not a filesystem/network sandbox. Explicit profile and Settings
 * env maps are separate, deliberate inputs; identity scrubbing still wins.
 */
export const AGENT_INHERITED_ENV_NAMES: readonly string[] = [
  // OS / tool-shell baseline: defs/codex.ts's shell environment contract.
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM',
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA',
  'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'WSL_DISTRO_NAME',
  'ELECTRON_RUN_AS_NODE',
  // Sandbox/runtime homes and the existing critic's CA/proxy contract.
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR', 'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_PREFIX',
  'ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY',
  'NODE_EXTRA_CA_CERTS',
  // Existing local auth contracts deliberately retain these across adapters.
  // Other custom-provider env_key names require explicit profile/Settings env.
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'CODEX_API_KEY',
  'AZURE_OPENAI_API_KEY', 'CURSOR_API_KEY', 'DEEPSEEK_API_KEY',
  'DASHSCOPE_API_KEY', 'XAI_API_KEY', 'QODER_PERSONAL_ACCESS_TOKEN',
  'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  // Adapter homes, executable overrides and declared runtime switches.
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'DSH_HOME', 'REASONIX_HOME',
  'OPENCODE_TEST_HOME', 'AMR_HOME',
  'VELA_BIN', 'AIDER_BIN', 'CLAUDE_BIN', 'CODEBUDDY_BIN', 'CODEX_BIN',
  'COPILOT_BIN', 'CURSOR_AGENT_BIN', 'DEEPSEEK_BIN', 'DSH_BIN', 'DEVIN_BIN',
  'HERMES_BIN', 'KIMI_BIN', 'KIRO_BIN', 'KILO_BIN', 'MIMO_BIN', 'OPENCODE_BIN',
  'PI_BIN', 'QODER_BIN', 'QWEN_BIN', 'REASONIX_BIN', 'TRAE_CLI_BIN', 'VIBE_BIN',
  'CLAUDE_CODE_ENABLE_TODO_TOOLS', 'OPENCODE_ENABLE_EXA',
  'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT',
  'MIMOCODE_CONFIG_CONTENT', 'MIMOCODE_DISABLE_PROJECT_CONFIG',
  'REASONIX_ACP_SYSTEM_APPEND', 'OPEN_DESIGN_AMR_PROFILE', 'VELA_PROFILE',
  'VELA_ENABLE_PARALLEL_MCP', 'VELA_OPENCODE_BIN', 'VELA_RUNTIME_KEY', 'VELA_LINK_URL', 'VELA_API_URL',
  'AMR_CLIENT_SOURCE', 'MMD_MODEL_ROUTES_FILE', 'QWEN_SETTINGS_FILE',
  // Daemon-issued tool/runtime coordinates (server.ts / sandbox-mode.ts).
  'OD_BIN', 'OD_NODE_BIN', 'OD_HYPERFRAMES_BIN', 'OD_DATA_DIR', 'OD_DAEMON_URL',
  'OD_PROJECT_ID', 'OD_PROJECT_DIR',
  'OD_WORKSPACE_ID', 'OD_WORKSPACE_MEMBER_ID', 'OD_TASK_INPUT_DIR',
  'OD_AGENT_HOME', 'OD_AGENT_PROFILES_CONFIG', 'OD_RESOURCE_ROOT', 'OD_SANDBOX_MODE',
  'OD_CODEX_SANDBOX', 'OD_CODEX_TRANSPORT', 'OD_CODEX_DISABLE_PLUGINS',
  'OD_BROWSER_USE_REQUESTED', 'OD_BROWSER_USE_AVAILABLE',
  'OD_BROWSER_USE_UNAVAILABLE_REASON', 'OD_BROWSER_USE_REGISTRY_PATH',
];

const inheritedNames = new Set(AGENT_INHERITED_ENV_NAMES);

/** Preserve original casing (notably Windows Path and POSIX proxy aliases). */
export function agentInheritedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && /^[A-Za-z0-9_]+$/.test(name) && inheritedNames.has(name.toUpperCase())) {
      next[name] = value;
    }
  }
  return next;
}
