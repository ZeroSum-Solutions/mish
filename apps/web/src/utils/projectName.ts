import type { Project } from '../types';

const MAX_CJK_TITLE_LENGTH = 18;
const MAX_LATIN_WORDS = 6;

const CJK_PATTERN = /[\u3400-\u9fff]/;

const LEADING_CJK_FILLER = [
  /^先?(帮我|帮忙|麻烦|请|可以|能不能|能否|给我|我想要|我要)/,
  /^(先)?(实现|做|做一下|创建|生成|设计|开发|新增|添加|优化|修复|改|更改|调整)(一下|一个|一版|下)?/,
  /^(一个|一份|这个|那个)/,
];

const LEADING_LATIN_FILLER =
  /^(please\s+)?(can\s+you\s+|could\s+you\s+|help\s+me\s+|i\s+want\s+to\s+|i\s+need\s+to\s+)?(create|build|make|design|implement|add|fix|update|improve|optimize|generate|write|turn)\s+((this|that)\s+into\s+)?(an|a|the|this|that)?\s*/i;

const LATIN_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'for',
  'in',
  'of',
  'on',
  'please',
  'the',
  'to',
  'with',
]);

function cleanPrompt(prompt: string): string {
  return prompt
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#][\w.-]+/g, ' ')
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimCjkTitle(input: string): string {
  let title = input.trim();
  for (const pattern of LEADING_CJK_FILLER) {
    title = title.replace(pattern, '').trim();
  }
  if (/项目名称/.test(title) && /自动/.test(title) && /(更改|修改|命名)/.test(title)) {
    return '自动项目命名';
  }
  title = title
    .replace(/^根据项目中的?第一个\s*prompt\s*/i, '')
    .replace(/项目名称.*自动.*(更改|修改|命名)/, '自动项目命名')
    .replace(/自动.*(更改|修改).*项目名称/, '自动项目命名')
    .replace(/总结项目名称/, '项目命名')
    .replace(/[，。！？；：,.!?;:].*$/, '')
    .replace(/\s+/g, '');
  if (!title) return '';
  return title.slice(0, MAX_CJK_TITLE_LENGTH);
}

function toTitleCase(word: string): string {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function trimLatinTitle(input: string): string {
  const words = input
    .replace(LEADING_LATIN_FILLER, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !LATIN_STOP_WORDS.has(word.toLowerCase()))
    .slice(0, MAX_LATIN_WORDS);
  return words.map(toTitleCase).join(' ');
}

export function summarizeProjectNameFromPrompt(prompt: string): string {
  const requested = requestedProjectName(prompt);
  if (requested) return requested;
  const cleaned = cleanPrompt(prompt);
  if (!cleaned) return '';
  const firstClause = cleaned.split(/[\n\r。！？!?]/)[0]?.trim() ?? cleaned;
  if (CJK_PATTERN.test(firstClause)) return trimCjkTitle(firstClause);
  return trimLatinTitle(firstClause);
}

/** A stated project name takes precedence over a summary or reference URL. */
function requestedProjectName(prompt: string): string {
  const requestedMatch = prompt.match(
    /\b(name|call)\s+(?:(the|this)\s+)?project\b(?:[ \t]*(:)[ \t]*|[ \t]+(?:(as)\b[ \t]+)?)(?:"([^"\n]+)"|“([^”\n]+)”|'([^'\n]+)'|([^.!?;,:\n]+))/i,
  );
  if (!requestedMatch) return '';
  const quoted = requestedMatch[5] ?? requestedMatch[6] ?? requestedMatch[7];
  const unquoted = requestedMatch[8]?.trim();
  // "Call the project …" can be a contact instruction. An unquoted call
  // needs a naming marker (this project, as, or a colon) to disambiguate it.
  if (!quoted && requestedMatch[1]?.toLowerCase() === 'call'
    && requestedMatch[2]?.toLowerCase() !== 'this'
    && !requestedMatch[3] && !requestedMatch[4]) return '';
  // A demonstrative alone still permits an ordinary contact phrase such as
  // "call this project manager". Ambiguous role titles must be quoted.
  if (!quoted && unquoted && requestedMatch[1]?.toLowerCase() === 'call'
    && !requestedMatch[3] && !requestedMatch[4]
    && /^(?:manager|management|owner|lead|leader|team|stakeholder|coordinator|developer|director|designer|administrator)\b/i.test(unquoted)) return '';
  const requested = quoted ?? unquoted?.split(
    /\s+\b(?:and|or|but|then|before|after|to|build|create|design|make|generate|implement|add|use|with|using|launch|develop|start|write|include)\b/i,
  )[0];
  const clean = (value: string) => value
    .replace(/[\p{C}]/gu, ' ')
    .replace(/[^\p{L}\p{N}\s.'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  if (requested) {
    const title = clean(requested);
    if (title) return title;
  }
  return "";
}

/** Name clone projects from the requested title, then the reference site. */
export function deriveWebsiteCloneProjectName(prompt: string): string {
  const requested = requestedProjectName(prompt);
  if (requested) return requested;
  const clean = (value: string) => value.replace(/[^\p{L}\p{N}\s.-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim();

  const urlText = prompt.match(/https?:\/\/[^\s"'<>]+/i)?.[0];
  if (urlText) {
    try {
      const url = new URL(urlText.replace(/[.,;!?]+$/, ''));
      const host = url.hostname.replace(/^www\./i, '').split('.')[0] ?? '';
      const path = url.pathname.split('/').filter(Boolean).slice(0, 2).join(' ');
      const site = clean(`${host} ${path}`.replace(/[-_]+/g, ' '));
      const title = trimLatinTitle(site);
      if (title) return `${title} Clone`;
    } catch {
      // A malformed reference URL may still have a useful written brief.
    }
  }

  const description = prompt
    .replace(/^\s*Website URL to clone:\s*/i, '')
    .replace(/https?:\/\/\S+/g, ' ')
    .trim();
  const title = summarizeProjectNameFromPrompt(description);
  return title ? `${title} Clone` : 'Website Clone';
}

export function canAutoRenameProjectFromPrompt(
  project: Pick<Project, 'metadata' | 'name'>,
  prompt?: string,
  options: { allowRequestedName?: boolean } = {},
): boolean {
  if (prompt && requestedProjectName(prompt) && !options.allowRequestedName) return false;
  if (project.metadata?.nameSource === 'generated') return true;
  if (project.metadata?.nameSource !== 'prompt' || !prompt) return false;

  const promptHead = prompt.trim().split(/\s+/).slice(0, 8).join(' ');
  const summarized = summarizeProjectNameFromPrompt(prompt);
  const currentName = project.name.trim();
  return Boolean(promptHead) && (currentName === promptHead || currentName === summarized);
}
