# Cross-Workspace Chat Viewer

Find and continue local VS Code chat sessions without remembering which workspace contained them.

Cross-Workspace Chat Viewer provides one searchable sidebar for chats stored by both VS Code and VS Code Insiders. Search across workspace names, titles, prompts, and responses, then reopen the original workspace and continue the native chat session.

Marketplace identifier: `jonwomack.cross-workspace-chat-viewer`

## Features

- Search chats from every local workspace in one view.
- Read complete transcripts without switching workspaces.
- Continue sessions in a pinned native VS Code chat editor.
- Distinguish VS Code Stable and VS Code Insiders history.
- Launch the correct VS Code product for cross-product sessions.
- Keep orphaned or missing-workspace chats visible and readable.
- Open the original raw transcript for recovery or inspection.
- Read current `.jsonl` and legacy `.json` session formats.

## Screenshots

<!-- Screenshots will be added before the Marketplace listing is finalized. -->

## Usage

1. Select **Workspace Chats** in the Activity Bar.
2. Search by workspace, product, title, prompt, or response text.
3. Select a result to preview its transcript.
4. Select **Continue chat** to open its original workspace and restore the native session.

For chats created by another VS Code product, install Cross-Workspace Chat Viewer in both Stable and Insiders. The extension launches the originating product and completes the handoff there.

## Settings

| Setting | Default | Purpose |
|---|---:|---|
| `universalChatViewer.additionalStorageRoots` | `[]` | Additional `workspaceStorage` folders to scan. |
| `universalChatViewer.openWorkspaceInNewWindow` | `false` | Open same-product workspaces in a new window before continuing. |

## Privacy

Cross-Workspace Chat Viewer reads chat transcripts directly from local VS Code storage. It does not upload transcripts, collect telemetry, or make network requests. See [PRIVACY.md](PRIVACY.md) for details.

## Known limitations

- VS Code does not currently expose a stable public API for enumerating and reopening all local chats. This extension relies on private on-disk formats and internal commands that may change.
- Cross-product continuation requires the extension to be installed in both VS Code Stable and VS Code Insiders.
- Chats whose original workspace has been deleted can be viewed but cannot be continued in place.
- The extension searches local desktop storage and does not index remote-machine chat storage.

## Development

```sh
npm install
npm test
npm run package
```

Press `F5` in VS Code to run an Extension Development Host. The packaged `.vsix` can be installed with **Extensions: Install from VSIX...**.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
