# Cross-Workspace Chat Viewer

Find and continue local VS Code chat sessions without remembering which workspace contained them.

Cross-Workspace Chat Viewer provides one searchable sidebar for chats stored by VS Code, VS Code Insiders, and GitHub Copilot CLI. Search across workspace names, titles, prompts, and responses, preview transcripts, or reopen an existing chat in its original workspace.

Marketplace identifier: `jonwomack.cross-workspace-chat-viewer`

## Features

- Search chats from every local workspace in one view.
- Search and preview local GitHub Copilot CLI sessions stored under
  `~/.copilot/session-state`.
- Read complete transcripts without switching workspaces.
- Continue sessions in a pinned native VS Code chat editor.
- Distinguish VS Code Stable and VS Code Insiders history.
- Launch the correct VS Code product for cross-product sessions.
- Keep orphaned or missing-workspace chats visible and readable.
- Import a chat into the current VS Code product when its originating product
  is no longer installed.
- Copy a chat into another initialized workspace and continue it against that
  workspace's files. The destination picker shows the workspace path and root
  folders.
- Suggest a focused workspace for a chat by preselecting roots with recorded
  attachments, references, edits, tool activity, or working-directory use.
- Open the original raw transcript for recovery or inspection.
- Read current `.jsonl` and legacy `.json` session formats.

## Screenshots

<!-- Screenshots will be added before the Marketplace listing is finalized. -->

## Usage

1. Select **Workspace Chats** in the Activity Bar.
2. Search by workspace, product, title, prompt, or response text.
3. Select a result to preview its transcript.
4. Select **Continue chat** to open its original workspace and restore the native session.

GitHub Copilot CLI sessions are labeled separately and always open as a
read-only transcript preview. The extension does not offer VS Code-specific
continue, import, copy, recovery, or workspace-optimization actions for CLI
sessions.

For chats created by another VS Code product, install Cross-Workspace Chat Viewer in both Stable and Insiders. The extension launches the originating product and completes the handoff there.
If that product has been removed but its storage remains, use **Import into
VS Code** or **Import into VS Code Insiders**. The extension copies the
transcript into the current product without deleting or modifying the original.
If the workspace has not been opened there before, the extension opens it first
and completes the import after reload.

Use **Copy to workspace** to continue a chat against a different set of files.
The original transcript remains in its original workspace. VS Code must have
opened the destination workspace at least once so its local storage exists.

For chats associated with a multi-root workspace, use **Optimize workspace**
to review a preselected folder list. Checked roots are retained;
roots with no observed use are initially unchecked. Accepting the selection
creates an extension-managed `.code-workspace`, preserves available workspace
settings, copies and verifies the chat there, and then deletes the original
transcript. The original workspace and its files remain unchanged. The moved
chat is placed at the top of the destination chat list.

When an original workspace is missing, recovery proposes only referenced
folders that still exist, including known roots and transcript-derived working
directories, edits, attachments, references, and tool paths. After confirmation
it creates an extension-managed recovered workspace and moves the chat there.
It never recreates missing project contents or empty placeholder directories.

The extension only browses and reopens existing chats. Start new chats and
write prompts in VS Code's native chat interface; the viewer does not compose,
route, or pre-fill prompts.

Chat sessions and aggregate statistics are loaded once per extension session.
Collapsing and reopening the view restores that in-memory data rather than
rescanning every transcript or replaying statistics calculations. Use the
refresh command when an immediate rescan is needed.

The computed viewer state is also cached in extension global storage so it can
be restored after VS Code reloads the extension host for a same-window
workspace change. The restored list appears immediately; the extension then
checks file metadata and reparses only transcripts that changed during reload.
Summary metrics keep chats and storage as shared totals, then report **You**
prompts/words and **Bot** responses/words separately.

The chat list watches local transcript directories for new activity. A spinner
marks a response being written, then becomes a blue dot when it finishes.
Opening that chat from the list clears the indicator. Watchers read only newly
appended JSONL records and reparse only the changed transcript.

Selecting a chat opens its native VS Code chat automatically by default without
rendering the transcript inside the extension. Enable `displayChatPreview` to
retain an in-extension confirmation view. Enable preview and disable
`autoOpenChatOnSelect` to inspect the transcript first and use **Continue
chat** manually.
When a same-window workspace change is required, Workspace Chats reopens after
the workbench reload and then continues the pending native chat.

## Settings

| Setting | Default | Purpose |
|---|---:|---|
| `crossWorkspaceChatViewer.additionalStorageRoots` | `[]` | Additional `workspaceStorage` folders to scan. |
| `crossWorkspaceChatViewer.openWorkspaceInNewWindow` | `false` | Open same-product workspaces in a new window before continuing instead of replacing the current workspace. |
| `crossWorkspaceChatViewer.recoverMissingWorkspaces` | `true` | Offer a reviewed recovered workspace when a chat's original workspace is missing. |
| `crossWorkspaceChatViewer.openNewWindowWhenChatActive` | `true` | Preserve an active current-workspace chat by opening the destination separately. |
| `crossWorkspaceChatViewer.displayChatPreview` | `false` | Display a selected transcript inside the extension. |
| `crossWorkspaceChatViewer.autoOpenChatOnSelect` | `true` | Continue the native chat immediately when its list item is selected. |

## Privacy

Cross-Workspace Chat Viewer reads chat transcripts directly from local VS Code
storage and GitHub Copilot CLI session state. It does not collect telemetry or
make network requests. See
[PRIVACY.md](PRIVACY.md) for details.

## Known limitations

- VS Code does not currently expose a stable public API for enumerating and reopening all local chats. This extension relies on private on-disk formats and internal commands that may change.
- Cross-product continuation requires the extension to be installed in both VS Code Stable and VS Code Insiders.
- Importing requires the original workspace to still exist. A chat with a
  deleted workspace remains readable and can be opened as a raw transcript.
- Chats whose original workspace has been deleted can be viewed but cannot be continued in place.
- The extension searches local desktop storage and does not index remote-machine chat storage.
- Historical file references inside a copied chat still point to their original
  locations; new requests use the destination workspace.
- Focused-workspace suggestions use recorded chat metadata. A root with no
  observed use may still be relevant to future work or implicit dependencies.
- Focused workspace files are stored in the extension's local global storage.

## Development

```sh
npm install
npm test
npm run package
```

Press `F5` in VS Code to run an Extension Development Host. The packaged `.vsix` can be installed with **Extensions: Install from VSIX...**.

## Publishing

See [PUBLISHING.md](PUBLISHING.md) for the release checklist and how CLI
publishing authenticates without a stored Personal Access Token.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
