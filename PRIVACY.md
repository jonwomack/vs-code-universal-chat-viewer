# Privacy

Cross-Workspace Chat Viewer operates locally. It does not send transcripts or
prompts to external services.

## Data accessed

The extension reads:

- VS Code and VS Code Insiders `workspaceStorage` metadata.
- Local chat transcript files in `chatSessions` directories.
- Copilot `workspace.yaml` metadata and user/assistant messages from
  `~/.copilot/session-state/*/events.jsonl`, or configured alternative roots.
- Workspace paths associated with those transcripts.
- Saved `.code-workspace` files, when available, to show their configured root
  folders in the destination picker.

This access is required to index, display, search, and reopen local chat sessions.
Copilot event streams are read-only and are not imported or moved into native
VS Code storage. **Continue as new chat** exports their readable conversation
text rather than converting the original session format. Tool summaries/results
are used as a fallback when a turn has no narrated assistant response.

## Data handling

- Transcript contents stay on your machine.
- The extension does not collect telemetry, analytics, identifiers, or usage statistics.
- The extension never modifies or deletes original transcript files.
- When the user explicitly selects **Import**, the extension copies that
  transcript into the current VS Code product's local `workspaceStorage`.
- When the user explicitly selects **Copy to workspace**, the extension copies
  that transcript into the selected workspace's local `workspaceStorage`.
- When the user explicitly selects **Continue as new chat**, the extension
  stores a Markdown snapshot of parsed user/assistant turns, source path, and
  workspace metadata under `continuation-transcripts` in extension global
  storage with user-only file permissions. Snapshots persist so existing
  attachments remain readable. It attaches the snapshot to a new native chat
  and leaves the draft unsent. Sending that chat may share its context with the
  selected AI provider according to VS Code's settings and policies.
- **Copy transcript path** writes the original file's absolute path to the
  system clipboard. It does not copy transcript contents.
- When the user accepts an **Optimize workspace** suggestion, the extension writes a
  local `.code-workspace` file under its global storage. This file contains the
  selected folder paths and available settings from the source workspace, but
  no chat transcript content.
- Search is performed locally inside the extension webview.
- The viewer stores a local cache under extension global storage containing
  rendered transcript data, statistics, workspace metadata, and activity state
  so the list can survive a same-window workspace reload. The cache remains on
  the local machine and is written with user-only file permissions.

Focused-workspace recommendations are calculated locally from stored working
directories, attachments, references, citations, edits, and tool metadata. The
extension does not upload this information or inspect file contents to produce
the recommendation.

When continuing a chat across VS Code Stable and Insiders, the extension writes a short-lived handoff file to the operating system's temporary directory. It contains only the session ID, originating product, workspace URI, and timestamp. It does not contain transcript text and is removed after use or expiration.

When an import must continue after opening a workspace, its source file path,
session ID, and workspace URI are temporarily stored in VS Code's local
extension state. Transcript contents are not stored there.

## Network access

The extension makes no network requests. VS Code,
GitHub Copilot, installed extensions, and opened workspaces may independently
use network services according to their own settings and policies.

## Reporting concerns

Please report privacy or security concerns through the repository's private security advisory feature rather than including transcript content in a public issue.
