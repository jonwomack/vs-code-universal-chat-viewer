# Changelog

All notable changes to Universal Chat Viewer are documented here.

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
