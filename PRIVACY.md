# Privacy

Cross-Workspace Chat Viewer operates locally by default. Optional semantic
routing sends transcript chunks to an Azure OpenAI endpoint explicitly
configured by the user.

## Data accessed

The extension reads:

- VS Code and VS Code Insiders `workspaceStorage` metadata.
- Local chat transcript files in `chatSessions` directories.
- GitHub Copilot CLI `workspace.yaml` metadata and user/assistant messages from
  `~/.copilot/session-state/*/events.jsonl`.
- Workspace paths associated with those transcripts.
- Saved `.code-workspace` files, when available, to show their configured root
  folders in the destination picker.

This access is required to index, display, search, and reopen local chat sessions.
CLI event streams are read-only and are not imported, copied, moved, or opened
as native VS Code chat sessions. Tool execution payloads in CLI event streams
are not included in the viewer transcript or search index.

## Data handling

- Transcript contents stay on your machine unless you explicitly enable
  semantic routing.
- The extension does not collect telemetry, analytics, identifiers, or usage statistics.
- The extension never modifies or deletes original transcript files.
- When the user explicitly selects **Import**, the extension copies that
  transcript into the current VS Code product's local `workspaceStorage`.
- When the user explicitly selects **Copy to workspace**, the extension copies
  that transcript into the selected workspace's local `workspaceStorage`.
- When the user accepts an **Optimize workspace** suggestion, the extension writes a
  local `.code-workspace` file under its global storage. This file contains the
  selected folder paths and available settings from the source workspace, but
  no chat transcript content.
- Search is performed locally inside the extension webview.
- Prompt routing is ranked locally. The routing prompt is placed into the
  selected native chat input and is not submitted by the extension.
- Prompt routing stores a compact local index under the extension's global
  storage. It contains chat metadata and deduplicated terms derived from the
  full local transcript.
- The viewer stores a local cache under extension global storage containing
  rendered transcript data, statistics, workspace metadata, and activity state
  so the list can survive a same-window workspace reload. The cache remains on
  the local machine and is written with user-only file permissions.
- When semantic routing is enabled, the extension sends chunks covering the
  complete discussion, plus each routing prompt, to the configured Azure
  OpenAI embedding endpoint. It stores returned vectors locally and sends only
  changed transcript chunks during later refreshes.
- API keys are stored through VS Code SecretStorage and are not written to
  settings or the routing index.

Focused-workspace recommendations are calculated locally from stored working
directories, attachments, references, citations, edits, and tool metadata. The
extension does not upload this information or inspect file contents to produce
the recommendation.

When continuing a chat across VS Code Stable and Insiders, the extension writes a short-lived handoff file to the operating system's temporary directory. It contains only the session ID, originating product, workspace URI, and timestamp. It does not contain transcript text and is removed after use or expiration.

When an import must continue after opening a workspace, its source file path,
session ID, and workspace URI are temporarily stored in VS Code's local
extension state. Transcript contents are not stored there.

## Network access

Lexical routing makes no network requests. Semantic routing makes HTTPS
requests only to the Azure OpenAI endpoint configured by the user. VS Code,
GitHub Copilot, installed extensions, and opened workspaces may independently
use network services according to their own settings and policies.

## Reporting concerns

Please report privacy or security concerns through the repository's private security advisory feature rather than including transcript content in a public issue.
