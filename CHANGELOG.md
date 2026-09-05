# Changelog

All notable changes to Cross-Workspace Chat Viewer are documented here.

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
