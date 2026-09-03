# Contributing

Contributions and compatibility reports are welcome.

## Development

1. Install dependencies with `npm install`.
2. Run tests with `npm test`.
3. Press `F5` in VS Code to launch an Extension Development Host.
4. Package a local build with `npm run package`.

## Pull requests

- Keep changes focused and include tests for parser or storage behavior.
- Do not include real chat transcripts, workspace paths, tokens, or other personal data in tests or issues.
- Test against the latest VS Code Stable or Insiders release when changing private chat-format integration.
- Update `CHANGELOG.md` for user-visible changes.

## Compatibility reports

When reporting a format regression, include the VS Code version, operating system, transcript file extension, and sanitized record shapes. Do not attach an unredacted transcript.
