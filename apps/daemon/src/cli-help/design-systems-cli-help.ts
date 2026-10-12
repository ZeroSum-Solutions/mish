// Help surface for `od design-systems`. Kept pure and separate from cli.ts so a
// test can assert the advertised subcommands without spawning the CLI or
// stubbing process.exit / console.log.

export const DESIGN_SYSTEMS_USAGE = `Usage:
  od design-systems list [--query <text>]      List or search design systems.
  (\`od design-system …\` is an alias.)
  od design-systems show <id>                  Print one entry.
  od design-systems rename <id> --title <new>  Rename an editable design system.
  od design-systems download <id> [--out <p>]  Download a brand .zip (files + SKILLS.md).
  od design-systems workspace <id>             Open/sync the kit's workspace project; lists sync conflicts.
  od design-systems install <path|github-url>  Install a finished kit (lands as a draft).
  od design-system approve <id> [--revision <sha256>]  Approve a revision for generation; prints the bound revision.
  od design-system seed-atlas                 Approve the seven installed, pinned Atlas Digest revisions.
  od design-system unapprove <id>             Mark a kit Unreviewed.
  od design-systems publish <id>               Publish a draft kit (approval is also required).
  od design-systems unpublish <id>             Return a kit to draft.
  od design-systems import-local <path>        Import a local project.
  od design-systems import-github <url>        Import a public GitHub repo.
  od design-systems import-shadcn <reference>  Import a shadcn registry item.
  od design-systems rebuild-token-contract <id>  Start a token contract rebuild review.

Approval options:
  --revision <sha256>     Approve a previously inspected revision; conflict if it changed.

Search options:
  --query <text>          Match all words across name, spine, theme, fonts, and colors.
  --json                  Print the catalog response as JSON.

Workspace options:
  --workspace <id>         Exact Workspace for a bound design system.
  --workspace-member <id>  Exact caller membership for a bound design system.
                           Pass both together, or omit both for legacy local data.`;

// `help`, `--help`, and `-h` all route to the usage text above. Without the
// flag forms, `od design-systems --help` falls through to the generic library
// list, which only advertises `list` and `show` and never mentions `rename`.
export function isDesignSystemsHelpArg(arg: string | undefined): boolean {
  return arg === 'help' || arg === '--help' || arg === '-h';
}

type InstallReportBody = {
  designSystem?: { id?: unknown; title?: unknown; status?: unknown } | null;
  selectability?:
    | { selectable: true }
    | { selectable: false; reason?: unknown; message?: unknown; publishCommand?: unknown; approveCommand?: unknown }
    | null;
};

/**
 * Human-readable result of an install or import. A kit lands as a draft and
 * generation skips drafts, so the report always states the status and, for a
 * draft, the one-line command that publishes it.
 */
export function designSystemInstallReportLines(verb: string, body: InstallReportBody): string[] {
  const system = body.designSystem ?? {};
  const id = typeof system.id === 'string' && system.id ? system.id : '(unknown id)';
  const title = typeof system.title === 'string' && system.title ? system.title : '';
  const lines = [`${verb} ${id}${title ? ` -> ${title}` : ''}`];
  const selectability = body.selectability;
  if (selectability?.selectable === false && selectability.reason === 'unreviewed') {
    lines.push('Status: Unreviewed. Approve the inspected revision before generation.');
    lines.push(`Approve it: ${typeof selectability.approveCommand === 'string' ? selectability.approveCommand : `od design-system approve ${id}`}`);
    return lines;
  }
  const isDraft = selectability ? selectability.selectable === false : system.status === 'draft';
  if (!isDraft) {
    lines.push('Status: published. Ready for generation.');
    return lines;
  }
  const command = selectability && selectability.selectable === false
    && typeof selectability.publishCommand === 'string' && selectability.publishCommand
    ? selectability.publishCommand
    : `od design-systems publish ${id}`;
  lines.push('Status: draft. Generation skips draft kits until they are published.');
  lines.push(`Publish it: ${command}`);
  return lines;
}
