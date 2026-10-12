# Select several projects

On Home, choose **Select** beside Recent projects. Each visible card gets a checkbox. Space toggles the focused card. **Select all (visible)** follows the current filters and display limit; **Clear** removes the selection. Outside dialogs and menus, Escape exits selection mode. In the delete dialog, Escape closes only the dialog. **Cancel** exits selection mode.

The sticky bar shows the selected count. Choose **Archive** to hide active projects or enable the Archived filter and choose **Unarchive** to restore archived projects. **Delete** opens one confirmation with the count, up to five names, and the number of remaining names.

Requests run one at a time. The bar reports progress, then the success and failure counts. Each failure names its project and gives the server or network reason. A failure does not stop later requests. Bulk deletion uses `?ifIdle=1` and refuses deletion while a project has queued or running runs and prevents new runs from starting during deletion.

## CLI

```sh
od project delete <id...> --json
od project archive <id...> --json
od project unarchive <id...> --json
```

`od project archive <id...> --unarchive` remains an alias for unarchive. Without `--json`, each project gets a text result. Workspace-bound projects use the existing `--workspace` and `--workspace-member` flags.

Multiple-id invocations emit this JSON shape:

```json
{
  "action": "delete",
  "results": [
    { "id": "idle", "ok": true },
    { "id": "busy", "ok": false, "error": "Project has queued or running runs." }
  ]
}
```

Single-id success preserves the daemon response (`{project}` for archive/unarchive, `{ok: true}` for delete). Single-id HTTP failures use the CLI structured error and typed exit codes. Single deletes cancel active runs before deletion; multiple-id deletes use `?ifIdle=1`.

Exit status is 0 when every request succeeds and 2 when no id is supplied. Failures use the first failure's typed CLI exit code, or 1 for an untyped failure. Repeated ids are requested once. Clients reuse `DELETE /api/projects/:id` and `PATCH /api/projects/:id` with `metadata.archived`; there is no new bulk HTTP endpoint.
