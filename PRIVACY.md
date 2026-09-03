# Privacy

Universal Chat Viewer is designed to operate entirely on your local machine.

## Data accessed

The extension reads:

- VS Code and VS Code Insiders `workspaceStorage` metadata.
- Local chat transcript files in `chatSessions` directories.
- Workspace paths associated with those transcripts.

This access is required to index, display, search, and reopen local chat sessions.

## Data handling

- Transcript contents stay on your machine.
- No transcript content is uploaded or transmitted by the extension.
- The extension does not collect telemetry, analytics, identifiers, or usage statistics.
- The extension does not modify or delete transcript files.
- Search is performed locally inside the extension webview.

When continuing a chat across VS Code Stable and Insiders, the extension writes a short-lived handoff file to the operating system's temporary directory. It contains only the session ID, originating product, workspace URI, and timestamp. It does not contain transcript text and is removed after use or expiration.

## Network access

Universal Chat Viewer does not make network requests. VS Code, GitHub Copilot, installed extensions, and opened workspaces may independently use network services according to their own settings and policies.

## Reporting concerns

Please report privacy or security concerns through the repository's private security advisory feature rather than including transcript content in a public issue.
