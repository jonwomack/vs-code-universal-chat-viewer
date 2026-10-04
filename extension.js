"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { fileURLToPath, pathToFileURL } = require("node:url");
const vscode = require("vscode");
const {
  defaultStorageRoots,
  parseJsonWithComments,
  readSessionFile,
  refreshSession,
  scanStorageRoots,
  sessionWordCounts,
  workspaceUri
} = require("./src/chatStorage");
const {
  defaultCopilotCliRoot,
  scanCopilotCliSessions
} = require("./src/copilotCliStorage");
const {
  resolveInstalledProductCommand,
  resolveProductCommand
} = require("./src/productLauncher");
const {
  findWorkspaceStorageDirectory,
  importChatSession,
  moveChatSession
} = require("./src/chatImporter");
const {
  deduplicateHandoffs,
  isCurrentWorkspaceUri,
  sameStoredWorkspaceUri
} = require("./src/workspaceIdentity");
const {
  chooseAutomatically,
  rankSessions,
  rankSessionsByEmbedding
} = require("./src/router");
const {
  analyzeWorkspaceUsage,
  isUnavailableRecoveryPathError,
  normalizeLocalPath,
  recoveryLocationPaths
} = require("./src/workspaceAdvisor");
const { RouteIndex } = require("./src/routeIndex");
const { AzureEmbeddingClient } = require("./src/azureEmbeddings");
const {
  classifyAppendedChatActivity,
  chatIsInProgress
} = require("./src/transcriptActivity");

const CONFIGURATION_SECTION = "crossWorkspaceChatViewer";
const LEGACY_CONFIGURATION_SECTION = "universalChatViewer";
const PENDING_SESSION_KEY = "crossWorkspaceChatViewer.pendingSession";
const LEGACY_PENDING_SESSION_KEY = "universalChatViewer.pendingSession";
const PENDING_IMPORT_KEY = "crossWorkspaceChatViewer.pendingImport";
const PENDING_ROUTE_KEY = "crossWorkspaceChatViewer.pendingRoute";
const PENDING_ROUTE_MAX_AGE_MS = 2 * 60 * 1000;
const AZURE_EMBEDDING_KEY = "crossWorkspaceChatViewer.azureEmbeddingApiKey";
const VIEWER_CACHE_VERSION = 3;
// Keep the shared filename until both Stable and Insiders have upgraded.
const CROSS_PRODUCT_HANDOFF = path.join(
  os.tmpdir(),
  `universal-chat-viewer-${typeof process.getuid === "function" ? process.getuid() : "user"}.json`
);

class ChatViewerProvider {
  constructor(context, output, routeIndex) {
    this.context = context;
    this.output = output;
    this.routeIndex = routeIndex;
    this.cachePath = path.join(context.globalStorageUri.fsPath, "chat-viewer-cache.json");
    this.view = undefined;
    this.sessions = [];
    this.workspaces = [];
    this.refreshVersion = 0;
    this.refreshPromise = undefined;
    this.hasLoaded = false;
    this.activity = new Map();
    this.transcriptOffsets = new Map();
    this.watchers = [];
    this.settleTimers = new Map();
    this.newSessionTimer = undefined;
    this.pendingNewFiles = new Set();
    this.cacheLoadPromise = undefined;
    context.subscriptions.push(routeIndex.onDidChangeStatus((status) =>
      this.postIndexStatus(status)
    ));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(`${CONFIGURATION_SECTION}.displayChatPreview`)
        || event.affectsConfiguration(`${CONFIGURATION_SECTION}.autoOpenChatOnSelect`)
      ) {
        this.postPreferences();
      }
    }));
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = webviewHtml(view.webview);
    view.webview.onDidReceiveMessage((message) => {
      this.handleMessage(message).catch((error) => this.showActionError(error));
    });
  }

  async handleMessage(message) {
    if (message.type === "ready") {
      this.postIndexStatus(this.routeIndex.getStatus());
      this.postPreferences();
      await this.loadCache();
      if (this.hasLoaded) {
        await this.postCachedSessions();
        void this.reconcileCache();
      } else if (this.refreshPromise) {
        await this.refreshPromise;
        await this.postCachedSessions();
      } else {
        await this.refresh();
      }
      return;
    }
    if (message.type === "refresh") {
      await this.refresh();
      return;
    }
    if (message.type === "route") {
      try {
        await routePrompt(this.context, message.prompt, this, this.routeIndex);
      } catch (error) {
        this.showError(error);
      }
      return;
    }

    const session = this.sessions.find((candidate) => candidate.key === message.key);
    if (!session) {
      vscode.window.showErrorMessage("That chat session is no longer available. Refresh the viewer.");
      return;
    }

    if (message.type === "selectSession") {
      const protectActiveChat = this.shouldProtectActiveChat(session);
      this.activity.delete(session.key);
      await this.persistCache();
      if (
        session.canContinue !== false
        &&
        vscode.workspace
          .getConfiguration(CONFIGURATION_SECTION)
          .get("autoOpenChatOnSelect", true)
      ) {
        await continueSession(this.context, session, protectActiveChat);
      }
      return;
    }
    if (message.type === "continue") {
      await continueSession(
        this.context,
        session,
        this.shouldProtectActiveChat(session)
      );
    } else if (message.type === "import") {
      await importSession(this.context, session);
    } else if (message.type === "copyToWorkspace") {
      await copySessionToWorkspace(this.context, session, this.workspaces);
    } else if (message.type === "optimizeWorkspace") {
      await suggestFocusedWorkspace(this.context, session);
    } else if (message.type === "recoverWorkspace") {
      await recoverMissingWorkspace(
        this.context,
        session,
        this.shouldProtectActiveChat(session)
      );
    } else if (message.type === "openWorkspace") {
      await openWorkspace(session, true);
    }
  }

  refresh() {
    if (!this.refreshPromise) {
      this.refreshPromise = this.scan().finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return this.refreshPromise;
  }

  async scan() {
    const refreshVersion = ++this.refreshVersion;
    this.sessions = [];
    this.workspaces = [];
    this.view?.webview.postMessage({ type: "loading" });
    const roots = this.storageRoots();
    const currentProduct = currentProductId();
    const availableProducts = {
      stable: currentProduct === "stable" || Boolean(resolveInstalledProductCommand("stable")),
      insiders: currentProduct === "insiders" || Boolean(resolveInstalledProductCommand("insiders"))
    };
    const onSession = async (session) => {
      if (refreshVersion !== this.refreshVersion) {
        return;
      }
      this.sessions.push(session);
      await this.view?.webview.postMessage({
        type: "session",
        session: webviewSession(
          session,
          currentProduct,
          availableProducts,
          this.activity.get(session.key)
        )
      });
    };
    const [vscodeResult, cliResult] = await Promise.all([
      scanStorageRoots(roots, {
        shouldContinue: () => refreshVersion === this.refreshVersion,
        onSession
      }),
      scanCopilotCliSessions(defaultCopilotCliRoot(), {
        shouldContinue: () => refreshVersion === this.refreshVersion,
        onSession
      })
    ]);
    if (refreshVersion !== this.refreshVersion) {
      return;
    }
    this.sessions = [...vscodeResult.sessions, ...cliResult.sessions]
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
    this.workspaces = vscodeResult.workspaces;
    for (const session of this.sessions) {
      if (this.pendingNewFiles.has(session.filePath)) {
        this.activity.set(session.key, { inProgress: false, newActivity: true });
        this.postActivity(session.key);
      }
    }
    this.pendingNewFiles.clear();

    this.output.clear();
    const errors = [...vscodeResult.errors, ...cliResult.errors];
    this.output.appendLine(
      `Scanned ${roots.length} VS Code storage roots and GitHub Copilot CLI history; found ${this.sessions.length} chats.`
    );
    for (const error of errors) {
      this.output.appendLine(error);
    }

    this.view?.webview.postMessage({
      type: "complete",
      errorCount: errors.length
    });

    const wordCounts = {};
    for (const session of this.sessions) {
      await new Promise((resolve) => setImmediate(resolve));
      if (refreshVersion !== this.refreshVersion) {
        return;
      }
      const counts = sessionWordCounts(session);
      session.userWordCount = counts.user;
      session.botWordCount = counts.bot;
      wordCounts[session.key] = counts;
    }
    this.view?.webview.postMessage({ type: "stats", wordCounts });
    this.hasLoaded = true;
    this.watchTranscripts();
    await this.persistCache();
  }

  async postCachedSessions() {
    const currentProduct = currentProductId();
    const availableProducts = {
      stable: currentProduct === "stable" || Boolean(resolveInstalledProductCommand("stable")),
      insiders: currentProduct === "insiders" || Boolean(resolveInstalledProductCommand("insiders"))
    };
    this.view?.webview.postMessage({
      type: "snapshot",
      sessions: this.sessions.map((session) => webviewSession(
        session,
        currentProduct,
        availableProducts,
        this.activity.get(session.key)
      ))
    });
  }

  postStatus(status) {
    this.view?.webview.postMessage({ type: "routeStatus", ...status });
  }

  postIndexStatus(status) {
    this.view?.webview.postMessage({
      type: "indexStatus",
      message: formatIndexStatus(status)
    });
  }

  postPreferences() {
    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    this.view?.webview.postMessage({
      type: "preferences",
      displayChatPreview: configuration.get("displayChatPreview", false)
    });
  }

  shouldProtectActiveChat(destination) {
    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    const target = workspaceUri(destination);
    if (
      !configuration.get("openNewWindowWhenChatActive", true)
      || !target
      || isCurrentWorkspace(target)
    ) {
      return false;
    }
    return this.sessions.some((session) =>
      this.activity.get(session.key)?.inProgress
      && workspaceUri(session)
      && isCurrentWorkspace(workspaceUri(session))
    );
  }

  storageRoots() {
    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    return defaultStorageRoots(
      this.context.globalStorageUri.fsPath,
      configuration.get("additionalStorageRoots", []),
      currentProductId()
    );
  }

  loadCache() {
    if (!this.cacheLoadPromise) {
      this.cacheLoadPromise = this.readCache();
    }
    return this.cacheLoadPromise;
  }

  async readCache() {
    let stored;
    try {
      stored = JSON.parse(await fs.promises.readFile(this.cachePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.output.appendLine(`Unable to read viewer cache: ${error.message}`);
      }
      return;
    }
    if (
      stored?.version !== VIEWER_CACHE_VERSION
      || stored.roots !== this.storageRootsSignature()
      || !Array.isArray(stored.sessions)
      || !Array.isArray(stored.workspaces)
    ) {
      return;
    }
    this.sessions = stored.sessions;
    this.workspaces = stored.workspaces;
    this.activity = new Map(
      (Array.isArray(stored.activity) ? stored.activity : []).map(([key, state]) => [
        key,
        {
          inProgress: false,
          newActivity: Boolean(state?.newActivity)
        }
      ])
    );
    this.hasLoaded = true;
    this.watchTranscripts();
  }

  storageRootsSignature() {
    return JSON.stringify(
      [
        ...this.storageRoots().map((root) => [root.id, path.resolve(root.path)]),
        ["copilot-cli", defaultCopilotCliRoot()]
      ]
    );
  }

  async persistCache() {
    if (!this.hasLoaded) {
      return;
    }
    try {
      await fs.promises.mkdir(path.dirname(this.cachePath), { recursive: true });
      const temporaryPath = `${this.cachePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.promises.writeFile(
        temporaryPath,
        JSON.stringify({
          version: VIEWER_CACHE_VERSION,
          roots: this.storageRootsSignature(),
          sessions: this.sessions,
          workspaces: this.workspaces,
          activity: [...this.activity.entries()].map(([key, state]) => [
            key,
            {
              inProgress: false,
              newActivity: Boolean(state.newActivity)
            }
          ])
        }),
        { encoding: "utf8", mode: 0o600 }
      );
      await fs.promises.rename(temporaryPath, this.cachePath);
    } catch (error) {
      this.output.appendLine(`Unable to persist viewer cache: ${error.message}`);
    }
  }

  async reconcileCache() {
    const knownFiles = new Set(this.sessions.map((session) => session.filePath));
    await Promise.all(this.sessions.map(async (session) => {
      try {
        const stats = await fs.promises.stat(session.filePath);
        if (
          stats.size !== session.fileSizeBytes
          || stats.mtimeMs !== session.modifiedAt
        ) {
          if (session.sourceKind === "copilot-cli") {
            await this.refresh();
            return;
          }
          await this.settleTranscript(session.key);
        }
      } catch (error) {
        if (error.code === "ENOENT") {
          await this.removeSession(session);
        } else {
          this.output.appendLine(`Unable to reconcile ${session.filePath}: ${error.message}`);
        }
      }
    }));

    const directories = new Set(
      this.sessions
        .filter((session) => session.sourceKind !== "copilot-cli")
        .map((session) => path.dirname(session.filePath))
    );
    for (const workspace of this.workspaces) {
      directories.add(path.join(workspace.storageDirectory, "chatSessions"));
    }
    for (const directory of directories) {
      try {
        const names = await fs.promises.readdir(directory);
        if (names.some((name) =>
          (name.endsWith(".jsonl") || name.endsWith(".json"))
          && !knownFiles.has(path.join(directory, name))
        )) {
          await this.refresh();
          return;
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          this.output.appendLine(`Unable to reconcile ${directory}: ${error.message}`);
        }
      }
    }

    try {
      const cliEntries = await fs.promises.readdir(defaultCopilotCliRoot(), {
        withFileTypes: true
      });
      if (cliEntries.some((entry) =>
        entry.isDirectory()
        && !knownFiles.has(path.join(defaultCopilotCliRoot(), entry.name, "events.jsonl"))
      )) {
        await this.refresh();
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.output.appendLine(
          `Unable to reconcile GitHub Copilot CLI history: ${error.message}`
        );
      }
    }
  }

  watchTranscripts() {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    this.transcriptOffsets = new Map(
      this.sessions
        .filter((session) => session.sourceKind !== "copilot-cli")
        .map((session) => [session.filePath, session.fileSizeBytes])
    );
    const directories = new Set(
      this.sessions
        .filter((session) => session.sourceKind !== "copilot-cli")
        .map((session) => path.dirname(session.filePath))
    );
    for (const workspace of this.workspaces) {
      directories.add(path.join(workspace.storageDirectory, "chatSessions"));
    }
    for (const directory of directories) {
      try {
        const watcher = fs.watch(directory, (_, fileName) => {
          if (fileName) {
            void this.handleTranscriptChange(directory, String(fileName)).catch((error) => {
              this.output.appendLine(`Unable to process chat activity: ${error.stack || error.message}`);
            });
          }
        });
        watcher.on("error", (error) => {
          this.output.appendLine(`Chat activity watcher failed for ${directory}: ${error.message}`);
        });
        this.watchers.push(watcher);
      } catch (error) {
        if (error.code !== "ENOENT") {
          this.output.appendLine(`Unable to watch ${directory}: ${error.message}`);
        }
      }
    }

    const cliDirectories = new Set([
      defaultCopilotCliRoot(),
      ...this.sessions
        .filter((session) => session.sourceKind === "copilot-cli")
        .map((session) => path.dirname(session.filePath))
    ]);
    for (const directory of cliDirectories) {
      try {
        const watcher = fs.watch(directory, (_, fileName) => {
          if (
            directory === defaultCopilotCliRoot()
            || fileName === "events.jsonl"
            || fileName === "workspace.yaml"
          ) {
            clearTimeout(this.newSessionTimer);
            this.newSessionTimer = setTimeout(() => {
              void this.refresh().catch((error) => this.showRefreshError(error));
            }, 1500);
          }
        });
        watcher.on("error", (error) => {
          this.output.appendLine(
            `GitHub Copilot CLI history watcher failed for ${directory}: ${error.message}`
          );
        });
        this.watchers.push(watcher);
      } catch (error) {
        if (error.code !== "ENOENT") {
          this.output.appendLine(
            `Unable to watch GitHub Copilot CLI history at ${directory}: ${error.message}`
          );
        }
      }
    }
  }

  async handleTranscriptChange(directory, fileName) {
    if (!fileName.endsWith(".jsonl") && !fileName.endsWith(".json")) {
      return;
    }
    const filePath = path.join(directory, fileName);
    const session = this.sessions.find((candidate) =>
      candidate.filePath === filePath
      || (
        path.basename(candidate.filePath) === fileName
        && path.dirname(candidate.filePath) === directory
      )
    );
    if (!session) {
      this.pendingNewFiles.add(filePath);
      clearTimeout(this.newSessionTimer);
      this.newSessionTimer = setTimeout(() => {
        void this.refresh().catch((error) => this.showRefreshError(error));
      }, 1500);
      return;
    }

    let stats;
    try {
      stats = await fs.promises.stat(session.filePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        await this.removeSession(session);
      } else {
        this.output.appendLine(`Unable to inspect changed chat ${session.filePath}: ${error.message}`);
      }
      return;
    }
    const previousOffset = this.transcriptOffsets.get(session.filePath) || 0;
    let relevant = stats.size <= previousOffset || session.filePath.endsWith(".json");
    let responseActivity = false;
    let showSpinner = false;
    if (!relevant) {
      const handle = await fs.promises.open(session.filePath, "r");
      try {
        const buffer = Buffer.alloc(stats.size - previousOffset);
        await handle.read(buffer, 0, buffer.length, previousOffset);
        const activity = classifyAppendedChatActivity(
          buffer.toString("utf8"),
          session.messageCount - 1
        );
        relevant = activity.relevant;
        responseActivity = activity.response;
        showSpinner = activity.relevant;
      } finally {
        await handle.close();
      }
    }
    this.transcriptOffsets.set(session.filePath, stats.size);
    if (!relevant) {
      return;
    }

    if (showSpinner) {
      const current = this.activity.get(session.key) || {};
      this.activity.set(session.key, {
        inProgress: true,
        newActivity: false,
        startedAt: current.startedAt || Date.now(),
        responseActivity: current.responseActivity || responseActivity
      });
      this.postActivity(session.key);
    }
    clearTimeout(this.settleTimers.get(session.key));
    this.settleTimers.set(session.key, setTimeout(() => {
      void this.settleTranscript(session.key);
    }, 1200));
  }

  async settleTranscript(key) {
    this.settleTimers.delete(key);
    const index = this.sessions.findIndex((session) => session.key === key);
    if (index === -1) {
      return;
    }
    try {
      const refreshed = await refreshSession(this.sessions[index]);
      if (!refreshed) {
        return;
      }
      const counts = sessionWordCounts(refreshed.session);
      refreshed.session.userWordCount = counts.user;
      refreshed.session.botWordCount = counts.bot;
      this.sessions[index] = refreshed.session;
      this.sessions.sort((left, right) => right.modifiedAt - left.modifiedAt);
      this.transcriptOffsets.set(refreshed.session.filePath, refreshed.session.fileSizeBytes);
      const inProgress = chatIsInProgress(refreshed.data);
      const current = this.activity.get(key) || {};
      this.activity.set(key, {
        inProgress,
        newActivity: !inProgress && Boolean(current.responseActivity),
        startedAt: inProgress ? current.startedAt : undefined,
        responseActivity: inProgress ? current.responseActivity : undefined
      });
      const currentProduct = currentProductId();
      const availableProducts = {
        stable: currentProduct === "stable" || Boolean(resolveInstalledProductCommand("stable")),
        insiders: currentProduct === "insiders" || Boolean(resolveInstalledProductCommand("insiders"))
      };
      this.view?.webview.postMessage({
        type: "session",
        session: webviewSession(
          refreshed.session,
          currentProduct,
          availableProducts,
          this.activity.get(key)
        )
      });
      this.postActivity(key);
      if (!inProgress) {
        void this.routeIndex.refresh();
      }
      await this.persistCache();
    } catch (error) {
      this.output.appendLine(`Unable to update changed chat: ${error.stack || error.message}`);
    }
  }

  postActivity(key) {
    this.view?.webview.postMessage({
      type: "activity",
      key,
      activity: this.activity.get(key) || {}
    });
  }

  async removeSession(session) {
    this.sessions = this.sessions.filter((candidate) => candidate.key !== session.key);
    this.activity.delete(session.key);
    this.transcriptOffsets.delete(session.filePath);
    this.view?.webview.postMessage({ type: "removeSession", key: session.key });
    await this.persistCache();
    void this.routeIndex.refresh();
  }

  dispose() {
    clearTimeout(this.newSessionTimer);
    for (const timer of this.settleTimers.values()) {
      clearTimeout(timer);
    }
    for (const watcher of this.watchers) {
      watcher.close();
    }
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

  showError(error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `Could not route the prompt: ${detail}`;
    this.output.appendLine(`${message}\n${error.stack || ""}`);
    this.postStatus({ kind: "error", message });
    vscode.window.showErrorMessage(message);
  }
}

function formatIndexStatus(status) {
  if (status.semanticEnabled) {
    if (status.refreshing && status.pendingTranscripts > 0) {
      return `Semantic index: ${status.semanticIndexedChats} chats ready · ${status.pendingTranscripts} transcript changes pending`;
    }
    if (status.semanticIndexedChats < status.indexedChats) {
      return `Semantic index: ${status.semanticIndexedChats}/${status.indexedChats} chats ready · lexical fallback active`;
    }
    return `Semantic index: ${status.semanticIndexedChats} chats ready`;
  }
  if (status.refreshing && status.pendingTranscripts > 0) {
    return `Local index: ${status.indexedChats} chats ready · ${status.pendingTranscripts} transcript changes pending`;
  }
  return `Local index: ${status.indexedChats} chats ready`;
}

function webviewSession(
  { searchableText, storageDirectory, filePath, ...session },
  currentProduct,
  availableProducts,
  activity = {}
) {
  const sourceProductAvailable = session.canContinue !== false && (
    session.sourceProduct === currentProduct
    || Boolean(availableProducts[session.sourceProduct])
  );
  return {
    ...session,
    ...activity,
    sourceProductAvailable,
    importLabel: `Import into ${productLabel(currentProduct)}`
  };
}

async function continueSession(context, session, protectActiveChat = false) {
  const target = workspaceUri(session);
  if (!target) {
    vscode.window.showWarningMessage("This chat is orphaned and has no original workspace metadata.");
    return;
  }
  if (!session.workspaceExists) {
    const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
    if (configuration.get("recoverMissingWorkspaces", true)) {
      await recoverMissingWorkspace(context, session, protectActiveChat);
    } else {
      vscode.window.showWarningMessage(
        `The original workspace for "${session.title}" no longer exists at ${session.workspacePath || target}.`
      );
    }
    return;
  }

  const currentProduct = currentProductId();
  if (session.sourceProduct !== currentProduct) {
    if (
      isKnownProduct(session.sourceProduct)
      && resolveInstalledProductCommand(session.sourceProduct)
    ) {
      await continueInOtherProduct(session, target);
    } else {
      await importSession(context, session);
    }
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
  await openWorkspace(session, protectActiveChat);
}

async function importSession(context, session) {
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

  const item = {
    id: session.id,
    sourceFile: session.filePath,
    workspaceUri: target,
    savedAt: Date.now()
  };
  if (await completeImport(context, item)) {
    return;
  }
  if (isCurrentWorkspace(target)) {
    vscode.window.showWarningMessage(
      "The current workspace's chat storage is not ready yet. Reload the window, then try Import again."
    );
    return;
  }

  await writePendingImports(context, [
    ...readPendingImports(context).filter((candidate) => isFreshHandoff(candidate)),
    item
  ]);
  vscode.window.showInformationMessage(
    `Opening "${session.workspaceName}" to finish importing the chat into ${productLabel(currentProductId())}.`
  );
  await openWorkspaceInCurrentProduct(target, false);
}

async function copySessionToWorkspace(context, session, workspaces) {
  const destination = await pickDestinationWorkspace(session, workspaces);
  if (!destination) {
    return;
  }

  const result = await importChatSession(session.filePath, destination.storageDirectory);
  const target = destination.uri;
  const status = result.copied
    ? `Copied "${session.title}" to "${destination.name}".`
    : `"${session.title}" already exists in "${destination.name}".`;

  if (isCurrentWorkspace(target)) {
    vscode.window.showInformationMessage(status);
    await openNativeChat(session.id);
    return;
  }

  await queuePendingSession(context, {
    id: session.id,
    workspaceUri: target,
    savedAt: Date.now()
  });
  vscode.window.showInformationMessage(`${status} Opening the destination workspace.`);
  await openWorkspaceInCurrentProduct(target, false);
}

async function suggestFocusedWorkspace(context, session) {
  const folders = Array.isArray(session.workspaceFolders)
    ? session.workspaceFolders
    : [];
  if (folders.length < 2) {
    vscode.window.showInformationMessage(
      `"${session.workspaceName}" already has one workspace root, so there is nothing to trim.`
    );
    return;
  }

  const data = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Analyzing workspace usage for "${session.title}"`,
    cancellable: false
  }, () => readSessionFile(session.filePath));
  const analysis = analyzeWorkspaceUsage(data, folders);
  const items = analysis.map((root) => ({
    label: root.folder.name,
    description: root.recommended ? "Keep" : "No observed use",
    detail: workspaceUsageDetail(root),
    picked: root.recommended,
    root
  }));
  const selected = await vscode.window.showQuickPick(items, {
    title: `Focus "${session.title}"`,
    placeHolder: "Checked folders will be included; press Escape to cancel",
    canPickMany: true,
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!selected) {
    return;
  }
  if (!selected.length) {
    vscode.window.showWarningMessage(
      "A focused workspace must contain at least one folder."
    );
    return;
  }

  const selectedRoots = new Set(selected.map((item) => item.root.folder.uri));
  const omittedRequired = analysis.filter((root) =>
    root.required && !selectedRoots.has(root.folder.uri)
  );
  if (omittedRequired.length) {
    vscode.window.showWarningMessage(
      `Keep the chat's working-directory folder: ${omittedRequired.map((root) => root.folder.name).join(", ")}.`
    );
    return;
  }
  if (selected.length === folders.length) {
    vscode.window.showInformationMessage(
      "Every workspace root is selected, so no focused workspace was created."
    );
    return;
  }

  const selectedFolders = folders.filter((folder) => selectedRoots.has(folder.uri));
  const target = await createFocusedWorkspace(context, session, selectedFolders);
  const item = {
    id: session.id,
    sourceFile: session.filePath,
    workspaceUri: target,
    moveSource: true,
    savedAt: Date.now()
  };
  if (await completeImport(context, item)) {
    return;
  }

  await writePendingImports(context, [
    ...readPendingImports(context).filter((candidate) => isFreshHandoff(candidate)),
    item
  ]);
  vscode.window.showInformationMessage(
    `Created a focused workspace with ${selectedFolders.map((folder) => folder.name).join(", ")}. Opening it to move the chat.`
  );
  await openWorkspaceInCurrentProduct(target, false);
}

async function recoverMissingWorkspace(context, session, protectActiveChat = false) {
  const data = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Recovering workspace for "${session.title}"`,
    cancellable: false
  }, () => readSessionFile(session.filePath));
  const candidatePaths = new Set([
    ...(session.workspaceFolders || [])
      .map((folder) => normalizeLocalPath(folder.location, process.platform)),
    ...recoveryLocationPaths(data)
  ].filter(Boolean));
  const existingDirectories = [];
  for (const candidate of candidatePaths) {
    try {
      const stats = await fs.promises.stat(candidate);
      existingDirectories.push(stats.isDirectory() ? candidate : path.dirname(candidate));
    } catch (error) {
      if (!isUnavailableRecoveryPathError(error)) {
        throw error;
      }
    }
  }
  const directories = [...new Set(existingDirectories.map((directory) => path.resolve(directory)))]
    .sort((left, right) => left.length - right.length)
    .filter((directory, index, all) =>
      !all.slice(0, index).some((parent) =>
        directory === parent || directory.startsWith(`${parent}${path.sep}`)
      )
    )
    .slice(0, 20);
  if (!directories.length) {
    vscode.window.showWarningMessage(
      `No folders referenced by "${session.title}" still exist. Use Copy to workspace to choose a replacement project.`
    );
    return;
  }

  const items = directories.map((directory) => ({
    label: path.basename(directory),
    description: directory,
    picked: true,
    folder: {
      name: path.basename(directory),
      location: directory,
      uri: pathToFileURL(directory).toString()
    }
  }));
  const selected = await vscode.window.showQuickPick(items, {
    title: `Recover workspace for "${session.title}"`,
    placeHolder: "Confirm the surviving folders to include",
    canPickMany: true,
    ignoreFocusOut: true,
    matchOnDescription: true
  });
  if (!selected) {
    return;
  }
  if (!selected.length) {
    vscode.window.showWarningMessage("A recovered workspace must contain at least one folder.");
    return;
  }

  const target = await createFocusedWorkspace(
    context,
    { ...session, workspacePath: undefined, workspaceName: `Recovered ${session.workspaceName}` },
    selected.map((item) => item.folder)
  );
  const item = {
    id: session.id,
    sourceFile: session.filePath,
    workspaceUri: target,
    moveSource: true,
    savedAt: Date.now()
  };
  if (await completeImport(context, item)) {
    return;
  }
  await writePendingImports(context, [
    ...readPendingImports(context).filter((candidate) => isFreshHandoff(candidate)),
    item
  ]);
  vscode.window.showInformationMessage(
    `Created a recovered workspace with ${selected.map((entry) => entry.label).join(", ")}. Opening it to move the chat.`
  );
  await openWorkspaceInCurrentProduct(target, protectActiveChat);
}

function workspaceUsageDetail(root) {
  const details = [];
  if (root.required) {
    details.push("Chat working directory");
  }
  if (root.turnCount) {
    details.push(`Observed in ${root.turnCount} ${root.turnCount === 1 ? "turn" : "turns"}`);
  }
  details.push(...root.categories.filter((category) => category !== "Working directory"));
  return details.length
    ? [...new Set(details)].join(" · ")
    : "No stored references, edits, attachments, or tool activity in this root";
}

async function createFocusedWorkspace(context, session, folders) {
  let sourceConfiguration = {};
  if (session.workspacePath) {
    sourceConfiguration = parseJsonWithComments(
      await fs.promises.readFile(session.workspacePath, "utf8")
    );
  }

  const configuration = {
    ...sourceConfiguration,
    folders: folders.map(workspaceConfigurationFolder)
  };
  const fingerprint = crypto.createHash("sha256")
    .update(session.id)
    .update(String(session.workspaceUri || session.workspacePath || ""))
    .update(folders.map((folder) => folder.uri).join("\0"))
    .digest("hex")
    .slice(0, 10);
  const fileName = [
    slugify(session.workspaceName),
    slugify(session.title),
    fingerprint
  ].filter(Boolean).join("-") + ".code-workspace";
  const directory = path.join(context.globalStorageUri.fsPath, "focusedWorkspaces");
  const workspacePath = path.join(directory, fileName);
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(
    workspacePath,
    `${JSON.stringify(configuration, null, 2)}\n`,
    "utf8"
  );
  return pathToFileURL(workspacePath).toString();
}

function workspaceConfigurationFolder(folder) {
  const result = folder.uri.startsWith("file:")
    ? { path: fileURLToPath(folder.uri) }
    : { uri: folder.uri };
  if (folder.name) {
    result.name = folder.name;
  }
  return result;
}

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .toLowerCase();
}

async function pickDestinationWorkspace(session, workspaces) {
  const currentProduct = currentProductId();
  const candidates = [];
  for (const workspace of workspaces) {
    if (
      workspace.sourceProduct !== currentProduct
      || !workspace.exists
      || !workspace.uri
      || (
        session.sourceProduct === currentProduct
        && sameStoredWorkspaceUri(session.workspaceUri, workspace.uri)
      )
      || candidates.some((candidate) =>
        sameStoredWorkspaceUri(candidate.workspace.uri, workspace.uri)
      )
    ) {
      continue;
    }

    const folders = workspace.folders
      .map((folder) => folder.name)
      .filter(Boolean)
      .join("  •  ");
    candidates.push({
      label: workspace.name,
      description: workspace.fsPath || workspace.uri,
      detail: folders
        ? `${workspace.sourceLabel}  •  Folders: ${folders}`
        : `${workspace.sourceLabel}  •  Workspace folders unavailable`,
      workspace
    });
  }

  if (!candidates.length) {
    vscode.window.showInformationMessage(
      `No other initialized ${productLabel(currentProduct)} workspaces were found. Open a destination workspace once, refresh the viewer, and try again.`
    );
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(candidates, {
    title: `Copy "${session.title}" to a workspace`,
    placeHolder: "Choose the workspace whose files the chat should use",
    matchOnDescription: true,
    matchOnDetail: true
  });
  return selected?.workspace;
}

async function completeImport(context, item) {
  const storageDirectory = await findWorkspaceStorageDirectory(
    currentWorkspaceStorageRoot(context),
    item.workspaceUri
  );
  if (!storageDirectory) {
    return false;
  }

  const result = item.moveSource
    ? await moveChatSession(item.sourceFile, storageDirectory)
    : await importChatSession(item.sourceFile, storageDirectory);
  if (isCurrentWorkspace(item.workspaceUri)) {
    await openNativeChat(item.id);
  } else {
    await queuePendingSession(context, {
      id: item.id,
      workspaceUri: item.workspaceUri,
      savedAt: Date.now()
    });
    await openWorkspaceInCurrentProduct(item.workspaceUri, false);
  }
  vscode.window.showInformationMessage(
    result.moved
      ? `Moved the chat into the optimized workspace.`
      : result.copied
        ? `Imported the chat into ${productLabel(currentProductId())}.`
      : `This chat already exists in ${productLabel(currentProductId())}.`
  );
  return true;
}

function currentWorkspaceStorageRoot(context) {
  return path.resolve(context.globalStorageUri.fsPath, "..", "..", "workspaceStorage");
}

async function openWorkspaceInCurrentProduct(target, forceNewWindow) {
  const configuredNewWindow = vscode.workspace
    .getConfiguration(CONFIGURATION_SECTION)
    .get("openWorkspaceInNewWindow", false);
  const openInNewWindow = forceNewWindow || configuredNewWindow;
  await vscode.commands.executeCommand(
    "vscode.openFolder",
    vscode.Uri.parse(target),
    openInNewWindow
      ? { forceNewWindow: true }
      : { forceReuseWindow: true }
  );
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
  if (
    isKnownProduct(session.sourceProduct)
    && session.sourceProduct !== currentProductId()
    && resolveInstalledProductCommand(session.sourceProduct)
  ) {
    await launchProduct(session.sourceProduct, target);
    return;
  }
  if (isCurrentWorkspace(target)) {
    vscode.window.showInformationMessage(
      `The workspace for "${session.title}" is already open in this window.`
    );
    return;
  }

  await openWorkspaceInCurrentProduct(target, forceNewWindow);
}

function isCurrentWorkspace(target) {
  const targetUri = vscode.Uri.parse(target);
  return isCurrentWorkspaceUri(
    targetUri,
    vscode.workspace.workspaceFile,
    vscode.workspace.workspaceFolders
  );
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

async function routePrompt(context, prompt, provider, routeIndex) {
  const trimmedPrompt = typeof prompt === "string" ? prompt.trim() : "";
  if (!trimmedPrompt) {
    provider.postStatus({ kind: "error", message: "Enter a prompt first." });
    return;
  }
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  if (
    configuration.get("semanticRouting.enabled", true)
    && !await semanticRoutingIsConfigured(context)
  ) {
    provider.postStatus({
      kind: "working",
      message: "Configure Azure semantic routing to send this prompt."
    });
    if (!await configureAzureEmbeddings(context, routeIndex)) {
      provider.postStatus({ kind: "", message: "Semantic routing setup canceled." });
      return;
    }
  }

  provider.postStatus({ kind: "working", message: "Ranking indexed chats..." });
  const sessions = await routeIndex.getSessions();
  if (!sessions.length) {
    throw new Error("no continuable local chat sessions were found");
  }

  const embeddingClient = await createEmbeddingClient(context);
  const semanticReady = embeddingClient
    && sessions.every((session) =>
      session.embeddingSignature === embeddingClient.signature
      && Array.isArray(session.embeddingVectors)
      && session.embeddingVectors.length > 0
    );
  const ranked = semanticReady
    ? rankSessionsByEmbedding(
      (await embeddingClient.embed([trimmedPrompt]))[0],
      sessions
    )
    : rankSessions(trimmedPrompt, sessions);
  const autoRoute = vscode.workspace
    .getConfiguration(CONFIGURATION_SECTION)
    .get("routePromptsAutomatically", true);
  const automaticSelection = chooseAutomatically(ranked, autoRoute);
  const selected = automaticSelection || await vscode.window.showQuickPick(
    routeQuickPickItems(ranked, semanticReady),
    {
      title: "Choose the destination chat",
      placeHolder: "Threads are ranked from the prompt and prior conversation",
      matchOnDescription: true,
      matchOnDetail: true
    }
  );
  if (!selected) {
    provider.postStatus({ kind: "", message: "No thread selected." });
    return;
  }

  provider.postStatus({
    kind: "working",
    message: automaticSelection
      ? `Best match: "${selected.session.title}". Opening automatically...`
      : `Opening "${selected.session.title}"...`
  });
  const opened = await openSelectedRoute(
    context,
    selected.session,
    trimmedPrompt,
    provider.shouldProtectActiveChat(selected.session)
  );
  if (!opened) {
    provider.postStatus({
      kind: "working",
      message: `Opening workspace for "${selected.session.title}"...`
    });
    return;
  }
  provider.postStatus({
    kind: "success",
    message: `Routed to "${selected.session.title}". Review the prompt and press Enter.`
  });
}

function routeQuickPickItems(ranked, semantic) {
  return ranked.slice(0, 20).map((result, index) => {
    const date = new Date(result.session.modifiedAt).toLocaleDateString();
    const reasons = semantic
      ? `Semantic similarity: ${Math.round(result.semanticScore * 100)}%`
      : result.matchedTerms.length
        ? `Matches: ${result.matchedTerms.join(", ")}`
        : "No direct term match; ranked by recency";
    return {
      label: `${index + 1}. ${result.session.title}`,
      description: result.session.workspaceName,
      detail: `${reasons} · ${result.session.messageCount} prompts · updated ${date}`,
      session: result.session
    };
  });
}

async function createEmbeddingClient(context) {
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  if (!configuration.get("semanticRouting.enabled", true)) {
    return undefined;
  }
  const endpoint = configuration.get("semanticRouting.azure.endpoint", "");
  const deployment = configuration.get(
    "semanticRouting.azure.deployment",
    "text-embedding-3-small"
  );
  const dimensions = configuration.get("semanticRouting.dimensions", 256);
  const apiKey = await context.secrets.get(AZURE_EMBEDDING_KEY);
  if (!endpoint.trim() || !apiKey) {
    return undefined;
  }
  return new AzureEmbeddingClient({
    endpoint,
    deployment,
    dimensions,
    apiKey
  });
}

async function semanticRoutingIsConfigured(context) {
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  return Boolean(
    configuration.get("semanticRouting.azure.endpoint", "").trim()
    && await context.secrets.get(AZURE_EMBEDDING_KEY)
  );
}

async function configureAzureEmbeddings(context, routeIndex) {
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  const endpoint = await vscode.window.showInputBox({
    title: "Configure Azure semantic routing",
    prompt: "Azure OpenAI resource endpoint",
    value: configuration.get("semanticRouting.azure.endpoint", ""),
    placeHolder: "https://your-resource.openai.azure.com",
    ignoreFocusOut: true
  });
  if (endpoint === undefined) {
    return false;
  }
  const apiKey = await vscode.window.showInputBox({
    title: "Configure Azure semantic routing",
    prompt: "Azure OpenAI API key (stored securely in VS Code SecretStorage)",
    password: true,
    ignoreFocusOut: true
  });
  if (apiKey === undefined) {
    return false;
  }
  if (!apiKey.trim()) {
    throw new Error("Azure OpenAI API key cannot be empty");
  }
  const client = new AzureEmbeddingClient({
    endpoint: endpoint.trim(),
    deployment: configuration.get(
      "semanticRouting.azure.deployment",
      "text-embedding-3-small"
    ),
    dimensions: configuration.get("semanticRouting.dimensions", 256),
    apiKey: apiKey.trim()
  });
  await client.embed(["Test semantic routing connection"]);

  await context.secrets.store(AZURE_EMBEDDING_KEY, apiKey.trim());
  await configuration.update(
    "semanticRouting.azure.endpoint",
    endpoint.trim(),
    vscode.ConfigurationTarget.Global
  );
  await configuration.update(
    "semanticRouting.enabled",
    true,
    vscode.ConfigurationTarget.Global
  );

  await routeIndex.clearEmbeddings();
  void routeIndex.refresh();
  vscode.window.showInformationMessage(
    "Azure semantic routing is connected. Full-discussion embeddings are building in the background."
  );
  return true;
}

async function rebuildSemanticIndex(context, routeIndex) {
  const client = await createEmbeddingClient(context);
  if (!client) {
    throw new Error("Enable and configure semantic routing first");
  }
  await client.embed(["Test semantic routing connection"]);
  await routeIndex.clearEmbeddings();
  void routeIndex.refresh();
  vscode.window.showInformationMessage(
    "Semantic routing index rebuild started in the background."
  );
}

async function disableSemanticRouting(context, routeIndex) {
  await context.secrets.delete(AZURE_EMBEDDING_KEY);
  await vscode.workspace.getConfiguration(CONFIGURATION_SECTION).update(
    "semanticRouting.enabled",
    false,
    vscode.ConfigurationTarget.Global
  );
  await routeIndex.clearEmbeddings();
  vscode.window.showInformationMessage(
    "Semantic routing and its stored API key have been removed. Local lexical routing remains available."
  );
}

async function openSelectedRoute(context, session, prompt, protectActiveChat = false) {
  const target = workspaceUri(session);
  if (!target) {
    throw new Error(`"${session.title}" has no workspace metadata`);
  }
  if (!isCurrentWorkspace(target)) {
    await context.globalState.update(PENDING_ROUTE_KEY, {
      sessionId: session.id,
      title: session.title,
      workspaceUri: target,
      prompt,
      savedAt: Date.now()
    });
    await openWorkspaceInCurrentProduct(target, protectActiveChat);
    return false;
  }

  await openAndPrefill(session.id, prompt);
  return true;
}

async function openAndPrefill(sessionId, prompt) {
  await openNativeChat(sessionId);
  await vscode.commands.executeCommand("workbench.action.chat.focusInput");
  await vscode.commands.executeCommand("editor.action.selectAll");
  await vscode.commands.executeCommand("type", { text: prompt });
}

async function resumePendingRoute(context) {
  const pending = context.globalState.get(PENDING_ROUTE_KEY);
  if (!pending || Date.now() - pending.savedAt > PENDING_ROUTE_MAX_AGE_MS) {
    if (pending) {
      await context.globalState.update(PENDING_ROUTE_KEY, undefined);
    }
    return;
  }
  if (!isCurrentWorkspace(pending.workspaceUri)) {
    return;
  }

  await context.globalState.update(PENDING_ROUTE_KEY, undefined);
  await vscode.commands.executeCommand(
    "workbench.view.extension.crossWorkspaceChatViewer"
  );
  await openAndPrefill(pending.sessionId, pending.prompt);
  vscode.window.showInformationMessage(
    `Routed to "${pending.title}". Review the prompt and press Enter.`
  );
}

async function resumePendingSession(context) {
  const stored = readPendingSessions(context);
  const pending = deduplicateHandoffs(
    stored.filter((item) => isFreshHandoff(item))
  );
  if (!pending.length) {
    if (stored.length) {
      await writePendingSessions(context, []);
    }
    return;
  }

  const matching = pending.filter((item) => isCurrentWorkspace(item.workspaceUri));
  const remaining = pending.filter((item) => !matching.includes(item));
  await writePendingSessions(context, remaining);
  if (matching.length) {
    await vscode.commands.executeCommand(
      "workbench.view.extension.crossWorkspaceChatViewer"
    );
  }
  for (const item of matching) {
    await openNativeChat(item.id);
  }
}

async function queuePendingSession(context, item) {
  const pending = deduplicateHandoffs([
    ...readPendingSessions(context).filter((candidate) => isFreshHandoff(candidate)),
    item
  ]);
  await writePendingSessions(context, pending);
}

function readPendingSessions(context) {
  return [PENDING_SESSION_KEY, LEGACY_PENDING_SESSION_KEY]
    .flatMap((key) => {
      const stored = context.globalState.get(key);
      return Array.isArray(stored) ? stored : stored ? [stored] : [];
    });
}

async function writePendingSessions(context, items) {
  const unique = deduplicateHandoffs(items);
  await context.globalState.update(PENDING_SESSION_KEY, unique.length ? unique : undefined);
  await context.globalState.update(LEGACY_PENDING_SESSION_KEY, undefined);
}

function readPendingImports(context) {
  const stored = context.globalState.get(PENDING_IMPORT_KEY);
  return Array.isArray(stored) ? stored : stored ? [stored] : [];
}

async function writePendingImports(context, items) {
  const unique = deduplicateHandoffs(items);
  await context.globalState.update(PENDING_IMPORT_KEY, unique.length ? unique : undefined);
}

async function resumePendingImports(context) {
  const pending = deduplicateHandoffs(
    readPendingImports(context).filter((item) => isFreshHandoff(item))
  );
  const matching = pending.filter((item) => isCurrentWorkspace(item.workspaceUri));
  const remaining = pending.filter((item) => !matching.includes(item));

  for (let index = 0; index < matching.length; index += 1) {
    const item = matching[index];
    try {
      if (!await completeImport(context, item)) {
        remaining.push(item);
        vscode.window.showWarningMessage(
          "The workspace opened, but its chat storage is not ready. Reload the window, then try Import again."
        );
      }
    } catch (error) {
      remaining.push(item);
      vscode.window.showErrorMessage(`Unable to import chat: ${error.message}`);
    } finally {
      await writePendingImports(context, [
        ...remaining,
        ...matching.slice(index + 1)
      ]);
    }
  }
}

async function resumeCrossProductSession() {
  const pending = await readCrossProductHandoffs();
  if (!pending.length) {
    return;
  }

  const fresh = deduplicateHandoffs(
    pending.filter((item) => isFreshHandoff(item))
  );
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
  const pending = deduplicateHandoffs([
    ...(await readCrossProductHandoffs()).filter((item) => isFreshHandoff(item)),
    handoff
  ]);
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
  const unique = deduplicateHandoffs(items);
  if (!unique.length) {
    await fs.promises.rm(CROSS_PRODUCT_HANDOFF, { force: true });
    return;
  }

  const temporaryPath = `${CROSS_PRODUCT_HANDOFF}.${process.pid}.${crypto.randomUUID()}`;
  await fs.promises.writeFile(
    temporaryPath,
    JSON.stringify(unique),
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
  const command = resolveProductCommand(product);
  const targetUri = vscode.Uri.parse(target);
  const targetArgument = targetUri.scheme === "file" ? targetUri.fsPath : target;
  try {
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
  } catch (error) {
    const label = product === "insiders" ? "VS Code Insiders" : "VS Code";
    throw new Error(
      `Unable to launch ${label} using "${command}". Confirm it is installed, then restart VS Code. ${error.message}`
    );
  }
}

function currentProductId() {
  return vscode.env.appName.toLowerCase().includes("insiders") ? "insiders" : "stable";
}

function isKnownProduct(product) {
  return product === "stable" || product === "insiders";
}

function productLabel(product) {
  return product === "insiders" ? "VS Code Insiders" : "VS Code";
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
    body { height: 100vh; margin: 0; display: flex; flex-direction: column; overflow: hidden; color: var(--vscode-foreground); font: var(--vscode-font-size) var(--vscode-font-family); }
    header { flex: none; z-index: 2; padding: 10px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-sideBar-border); }
    input { width: 100%; padding: 7px 9px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); outline: none; }
    input:focus { border-color: var(--vscode-focusBorder); }
    #summary { margin-top: 7px; color: var(--vscode-descriptionForeground); font-size: 0.9em; white-space: pre-line; }
    #filters { margin-top: 7px; display: flex; align-items: center; gap: 6px; font-size: 0.9em; color: var(--vscode-descriptionForeground); }
    #filters input { width: auto; padding: 0; }
    #filters label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
    #sessions { flex: 1; min-height: 0; padding: 6px; overflow-y: auto; }
    .back-button { display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px; color: inherit; background: transparent; border: 1px solid var(--vscode-panel-border); border-radius: 4px; cursor: pointer; }
    .back-button:hover { background: var(--vscode-list-hoverBackground); }
    .card-list article { margin: 5px 0; border: 1px solid var(--vscode-panel-border); border-radius: 4px; overflow: hidden; }
    .card { width: 100%; padding: 9px; border: 0; color: inherit; background: transparent; text-align: left; cursor: pointer; }
    .card:hover { background: var(--vscode-list-hoverBackground); }
    .title { font-weight: 600; line-height: 1.3; }
    .title-row { display: flex; align-items: center; gap: 7px; }
    .title-row .title { flex: 1; min-width: 0; }
    .activity-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--vscode-activityBarBadge-background); }
    .activity-spinner { width: 12px; height: 12px; flex: none; border: 2px solid var(--vscode-progressBar-background); border-right-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .meta { margin-top: 4px; color: var(--vscode-descriptionForeground); font-size: 0.88em; }
    .detail-view { padding: 4px 4px 24px; }
    .detail-title { font-weight: 600; font-size: 1.05em; line-height: 1.3; }
    .detail-meta { margin-top: 4px; margin-bottom: 6px; color: var(--vscode-descriptionForeground); font-size: 0.88em; }
    #detailHeader { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    #detailHeader[hidden] { display: none; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .actions button { padding: 5px 8px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; cursor: pointer; }
    .actions button:hover { background: var(--vscode-button-hoverBackground); }
    .actions button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .message { margin-top: 10px; }
    .role { margin-bottom: 4px; color: var(--vscode-descriptionForeground); font-size: 0.82em; font-weight: 600; text-transform: uppercase; }
    .text { padding: 8px; background: var(--vscode-textCodeBlock-background); white-space: pre-wrap; word-break: break-word; }
    .empty { padding: 24px 12px; color: var(--vscode-descriptionForeground); text-align: center; }
    #composer { flex: none; padding: 8px; border-top: 1px solid var(--vscode-sideBar-border); background: var(--vscode-sideBar-background); }
    #composer[hidden] { display: none; }
    #composer-box { display: flex; align-items: flex-end; gap: 6px; padding: 5px; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); }
    #composer-box:focus-within { border-color: var(--vscode-focusBorder); }
    #routePrompt { flex: 1; min-height: 38px; max-height: 120px; resize: vertical; padding: 5px; border: 0; outline: 0; color: var(--vscode-input-foreground); background: transparent; font: inherit; }
    #sendPrompt { flex: none; padding: 6px 10px; border: 0; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    #sendPrompt:hover { background: var(--vscode-button-hoverBackground); }
    #indexStatus, #routeStatus { margin-top: 5px; color: var(--vscode-descriptionForeground); font-size: 0.82em; line-height: 1.3; }
    #routeStatus:empty { display: none; }
    #routeStatus.error { color: var(--vscode-errorForeground); }
    #routeStatus.success { color: var(--vscode-testing-iconPassed); }
  </style>
</head>
<body>
  <header>
    <div id="listHeader">
      <input id="search" type="search" placeholder="Search every chat and workspace" aria-label="Search chats">
      <div id="summary">Scanning chat history...</div>
      <div id="filters">
        <label><input id="showEmpty" type="checkbox"> Show empty chats (0 prompts)</label>
      </div>
    </div>
    <div id="detailHeader" hidden>
      <button id="back" class="back-button">&larr; All chats</button>
      <div id="detailActions" class="actions"></div>
    </div>
  </header>
  <main id="sessions"></main>
  <section id="composer" aria-label="Route a prompt">
    <div id="composer-box">
      <textarea id="routePrompt" placeholder="Describe what you want to build..." aria-label="Prompt"></textarea>
      <button id="sendPrompt" type="button" title="Route prompt">Send</button>
    </div>
    <div id="indexStatus" role="status" aria-live="polite">Loading index status...</div>
    <div id="routeStatus" role="status" aria-live="polite"></div>
  </section>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const search = document.getElementById("search");
    const showEmpty = document.getElementById("showEmpty");
    const container = document.getElementById("sessions");
    const summary = document.getElementById("summary");
    const listHeader = document.getElementById("listHeader");
    const detailHeader = document.getElementById("detailHeader");
    const detailActions = document.getElementById("detailActions");
    const backButton = document.getElementById("back");
    const composer = document.getElementById("composer");
    const routePromptInput = document.getElementById("routePrompt");
    const sendPrompt = document.getElementById("sendPrompt");
    const indexStatus = document.getElementById("indexStatus");
    const routeStatus = document.getElementById("routeStatus");
    let sessions = [];
    let scanComplete = false;
    let statsReady = false;
    let renderScheduled = false;
    let pointerInsideList = false;
    let openSessionKey;
    let listScrollTop = 0;
    let displayChatPreview = false;

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

    function totalPrompts(list) {
      return list.reduce((sum, session) => sum + session.messageCount, 0);
    }

    function totalResponses(list) {
      return list.reduce((sum, session) => sum + (session.responseCount || 0), 0);
    }

    function totalUserWords(list) {
      return list.reduce((sum, session) => sum + (session.userWordCount || 0), 0);
    }

    function totalBotWords(list) {
      return list.reduce((sum, session) => sum + (session.botWordCount || 0), 0);
    }

    function totalBytes(list) {
      return list.reduce((sum, session) => sum + (session.fileSizeBytes || 0), 0);
    }

    function formatWords(words) {
      if (words < 1000) {
        return words + " words";
      }
      if (words < 1000000) {
        return (words / 1000).toFixed(1) + "k words";
      }
      return (words / 1000000).toFixed(2) + "M words";
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
      listScrollTop = container.scrollTop;
      const session = sessions.find(candidate => candidate.key === key);
      if (session) {
        session.inProgress = false;
        session.newActivity = false;
      }
      vscode.postMessage({ type: "selectSession", key });
      const mustPreview = session?.canContinue === false;
      openSessionKey = displayChatPreview || mustPreview ? key : undefined;
      render();
      if (displayChatPreview || mustPreview) {
        requestAnimationFrame(() => {
          const lastMessage = container.querySelector(".message:last-child");
          (lastMessage || container).scrollIntoView({ block: "end" });
        });
      }
    }

    function closeSession() {
      openSessionKey = undefined;
      render();
      container.scrollTop = listScrollTop;
    }

    function render() {
      const session = sessions.find(candidate => candidate.key === openSessionKey);
      listHeader.hidden = Boolean(session);
      detailHeader.hidden = !session;
      composer.hidden = Boolean(session);
      if (session) {
        renderDetail(session);
      } else {
        renderList();
      }
    }

    function scheduleListRender() {
      if (openSessionKey || renderScheduled) {
        return;
      }
      if (pointerInsideList && !scanComplete) {
        return;
      }
      renderScheduled = true;
      setTimeout(() => {
        requestAnimationFrame(() => {
          renderScheduled = false;
          if (!openSessionKey && (!pointerInsideList || scanComplete)) {
            render();
          }
        });
      }, 120);
    }

    function renderList() {
      const query = search.value.trim().toLowerCase();
      const emptyCount = sessions.filter(session => session.messageCount === 0).length;
      const base = showEmpty.checked ? sessions : sessions.filter(session => session.messageCount > 0);
      const visible = base.filter(session => !query || searchable(session).includes(query));
      const hiddenNote = !showEmpty.checked && emptyCount ? " (" + emptyCount + " empty chat" + (emptyCount === 1 ? "" : "s") + " hidden)" : "";
      const filtered = visible.length !== base.length;
      const shared = filtered
        ? visible.length + " of " + base.length + " chats · " + formatBytes(totalBytes(visible)) + " of " + formatBytes(totalBytes(base))
        : base.length + " chats · " + formatBytes(totalBytes(base));
      const prompts = filtered
        ? totalPrompts(visible) + " of " + totalPrompts(base)
        : totalPrompts(base);
      const responses = filtered
        ? totalResponses(visible) + " of " + totalResponses(base)
        : totalResponses(base);
      const userWords = statsReady
        ? " · " + (filtered
          ? formatWords(totalUserWords(visible)) + " of " + formatWords(totalUserWords(base))
          : formatWords(totalUserWords(base)))
        : "";
      const botWords = statsReady
        ? " · " + (filtered
          ? formatWords(totalBotWords(visible)) + " of " + formatWords(totalBotWords(base))
          : formatWords(totalBotWords(base)))
        : "";
      const progress = scanComplete ? (statsReady ? "" : " · calculating word count...") : " · scanning recent chats first...";
      summary.textContent = shared + progress + hiddenNote
        + "\\nYou: " + prompts + " prompts" + userWords
        + "\\nBot: " + responses + " responses" + botWords;
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
        const titleRow = document.createElement("div");
        titleRow.className = "title-row";
        titleRow.append(title);
        if (session.inProgress) {
          const spinner = document.createElement("span");
          spinner.className = "activity-spinner";
          spinner.title = "Response in progress";
          spinner.setAttribute("aria-label", "Response in progress");
          titleRow.append(spinner);
        } else if (session.newActivity) {
          const dot = document.createElement("span");
          dot.className = "activity-dot";
          dot.title = "New chat activity";
          dot.setAttribute("aria-label", "New chat activity");
          titleRow.append(dot);
        }
        const meta = document.createElement("div");
        meta.className = "meta";
        const workspaceStatus = session.workspaceExists ? session.workspaceName : session.workspaceName + " (missing)";
        meta.textContent = workspaceStatus + " · " + session.sourceLabel + " · " + session.messageCount + " prompts · " + formatRelativeTime(session.modifiedAt);
        meta.title = formatDate(session.modifiedAt);
        card.append(titleRow, meta);
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
      meta.textContent = workspaceStatus + " · " + session.sourceLabel + " · " + session.messageCount + " prompts · " + formatRelativeTime(session.modifiedAt);
      meta.title = formatDate(session.modifiedAt);

      detailActions.replaceChildren();
      if (session.canContinue === false) {
        if (session.workspaceExists && (session.workspaceUri || session.workspacePath)) {
          detailActions.append(action("Open workspace", "openWorkspace", session.key, true));
        }
      } else if (session.workspaceExists && session.sourceProductAvailable) {
        detailActions.append(action("Continue chat", "continue", session.key));
      } else if (session.workspaceExists) {
        detailActions.append(action(session.importLabel, "import", session.key));
      } else {
        detailActions.append(action("Recover workspace", "recoverWorkspace", session.key));
      }
      if (
        session.canContinue !== false
        && session.workspaceExists
        && (session.workspaceUri || session.workspacePath)
      ) {
        detailActions.append(action("Open workspace", "openWorkspace", session.key, true));
      }
      if (
        session.canContinue !== false
        && session.workspaceExists
        && Array.isArray(session.workspaceFolders)
        && session.workspaceFolders.length > 0
      ) {
        detailActions.append(action(
          "Optimize workspace",
          "optimizeWorkspace",
          session.key,
          true
        ));
      }
      if (session.canContinue !== false) {
        detailActions.append(action("Copy to workspace", "copyToWorkspace", session.key, true));
      }

      container.append(title, meta);
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
    showEmpty.addEventListener("change", render);
    container.addEventListener("mouseenter", () => {
      pointerInsideList = true;
    });
    container.addEventListener("mouseleave", () => {
      pointerInsideList = false;
      scheduleListRender();
    });
    function sendRoutePrompt() {
      routeStatus.className = "";
      routeStatus.textContent = "Finding the best chat...";
      vscode.postMessage({ type: "route", prompt: routePromptInput.value });
    }
    sendPrompt.addEventListener("click", sendRoutePrompt);
    routePromptInput.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendRoutePrompt();
      }
    });
    window.addEventListener("message", event => {
      if (event.data.type === "session") {
        const index = sessions.findIndex(session => session.key === event.data.session.key);
        if (index === -1) {
          sessions.push(event.data.session);
        } else {
          sessions[index] = event.data.session;
        }
        sessions.sort((left, right) => right.modifiedAt - left.modifiedAt);
        scheduleListRender();
      } else if (event.data.type === "snapshot") {
        sessions = event.data.sessions;
        sessions.sort((left, right) => right.modifiedAt - left.modifiedAt);
        scanComplete = true;
        statsReady = true;
        render();
      } else if (event.data.type === "removeSession") {
        sessions = sessions.filter(session => session.key !== event.data.key);
        if (openSessionKey === event.data.key) {
          openSessionKey = undefined;
        }
        render();
      } else if (event.data.type === "activity") {
        const session = sessions.find(candidate => candidate.key === event.data.key);
        if (session) {
          Object.assign(session, event.data.activity);
          scheduleListRender();
        }
      } else if (event.data.type === "loading") {
        sessions = [];
        scanComplete = false;
        statsReady = false;
        openSessionKey = undefined;
        listHeader.hidden = false;
        detailHeader.hidden = true;
        container.className = "card-list";
        summary.textContent = "Scanning chat history...";
        container.replaceChildren();
      } else if (event.data.type === "complete") {
        scanComplete = true;
        scheduleListRender();
      } else if (event.data.type === "stats") {
        for (const session of sessions) {
          const counts = event.data.wordCounts[session.key] || {};
          session.userWordCount = counts.user || 0;
          session.botWordCount = counts.bot || 0;
        }
        statsReady = true;
        scheduleListRender();
      } else if (event.data.type === "error") {
        listHeader.hidden = false;
        detailHeader.hidden = true;
        summary.textContent = "Unable to scan chats: " + event.data.message;
      } else if (event.data.type === "indexStatus") {
        indexStatus.textContent = event.data.message;
      } else if (event.data.type === "routeStatus") {
        routeStatus.className = event.data.kind || "";
        routeStatus.textContent = event.data.message;
      } else if (event.data.type === "preferences") {
        displayChatPreview = event.data.displayChatPreview;
        if (!displayChatPreview && openSessionKey) {
          closeSession();
        }
      }
    });
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}

async function migrateLegacyConfiguration() {
  const settings = ["additionalStorageRoots", "openWorkspaceInNewWindow"];
  const scopes = [
    { target: vscode.ConfigurationTarget.Global, field: "globalValue" },
    { target: vscode.ConfigurationTarget.Workspace, field: "workspaceValue" }
  ];
  await migrateConfigurationAtResource(undefined, settings, scopes);

  for (const folder of vscode.workspace.workspaceFolders || []) {
    await migrateConfigurationAtResource(folder.uri, settings, [{
      target: vscode.ConfigurationTarget.WorkspaceFolder,
      field: "workspaceFolderValue"
    }]);
  }
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  for (const setting of [
    "semanticRouting.azure.authentication",
    "semanticRouting.azure.subscription"
  ]) {
    await configuration.update(setting, undefined, vscode.ConfigurationTarget.Global);
  }

  await migrateRouterConfigurationAtResource(undefined, scopes);
  for (const folder of vscode.workspace.workspaceFolders || []) {
    await migrateRouterConfigurationAtResource(folder.uri, [{
      target: vscode.ConfigurationTarget.WorkspaceFolder,
      field: "workspaceFolderValue"
    }]);
  }
}

async function migrateConfigurationAtResource(resource, settings, scopes) {
  const current = vscode.workspace.getConfiguration(CONFIGURATION_SECTION, resource);
  const legacy = vscode.workspace.getConfiguration(LEGACY_CONFIGURATION_SECTION, resource);
  for (const setting of settings) {
    const currentValues = current.inspect(setting);
    const legacyValues = legacy.inspect(setting);
    for (const scope of scopes) {
      const legacyValue = legacyValues?.[scope.field];
      if (legacyValue === undefined) {
        continue;
      }
      if (currentValues?.[scope.field] === undefined) {
        await current.update(setting, legacyValue, scope.target);
      }
      await legacy.update(setting, undefined, scope.target);
    }
  }
}

async function migrateRouterConfigurationAtResource(resource, scopes) {
  const current = vscode.workspace.getConfiguration(CONFIGURATION_SECTION, resource);
  const legacy = vscode.workspace.getConfiguration("chatThreadRouter", resource);
  const currentValues = current.inspect("routePromptsAutomatically");
  const legacyValues = legacy.inspect("autoRoute");
  for (const scope of scopes) {
    const legacyValue = legacyValues?.[scope.field];
    if (legacyValue === undefined) {
      continue;
    }
    if (currentValues?.[scope.field] === undefined) {
      await current.update("routePromptsAutomatically", legacyValue, scope.target);
    }
    await legacy.update("autoRoute", undefined, scope.target);
  }
}

async function activate(context) {
  const output = vscode.window.createOutputChannel("Cross-Workspace Chat Viewer");
  try {
    await migrateLegacyConfiguration();
  } catch (error) {
    output.appendLine(`Unable to migrate legacy settings: ${error.stack || error.message}`);
    vscode.window.showWarningMessage(
      `Cross-Workspace Chat Viewer could not migrate its legacy settings: ${error.message}`
    );
  }

  const routeIndex = new RouteIndex(
    path.join(context.globalStorageUri.fsPath, "prompt-route-index.json"),
    () => {
      const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
      return defaultStorageRoots(
        context.globalStorageUri.fsPath,
        configuration.get("additionalStorageRoots", []),
        currentProductId()
      ).filter((root) =>
        root.id === currentProductId() || root.id.startsWith("custom-")
      );
    },
    {
      log: (message) => output.appendLine(message),
      embeddingProvider: () => createEmbeddingClient(context)
    }
  );
  await routeIndex.start();
  const routeIndexTimer = setInterval(() => {
    void routeIndex.refresh().catch((error) => {
      output.appendLine(`Unable to refresh prompt-routing index: ${error.stack || error.message}`);
    });
  }, 30_000);
  routeIndexTimer.unref?.();

  const provider = new ChatViewerProvider(context, output, routeIndex);
  context.subscriptions.push(
    output,
    provider,
    { dispose: () => clearInterval(routeIndexTimer) },
    vscode.window.registerWebviewViewProvider(
      "crossWorkspaceChatViewer.sessions",
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand("crossWorkspaceChatViewer.refresh", () =>
      provider.refresh().catch((error) => provider.showRefreshError(error))
    ),
    vscode.commands.registerCommand("crossWorkspaceChatViewer.routePrompt", async () => {
      const prompt = await vscode.window.showInputBox({
        title: "Route a prompt to an existing Copilot chat",
        prompt: "The prompt is pre-filled in the selected thread, not submitted.",
        ignoreFocusOut: true
      });
      if (prompt !== undefined) {
        try {
          await routePrompt(context, prompt, provider, routeIndex);
        } catch (error) {
          provider.showError(error);
        }
      }
    }),
    vscode.commands.registerCommand(
      "crossWorkspaceChatViewer.configureAzureEmbeddings",
      () => configureAzureEmbeddings(context, routeIndex).catch((error) => {
        output.appendLine(`Unable to configure Azure embeddings: ${error.stack || error.message}`);
        vscode.window.showErrorMessage(`Unable to configure Azure embeddings: ${error.message}`);
      })
    ),
    vscode.commands.registerCommand(
      "crossWorkspaceChatViewer.rebuildSemanticIndex",
      () => rebuildSemanticIndex(context, routeIndex).catch((error) => {
        output.appendLine(`Unable to rebuild semantic index: ${error.stack || error.message}`);
        vscode.window.showErrorMessage(`Unable to rebuild semantic index: ${error.message}`);
      })
    ),
    vscode.commands.registerCommand(
      "crossWorkspaceChatViewer.disableSemanticRouting",
      () => disableSemanticRouting(context, routeIndex).catch((error) => {
        output.appendLine(`Unable to disable semantic routing: ${error.stack || error.message}`);
        vscode.window.showErrorMessage(`Unable to disable semantic routing: ${error.message}`);
      })
    ),
    vscode.commands.registerCommand("crossWorkspaceChatViewer.open", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.crossWorkspaceChatViewer");
    })
  );
  Promise.all([
    resumePendingSession(context),
    resumeCrossProductSession(),
    resumePendingImports(context),
    resumePendingRoute(context)
  ]).catch((error) => {
    output.appendLine(`Unable to resume chat: ${error.stack || error.message}`);
    vscode.window.showErrorMessage(`Unable to resume chat: ${error.message}`);
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
