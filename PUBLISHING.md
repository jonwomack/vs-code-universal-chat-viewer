# Publishing

This documents how `jonwomack.cross-workspace-chat-viewer` gets published to the
VS Code Marketplace, including the one setup step that makes CLI publishing work
without ever creating or storing a Personal Access Token (PAT) locally.

## One-time setup: authorize the Azure identity as a Contributor

`vsce publish` supports two authentication modes:

1. **PAT-based** (`vsce login <publisher>`) — requires generating an Azure DevOps
   Personal Access Token with Marketplace → Manage scope, then storing it locally
   (`~/.vsce`) or in `VSCE_PAT`. This works anywhere, but means a long-lived
   secret exists on disk.
2. **Azure identity-based** (`vsce publish --azure-credential`) — uses whatever
   Azure/Entra identity is already authenticated in the current environment (via
   `@azure/identity`'s default credential chain). No PAT is generated or stored;
   the environment's ambient Azure login is used directly.

Option 2 is what this project uses. It requires the Azure/Entra principal running
in your publishing environment to be an authorized **Contributor** on the
`jonwomack` Marketplace publisher:

1. Open <https://marketplace.visualstudio.com/manage/publishers/jonwomack>.
2. Go to the publisher's **Members** page.
3. Add the Azure/Entra principal (object ID) that your publishing environment
   authenticates as, with the **Contributor** role.

Once that principal is authorized, any environment authenticated as that
identity can run:

```bash
npx vsce publish --azure-credential
```

with no PAT, no `vsce login`, and no secret stored on disk. This is why an
agent or CI job running under that identity can publish releases hands-off,
while a machine with no matching Azure session (or a placeholder/anonymous
credential) will fail with a "not authorized" or "PAT verification failed"
error — that failure means the current session isn't authenticated as the
authorized principal, not that PAT-based auth is required.

## Release checklist

1. Bump `"version"` in `package.json`.
2. Add a dated entry to `CHANGELOG.md`.
3. Run `npm test`.
4. `npx vsce package` to build and sanity-check the `.vsix` contents.
5. `npx vsce publish --azure-credential`.
6. Commit and push `package.json`/`CHANGELOG.md`/source changes to `main`.

## Troubleshooting

- **`ERROR: The Personal Access Token verification has failed`** — this means
  `vsce` fell back to (or was explicitly given) PAT auth and found no valid
  token. If you intend to use the Azure identity path, pass
  `--azure-credential` explicitly; don't rely on the default auth mode.
- **`not authorized to access this resource`** — the current Azure identity
  isn't a Contributor on the `jonwomack` publisher yet. Add it via the
  Members page above.
- **New identifier after a rename** — publishing under a new
  `publisher.name` identifier (e.g. the `universal-chat-viewer` →
  `cross-workspace-chat-viewer` migration) creates a brand-new Marketplace
  listing with no shared install/review history. Marketplace propagation for
  a newly created identifier can take a few minutes before `code`/
  `code-insiders --install-extension <id>` can find it.
