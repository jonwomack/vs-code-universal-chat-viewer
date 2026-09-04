"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const vscode = require("vscode");
const {
  defaultStorageRoots,
  scanStorageRoots,
  workspaceUri
} = require("./src/chatStorage");

const PENDING_SESSION_KEY = "universalChatViewer.pendingSession";
const CROSS_PRODUCT_HANDOFF = path.join(
  os.tmpdir(),
  `universal-chat-viewer-${typeof process.getuid === "function" ? process.getuid() : "user"}.json`
);

class ChatViewerProvider {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this.view = undefined;
    this.sessions = [];
    this.refreshVersion = 0;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = webviewHtml(view.webview);
    view.webview.onDidReceiveMessage((message) => {
      this.handleMessage(message).catch((error) => this.showActionError(error));
    });
    this.refresh().catch((error) => this.showRefreshError(error));
  }

  async handleMessage(message) {
    if (message.type === "ready" || message.type === "refresh") {
      await this.refresh();
      return;
    }

    const session = this.sessions.find((candidate) => candidate.key === message.key);
    if (!session) {
      vscode.window.showErrorMessage("That chat session is no longer available. Refresh the viewer.");
      return;
    }

    if (message.type === "continue") {
      await continueSession(this.context, session);
    } else if (message.type === "openWorkspace") {
      await openWorkspace(session, true);
    } else if (message.type === "openRaw") {
      const document = await vscode.workspace.openTextDocument(session.filePath);
      await vscode.window.showTextDocument(document);
    }
  }

  async refresh() {
    const refreshVersion = ++this.refreshVersion;
    this.view?.webview.postMessage({ type: "loading" });
    const configuration = vscode.workspace.getConfiguration("universalChatViewer");
    const additionalRoots = configuration.get("additionalStorageRoots", []);
    const roots = defaultStorageRoots(
      this.context.globalStorageUri.fsPath,
      additionalRoots,
      currentProductId()
    );
    const result = await scanStorageRoots(roots);
    if (refreshVersion !== this.refreshVersion) {
      return;
    }
    this.sessions = result.sessions;

    this.output.clear();
    this.output.appendLine(`Scanned ${roots.length} storage roots and found ${result.sessions.length} chats.`);
    for (const error of result.errors) {
      this.output.appendLine(error);
    }

    this.view?.webview.postMessage({
      type: "sessions",
      sessions: this.sessions.map(({ searchableText, storageDirectory, filePath, ...session }) => session),
      errorCount: result.errors.length
    });
  }

  showRefreshError(error) {
    this.output.appendLine(`Unable to scan chats: ${error.stack || error.message}`);
    vscode.window.showErrorMessage(`Unable to scan chats: ${error.message}`);
    this.view?.webview.postMessage({ type: "error", message: error.message });
  }

  showActionError(error) {
    this.output.appendLine(`Action failed: ${error.stack || error.message}`);
    vscode.window.showErrorMessage(`Cross-Workspace Chat Viewer: ${error.message}`);
  }
}

async function continueSession(context, session) {
  const target = workspaceUri(session);
  if (!target) {
    vscode.window.showWarningMessage("This chat is orphaned and has no original workspace metadata.");
    return;
  }
  if (!session.workspaceExists) {
    vscode.window.showWarningMessage(
      `The original workspace for "${session.title}" no longer exists at ${session.workspacePath || target}.`
    );
    return;
  }

  const currentProduct = currentProductId();
  if (isKnownProduct(session.sourceProduct) && session.sourceProduct !== currentProduct) {
    await continueInOtherProduct(session, target);
    return;
  }

  if (isCurrentWorkspace(target)) {
    await openNativeChat(session.id);
    return;
  }

  await queuePendingSession(context, {
    id: session.id,
    workspaceUri: target,
    savedAt: Date.now()
  });
  await openWorkspace(session, false);
}

async function openWorkspace(session, forceNewWindow) {
  const target = workspaceUri(session);
  if (!target) {
    vscode.window.showWarningMessage("This chat is orphaned and has no original workspace metadata.");
    return;
  }
  if (!session.workspaceExists) {
    vscode.window.showWarningMessage(
      `The original workspace no longer exists at ${session.workspacePath || target}.`
    );
    return;
  }
  if (isKnownProduct(session.sourceProduct) && session.sourceProduct !== currentProductId()) {
    await launchProduct(session.sourceProduct, target);
    return;
  }

  const configuredNewWindow = vscode.workspace
    .getConfiguration("universalChatViewer")
    .get("openWorkspaceInNewWindow", false);
  await vscode.commands.executeCommand(
    "vscode.openFolder",
    vscode.Uri.parse(target),
    forceNewWindow || configuredNewWindow
  );
}

function isCurrentWorkspace(target) {
  const targetUri = vscode.Uri.parse(target);
  const workspaceFile = vscode.workspace.workspaceFile;
  if (workspaceFile && workspaceFile.toString() === targetUri.toString()) {
    return true;
  }
  return vscode.workspace.workspaceFolders?.some((folder) =>
    folder.uri.toString() === targetUri.toString()
  ) || false;
}

async function openNativeChat(sessionId) {
  const encodedId = Buffer.from(sessionId, "utf8").toString("base64url");
  const resource = vscode.Uri.parse(`vscode-chat-session://local/${encodedId}`);
  const commands = await vscode.commands.getCommands(true);
  if (commands.includes("workbench.action.chat.openSessionInEditorGroup")) {
    await vscode.commands.executeCommand(
      "workbench.action.chat.openSessionInEditorGroup",
      { resource }
    );
    return;
  }

  await vscode.commands.executeCommand("vscode.open", resource, {
    preview: false,
    preserveFocus: false
  });
}

async function resumePendingSession(context) {
  const stored = context.globalState.get(PENDING_SESSION_KEY);
  if (!stored) {
    return;
  }

  const pending = (Array.isArray(stored) ? stored : [stored])
    .filter((item) => isFreshHandoff(item));
  const matching = pending.filter((item) => isCurrentWorkspace(item.workspaceUri));
  const remaining = pending.filter((item) => !matching.includes(item));
  await context.globalState.update(
    PENDING_SESSION_KEY,
    remaining.length ? remaining : undefined
  );
  for (const item of matching) {
    await openNativeChat(item.id);
  }
}

async function queuePendingSession(context, item) {
  const stored = context.globalState.get(PENDING_SESSION_KEY);
  const pending = (Array.isArray(stored) ? stored : stored ? [stored] : [])
    .filter((candidate) => isFreshHandoff(candidate));
  pending.push(item);
  await context.globalState.update(PENDING_SESSION_KEY, pending);
}

async function resumeCrossProductSession() {
  const pending = await readCrossProductHandoffs();
  if (!pending.length) {
    return;
  }

  const fresh = pending.filter((item) => isFreshHandoff(item));
  const matching = fresh.filter((item) =>
    item.product === currentProductId() && isCurrentWorkspace(item.workspaceUri)
  );
  const remaining = fresh.filter((item) => !matching.includes(item));
  await writeCrossProductHandoffs(remaining);
  for (const item of matching) {
    await openNativeChat(item.id);
  }
}

async function continueInOtherProduct(session, target) {
  const handoff = {
    token: crypto.randomUUID(),
    id: session.id,
    workspaceUri: target,
    product: session.sourceProduct,
    savedAt: Date.now()
  };
  const pending = (await readCrossProductHandoffs())
    .filter((item) => isFreshHandoff(item));
  pending.push(handoff);
  await writeCrossProductHandoffs(pending);

  try {
    await launchProduct(session.sourceProduct, target);
  } catch (error) {
    await writeCrossProductHandoffs(
      (await readCrossProductHandoffs()).filter((item) => item.token !== handoff.token)
    );
    throw new Error(`Unable to launch ${session.sourceLabel}: ${error.message}`);
  }

  vscode.window.showInformationMessage(
    `Opening the chat in ${session.sourceLabel}. Cross-Workspace Chat Viewer must be installed there too.`
  );
}

async function readCrossProductHandoffs() {
  try {
    const stored = JSON.parse(await fs.promises.readFile(CROSS_PRODUCT_HANDOFF, "utf8"));
    return Array.isArray(stored) ? stored : [stored];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeCrossProductHandoffs(items) {
  if (!items.length) {
    await fs.promises.rm(CROSS_PRODUCT_HANDOFF, { force: true });
    return;
  }

  const temporaryPath = `${CROSS_PRODUCT_HANDOFF}.${process.pid}.${crypto.randomUUID()}`;
  await fs.promises.writeFile(
    temporaryPath,
    JSON.stringify(items),
    { encoding: "utf8", mode: 0o600 }
  );
  await fs.promises.rename(temporaryPath, CROSS_PRODUCT_HANDOFF);
}

function isFreshHandoff(item) {
  return item
    && typeof item.savedAt === "number"
    && Date.now() - item.savedAt <= 5 * 60 * 1000;
}

async function launchProduct(product, target) {
  const command = resolveProductCli(product);
  const targetUri = vscode.Uri.parse(target);
  const targetArgument = targetUri.scheme === "file" ? targetUri.fsPath : target;
  await new Promise((resolve, reject) => {
    const child = spawn(command, ["--new-window", targetArgument], {
      detached: true,
      stdio: "ignore"
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function currentProductId() {
  return vscode.env.appName.toLowerCase().includes("insiders") ? "insiders" : "stable";
}

function isKnownProduct(product) {
  return product === "stable" || product === "insiders";
}

function resolveProductCli(product) {
  const commandName = product === "insiders" ? "code-insiders" : "code";
  if (process.platform !== "darwin") {
    return commandName;
  }

  const application = product === "insiders"
    ? "Visual Studio Code - Insiders.app"
    : "Visual Studio Code.app";
  const bundledCli = path.join(
    "/Applications",
    application,
    "Contents",
    "Resources",
    "app",
    "bin",
    commandName
  );
  return fs.existsSync(bundledCli) ? bundledCli : commandName;
}

function webviewHtml(webview) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); font: var(--vscode-font-size) var(--vscode-font-family); }
    header { position: sticky; top: 0; z-index: 2; padding: 10px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-sideBar-border); }
    input { width: 100%; padding: 7px 9px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); outline: none; }
    input:focus { border-color: var(--vscode-focusBorder); }
    #summary { margin-top: 7px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    #sessions { padding: 6px; }
    .back-button { display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px; color: inherit; background: transparent; border: 1px solid var(--vscode-panel-border); border-radius: 4px; cursor: pointer; }
    .back-button:hover { background: var(--vscode-list-hoverBackground); }
    .card-list article { margin: 5px 0; border: 1px solid var(--vscode-panel-border); border-radius: 4px; overflow: hidden; }
    .card { width: 100%; padding: 9px; border: 0; color: inherit; background: transparent; text-align: left; cursor: pointer; }
    .card:hover { background: var(--vscode-list-hoverBackground); }
    .title { font-weight: 600; line-height: 1.3; }
    .meta { margin-top: 4px; color: var(--vscode-descriptionForeground); font-size: 0.88em; }
    .detail-view { padding: 4px 4px 24px; }
    .detail-title { font-weight: 600; font-size: 1.05em; line-height: 1.3; }
    .detail-meta { margin-top: 4px; margin-bottom: 6px; color: var(--vscode-descriptionForeground); font-size: 0.88em; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 9px 0; border-top: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 6px; }
    .actions button { padding: 5px 8px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; cursor: pointer; }
    .actions button:hover { background: var(--vscode-button-hoverBackground); }
    .actions button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .message { margin-top: 10px; }
    .role { margin-bottom: 4px; color: var(--vscode-descriptionForeground); font-size: 0.82em; font-weight: 600; text-transform: uppercase; }
    .text { padding: 8px; background: var(--vscode-textCodeBlock-background); white-space: pre-wrap; word-break: break-word; }
    .empty { padding: 24px 12px; color: var(--vscode-descriptionForeground); text-align: center; }
  </style>
</head>
<body>
  <header>
    <div id="listHeader">
      <input id="search" type="search" placeholder="Search every chat and workspace" aria-label="Search chats">
      <div id="summary">Scanning chat history...</div>
    </div>
    <div id="detailHeader" hidden>
      <button id="back" class="back-button">&larr; All chats</button>
    </div>
  </header>
  <main id="sessions"></main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const search = document.getElementById("search");
    const container = document.getElementById("sessions");
    const summary = document.getElementById("summary");
    const listHeader = document.getElementById("listHeader");
    const detailHeader = document.getElementById("detailHeader");
    const backButton = document.getElementById("back");
    let sessions = [];
    let openSessionKey;
    let listScrollTop = 0;

    function formatDate(value) {
      return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
    }

    const RELATIVE_UNITS = [
      { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
      { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
      { unit: "week", ms: 7 * 24 * 60 * 60 * 1000 },
      { unit: "day", ms: 24 * 60 * 60 * 1000 },
      { unit: "hour", ms: 60 * 60 * 1000 },
      { unit: "minute", ms: 60 * 1000 },
    ];
    const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

    function formatRelativeTime(value) {
      const diffMs = new Date(value).getTime() - Date.now();
      const absMs = Math.abs(diffMs);
      if (absMs < 60 * 1000) {
        return "just now";
      }
      for (const { unit, ms } of RELATIVE_UNITS) {
        if (absMs >= ms || unit === "minute") {
          return relativeFormatter.format(Math.round(diffMs / ms), unit);
        }
      }
      return "just now";
    }

    function searchable(session) {
      return [session.title, session.workspaceName, session.sourceLabel, ...session.messages.flatMap(message => [message.prompt, message.response])]
        .join("\\n").toLowerCase();
    }

    function action(label, type, key, secondary = false) {
      const button = document.createElement("button");
      button.textContent = label;
      button.className = secondary ? "secondary" : "";
      button.addEventListener("click", () => {
        vscode.postMessage({ type, key });
      });
      return button;
    }

    function renderMessage(role, value) {
      if (!value) return undefined;
      const block = document.createElement("div");
      block.className = "message";
      const label = document.createElement("div");
      label.className = "role";
      label.textContent = role;
      const text = document.createElement("div");
      text.className = "text";
      text.textContent = value;
      block.append(label, text);
      return block;
    }

    function totalMessages(list) {
      return list.reduce((sum, session) => sum + session.messageCount, 0);
    }

    function totalBytes(list) {
      return list.reduce((sum, session) => sum + (session.fileSizeBytes || 0), 0);
    }

    function formatBytes(bytes) {
      if (bytes < 1024 * 1024) {
        return (bytes / 1024).toFixed(1) + " KB";
      }
      if (bytes < 1024 * 1024 * 1024) {
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
      }
      return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
    }

    function openSession(key) {
      listScrollTop = window.scrollY;
      openSessionKey = key;
      render();
      requestAnimationFrame(() => {
        const lastMessage = container.querySelector(".message:last-child");
        (lastMessage || container).scrollIntoView({ block: "end" });
      });
    }

    function closeSession() {
      openSessionKey = undefined;
      render();
      window.scrollTo(0, listScrollTop);
    }

    function render() {
      const session = sessions.find(candidate => candidate.key === openSessionKey);
      listHeader.hidden = Boolean(session);
      detailHeader.hidden = !session;
      if (session) {
        renderDetail(session);
      } else {
        renderList();
      }
    }

    function renderList() {
      const query = search.value.trim().toLowerCase();
      const visible = sessions.filter(session => !query || searchable(session).includes(query));
      summary.textContent = visible.length === sessions.length
        ? sessions.length + " chats and " + totalMessages(sessions) + " messages across all workspaces (" + formatBytes(totalBytes(sessions)) + ")"
        : visible.length + " of " + sessions.length + " chats, " + totalMessages(visible) + " of " + totalMessages(sessions) + " messages (" + formatBytes(totalBytes(visible)) + " of " + formatBytes(totalBytes(sessions)) + ")";
      container.className = "card-list";
      container.replaceChildren();

      if (!visible.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = sessions.length ? "No chats match this search." : "No local chat sessions were found.";
        container.append(empty);
        return;
      }

      for (const session of visible) {
        const article = document.createElement("article");
        const card = document.createElement("button");
        card.className = "card";
        const title = document.createElement("div");
        title.className = "title";
        title.textContent = session.title;
        const meta = document.createElement("div");
        meta.className = "meta";
        const workspaceStatus = session.workspaceExists ? session.workspaceName : session.workspaceName + " (missing)";
        meta.textContent = workspaceStatus + " · " + session.sourceLabel + " · " + session.messageCount + " messages · " + formatRelativeTime(session.modifiedAt);
        meta.title = formatDate(session.modifiedAt);
        card.append(title, meta);
        card.addEventListener("click", () => openSession(session.key));
        article.append(card);
        container.append(article);
      }
    }

    function renderDetail(session) {
      container.className = "detail-view";
      container.replaceChildren();

      const title = document.createElement("div");
      title.className = "detail-title";
      title.textContent = session.title;

      const meta = document.createElement("div");
      meta.className = "detail-meta";
      const workspaceStatus = session.workspaceExists ? session.workspaceName : session.workspaceName + " (missing)";
      meta.textContent = workspaceStatus + " · " + session.sourceLabel + " · " + session.messageCount + " messages · " + formatRelativeTime(session.modifiedAt);
      meta.title = formatDate(session.modifiedAt);

      const actions = document.createElement("div");
      actions.className = "actions";
      if (session.workspaceExists) {
        actions.append(action("Continue chat", "continue", session.key));
      }
      if (session.workspaceExists && (session.workspaceUri || session.workspacePath)) {
        actions.append(action("Open workspace", "openWorkspace", session.key, true));
      }
      actions.append(action("Raw transcript", "openRaw", session.key, true));

      container.append(title, meta, actions);
      for (const message of session.messages) {
        const prompt = renderMessage("You", message.prompt);
        const response = renderMessage("Assistant", message.response);
        if (prompt) container.append(prompt);
        if (response) container.append(response);
      }
    }

    backButton.addEventListener("click", closeSession);
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && openSessionKey) {
        closeSession();
      }
    });

    search.addEventListener("input", render);
    window.addEventListener("message", event => {
      if (event.data.type === "sessions") {
        sessions = event.data.sessions;
        render();
      } else if (event.data.type === "loading") {
        summary.textContent = "Scanning chat history...";
      } else if (event.data.type === "error") {
        summary.textContent = "Unable to scan chats: " + event.data.message;
      }
    });
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}

function activate(context) {
  const output = vscode.window.createOutputChannel("Cross-Workspace Chat Viewer");
  const provider = new ChatViewerProvider(context, output);
  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider("universalChatViewer.sessions", provider),
    vscode.commands.registerCommand("universalChatViewer.refresh", () =>
      provider.refresh().catch((error) => provider.showRefreshError(error))
    ),
    vscode.commands.registerCommand("universalChatViewer.open", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.universalChatViewer");
    })
  );
  Promise.all([
    resumePendingSession(context),
    resumeCrossProductSession()
  ]).catch((error) => {
    output.appendLine(`Unable to resume chat: ${error.stack || error.message}`);
    vscode.window.showErrorMessage(`Unable to resume chat: ${error.message}`);
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
