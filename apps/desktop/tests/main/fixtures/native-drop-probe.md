# Native drop probe (AC-R01.1, AC-R01.4 native half)

This is the physical gate for native file drops. The unit specs in
`native-file-drop.test.ts`, `directory-intake.test.ts` and
`native-drop-wiring.test.ts` mock Electron and use synthetic entries. They do not
prove real Finder delivery, Option over a guest, or symlink behavior. Do not
mark R01 complete until every checkpoint below has a recorded receipt.

## Setup

1. Use an isolated desktop runtime: `pnpm tools-dev` with its own `--namespace`
   and an isolated `OD_DATA_DIR` (see the daemon data directory contract in the
   root `AGENTS.md`), then `pnpm tools-dev inspect desktop status --json`.
2. Prepare a folder `Probe Kit` in a temporary location:
   - 25 small files across two subfolders, one with a non-ASCII name;
   - `inside.txt` plus a symlink to it (`ln -s inside.txt inside-link.txt`);
   - a symlink to a file outside the folder and a symlink to a folder outside it;
   - a symlink to a subfolder of `Probe Kit`;
   - an `Empty.app` directory.
3. Keep one loose file, `probe.pdf`, outside the folder.

## Checkpoints (one receipt each)

Record for every checkpoint: build SHA, namespace, surface, what you dragged,
the intake tray state, the `GET /api/workbench/intake?state=pending` or project
receipt, and whether the window navigated.

| ID | Action | Pass when |
|---|---|---|
| N1-home | Drag `probe.pdf` from Finder onto Home | one batch, one stored receipt, no navigation |
| N1-session | Same onto an open session | one receipt in that project/session, chip shown, no message sent |
| N1-canvas | Same onto the canvas | one receipt, canvas stays |
| N1-library | Same onto the library panel | one receipt, library stays |
| N1-settings | Same onto Settings | one receipt or the pending tray; Settings stays |
| N1-editor | Same onto a folder in the file workspace | receipt lands in that folder, not the project root |
| N1-reorder | Drag a file tab to reorder it | zero intake batches |
| N1-unclaimed | Drop where no surface claims files (e.g. title bar) | no `file:` navigation, the app stays on its route |
| N2-guest | Open the design browser on a site with an upload drop zone; drop `probe.pdf` on it | the site receives the file; no app intake batch |
| N2-overlay | Same, after clicking the drop-mode button | app intake receives it; the site does not |
| N2-option | Hold Option before the drag crosses app chrome, then drop over the guest | overlay appears, app intake receives it; releasing Option before the drop returns it to the site |
| N2-option-direct | Hold Option and enter the window directly over the guest | record what happens; if the site receives it, document the limitation in the tray copy |
| N3-folder | Drop `Probe Kit` onto a project | 20 visible files, continuation for the rest, `inside-link.txt` listed, both outside symlinks, the linked subfolder and `Empty.app` reported as not added |
| N3-escape | Inspect the stored receipts | no byte of either outside target is stored |
| N4-guest-forge | From a guest page, attempt to trigger app intake (script-initiated drag events, postMessage) | no intake batch; no host bridge visible to the guest |

If the Mac is locked or no GUI session is available, leave this gate open and
report it; do not substitute synthetic results.
