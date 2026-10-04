# Changelog

All notable changes to Cross-Workspace Chat Viewer are documented here.

## 0.4.20 - 2026-10-03

### Added

- Local GitHub Copilot CLI sessions are now searchable and readable alongside
  VS Code and VS Code Insiders chats. CLI sessions are treated as read-only
  transcripts and do not expose VS Code-specific continuation or migration
  actions.

## 0.4.19 - 2026-09-11

### Fixed

- Historical request metadata changes no longer trigger spinners or unread
  indicators; live activity is limited to the newest request and pending
  requests.
- Abandoned requests without response content no longer remain indefinitely
  in progress merely because they have no result.
- In-progress indicators are no longer persisted across extension restarts.
  Previously settled unread response indicators remain cached.

## 0.4.18 - 2026-09-11

### Fixed

- Missing-workspace recovery now skips transcript-derived UNC paths whose hosts
  VS Code blocks through its UNC security policy, rather than aborting the
  entire recovery attempt with `ERR_UNC_HOST_NOT_ALLOWED`.

## 0.4.17 - 2026-09-11

### Fixed

- Missing-workspace recovery now rejects ANSI-colored terminal output, shell
  commands, control characters, and oversized strings before treating them as
  filesystem paths.
- Invalid or overlong transcript-derived candidates no longer abort recovery
  while checking which referenced folders still exist.

## 0.4.16 - 2026-09-10

### Added

- Missing workspaces can be recovered from surviving known roots, working
  directories, edits, attachments, references, and tool paths. Recovery is
  enabled by default and always confirms the proposed folders.
- When a current-workspace chat response appears active, destination workspaces
  open in a new window by default to avoid interrupting it.

### Changed

- Recovered chats are moved using the verified copy-then-delete flow; missing
  project directories are never recreated as empty folders.

## 0.4.15 - 2026-09-10

### Changed

- Metrics retain shared chat and disk-size totals while splitting activity into
  **You** prompts/words and **Bot** responses/words.
- Chat cards now label their request count as prompts instead of the ambiguous
  messages.

## 0.4.14 - 2026-09-10

### Fixed

- Initial progressive discovery now batches list rendering instead of
  rebuilding the entire DOM on every animation frame.
- Progressive list updates pause while the pointer is over the chat list,
  preventing cards from flashing or moving beneath the cursor.

## 0.4.13 - 2026-09-10

### Changed

- Azure semantic routing is enabled by default. Sending the first prompt opens
  secure endpoint-and-key configuration when credentials are missing.
- Missing semantic configuration no longer produces background indexing
  errors; lexical indexing remains available until setup is complete.
- Transcript preview now defaults to disabled. Users can enable
  `displayChatPreview` to inspect chats inside the extension.

## 0.4.12 - 2026-09-10

### Changed

- Chat list data, transcript previews, statistics, and activity state are cached
  in extension global storage and restored as one snapshot after a same-window
  workspace reload.
- After restoration, only transcripts changed during the reload are reparsed;
  new or removed transcripts are reconciled without replaying statistics.

## 0.4.11 - 2026-09-10

### Fixed

- Same-window workspace changes now explicitly request `forceReuseWindow`
  instead of relying on the legacy boolean `vscode.openFolder` argument.
- Workspace Chats is reopened after a same-window workspace reload before the
  pending native chat is continued.

## 0.4.10 - 2026-09-10

### Changed

- Chats whose workspaces differ from the current workspace now open in the
  current window by default. Enable `openWorkspaceInNewWindow` to preserve the
  previous new-window behavior.

## 0.4.9 - 2026-09-10

### Added

- `displayChatPreview` controls whether selecting a chat renders its transcript
  inside the extension; it defaults to enabled.
- `autoOpenChatOnSelect` immediately continues the native chat when its list
  item is selected; it defaults to enabled.

### Changed

- Disabling automatic opening restores the preview-first workflow with the
  manual **Continue chat** action.

## 0.4.8 - 2026-09-10

### Changed

- Azure semantic routing now supports one authentication path: an API key
  stored in VS Code SecretStorage.
- Configuration now asks only for the endpoint and API key. The deployment
  remains an advanced setting with `text-embedding-3-small` as its default.
- Removed Azure CLI authentication, its authentication selector, and the
  subscription setting.

## 0.4.7 - 2026-09-10

### Changed

- Reopening the view now restores all cached chats and statistics in one
  snapshot without replaying loading and word-count phases.
- **Optimize workspace** now moves the chat: it copies and verifies the
  destination transcript before deleting the original, preventing duplicates.
- Moved chats receive a fresh modification time so they appear at the top of
  the destination chat list.
- Deleting or moving a watched transcript removes its old card immediately.

## 0.4.6 - 2026-09-10

### Added

- Lightweight transcript directory watchers show a spinner while a changed
  chat response is in progress and a blue dot when new activity finishes.
- Opening a chat from the list clears its new-activity indicator.

### Changed

- Live chat updates read only appended JSONL records, ignore draft-input
  changes, and reparse only the changed transcript after activity settles.

## 0.4.5 - 2026-09-09

### Changed

- Opening a routed or continued chat in another workspace now defaults to a new
  window, preserving the workspace where routing started.
- **Optimize workspace** is visible for every chat with known workspace roots;
  single-root workspaces explain that there is nothing to trim.
- Removed **Raw transcript** and the redundant "across all workspaces" metrics
  suffix.

## 0.4.4 - 2026-09-09

### Changed

- Chat browsing and prompt routing now share one view, with a persistent prompt
  composer beneath the chat list.
- Collapsing and reopening the view now restores cached chat and statistics
  data instead of rescanning every transcript.
- The routing action now uses a familiar **Send** button and Enter-to-send
  behavior instead of **Rank threads**.

## 0.4.3 - 2026-09-09

### Added

- **Route a Prompt** now shows live local or semantic index readiness,
  including chats ready, pending transcript changes, and lexical fallback.

## 0.4.2 - 2026-09-09

### Added

- Optional Azure OpenAI semantic routing using full-discussion chunks and
  locally persisted embeddings.
- API-key authentication stores the key in VS Code SecretStorage; Azure CLI
  authentication is also available for local development.
- Commands to configure Azure semantic routing, rebuild its index, or disable
  it and remove the stored API key and vectors.

## 0.4.1 - 2026-09-09

### Added

- Prompt routing now uses a persistent background index and reparses only
  transcripts whose path, size, or modification time changed.
- The routing index derives terms from each complete discussion, including
  prompts and responses, while keeping prompt-time ranking in memory.

### Changed

- **Suggest focused workspace** is now **Optimize workspace**, clarifying that
  it trims unused roots from multi-root workspaces for a more focused chat.

## 0.4.0 - 2026-09-09

### Changed

- **Open workspace** now shows a notification and does nothing when that exact
  workspace is already open in the current window.

### Added

- Chats from a VS Code product that is no longer installed can now be imported
  non-destructively into the current product and continued there.
- Imports wait for the destination workspace to initialize when it has not
  previously been opened in the current product.
- Chats can now be copied non-destructively to another initialized workspace.
  The destination picker shows each workspace's path and configured root
  folders, including workspaces that do not have chats yet.
- The Copilot Chat Thread Router prototype is now integrated as **Route a
  Prompt**. It ranks current-product chats, opens the best matching thread, and
  pre-fills the prompt without submitting it.
- Multi-root chats now offer **Suggest focused workspace**. The extension
  preselects roots with recorded use, identifies roots with no observed use,
  and creates a non-destructive focused workspace from the accepted selection.

### Fixed

- A folder inside a different multi-root workspace is no longer mistaken for
  the single-folder workspace where a chat was originally stored.
- Existing queued handoffs are deduplicated before the extension attempts to
  resume them.

## 0.3.1 - 2026-09-08

### Fixed

- Continue-chat handoffs now recognize Windows untitled multi-root workspaces
  when saved chats identify the same workspace with a `file:` URI.
- Repeated clicks no longer queue duplicate same-product or cross-product
  handoffs for the same chat and workspace.

## 0.3.0 - 2026-09-08

### Changed

- Renamed settings, commands, and view identifiers from `universalChatViewer`
  to `crossWorkspaceChatViewer`.
- Existing values in the previous settings namespace are migrated automatically.

### Fixed

- Cross-product actions on Windows now launch the installed VS Code executable
  directly instead of relying on `code` or `code-insiders` being on the
  extension host's `PATH`.

## 0.2.11 - 2026-09-08

### Changed

- Chat history now appears progressively, with recently modified sessions scanned first.
- Large JSONL transcripts are streamed instead of loaded and split as one giant string.
- Word-count statistics are calculated only after chats have appeared.

### Fixed

- Opening the sidebar no longer starts two concurrent full-history scans.

## 0.2.10 - 2026-09-04

### Fixed

- Fixed a regression from 0.2.9 where the detail header (back button + actions) stayed visible while browsing the chat list, because its `display: flex` rule overrode the `hidden` attribute.

### Added

- The summary line now also shows total word count (e.g. "12.3k words"), alongside chats, messages, and disk size.

## 0.2.9 - 2026-09-04

### Fixed

- The "Continue chat", "Open workspace", and "Raw transcript" buttons now live in the sticky detail header instead of the scrolling transcript, so they stay visible after auto-scrolling to the latest message.

## 0.2.8 - 2026-09-04

### Added

- Empty chats (0 messages — panels opened but never used) are now hidden from the list by default. A new "Show empty chats" checkbox reveals them, and the summary line notes how many are hidden.

## 0.2.7 - 2026-09-04

### Changed

- Chat list and detail views now show "updated X ago" (relative time) instead of an exact date/time. Hover over it to see the exact timestamp.

## 0.2.6 - 2026-09-04

### Added

- The summary line now shows total on-disk size of scanned chat transcripts (e.g. "12 chats and 340 messages across all workspaces (4.2 MB)").

## 0.2.5 - 2026-09-04

### Changed

- Removed preview status now that the full-panel chat view and auto-scroll behavior have been tested and are considered stable.

## 0.2.4 - 2026-09-04

### Changed

- Clicking a chat now opens it full-panel (replacing the list) with a back button, matching the built-in chat view instead of expanding inline in the list.

## 0.2.3 - 2026-09-04

### Changed

- Opening a chat now scrolls straight to its most recent message instead of starting at the top.
- The summary line now shows total message counts alongside chat counts (e.g. "12 chats and 340 messages across all workspaces").
- Removed the inner scrollbar on long messages so the panel has a single, page-level scroll instead of nested scroll regions.

## 0.2.2 - 2026-09-04

### Changed

- Moved the Marketplace listing to the permanent identifier `jonwomack.cross-workspace-chat-viewer`.
- The previous `jonwomack.universal-chat-viewer` identifier is superseded by this listing.

## 0.2.1 - 2026-09-02

### Changed

- Renamed the user-facing extension to Cross-Workspace Chat Viewer.
- Renamed the Activity Bar container to Workspace Chats.
- Renamed the sidebar view to All Chat Sessions.
- Clarified the Marketplace description around cross-workspace chat navigation.

## 0.2.0 - 2026-09-02

### Added

- Product labels for VS Code Stable and VS Code Insiders sessions.
- Cross-product continuation using a short-lived local handoff.
- Missing-workspace detection and clearer orphaned-session behavior.
- Marketplace icon, publishing metadata, privacy documentation, and CI.

### Changed

- Chat storage scanning is asynchronous to avoid blocking the extension host.
- Session results use source-qualified identities to avoid collisions.
- Continued chats open as pinned native chat editors.

## 0.1.0 - 2026-09-02

- Initial local prototype with cross-workspace search, transcript preview, and native chat restoration.
