"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const manifest = require("../package.json");

const extensionPath = path.join(__dirname, "..", "extension.js");
const extensionSource = fs.readFileSync(extensionPath, "utf8");
const extensionRequire = createRequire(extensionPath);

async function activateViewer(pending = {}, options = {}) {
  const commands = new Map();
  const executed = [];
  const errors = [];
  const information = [];
  const copied = [];
  const opened = [];
  let onConfigurationChange;
  const disposable = { dispose() {} };
  const configuration = {
    inspect: () => undefined,
    get: (key, fallback) => options.configuration?.[key] ?? fallback
  };
  const context = {
    subscriptions: [],
    globalStorageUri: { fsPath: options.globalStoragePath || "/unused/viewer-storage" },
    globalState: {
      get: (key) => pending[key],
      update: async (key, value) => { pending[key] = value; }
    }
  };
  let provider;
  const vscode = {
    env: {
      appName: "VS Code",
      clipboard: { writeText: async (text) => { copied.push(text); } }
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    Uri: {
      file: (value) => ({ fsPath: value, scheme: "file" }),
      parse: (value) => ({
        scheme: new URL(value).protocol.slice(0, -1),
        fsPath: new URL(value).pathname
      })
    },
    workspace: {
      workspaceFolders: [{ uri: { scheme: "file", fsPath: "/project" } }],
      getConfiguration: () => configuration,
      onDidChangeConfiguration: (callback) => {
        onConfigurationChange = callback;
        return disposable;
      }
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, clear() {}, dispose() {} }),
      registerWebviewViewProvider: (_, value) => {
        provider = value;
        return disposable;
      },
      showErrorMessage: (message) => errors.push(message),
      showWarningMessage: (message) => errors.push(message),
      showInformationMessage: (message) => information.push(message),
      showTextDocument: async (...args) => { opened.push(args); }
    },
    commands: {
      registerCommand: (name, callback) => {
        commands.set(name, callback);
        return disposable;
      },
      getCommands: async () => options.availableCommands || [
        "workbench.action.chat.openSessionInEditorGroup",
        "workbench.action.chat.newChat",
        "workbench.action.chat.newLocalChat",
        "workbench.action.chat.open"
      ],
      executeCommand: async (...args) => { executed.push(args); }
    }
  };
  const sandbox = {
    module: { exports: {} },
    process,
    Buffer,
    setImmediate,
    setTimeout,
    clearTimeout,
    require: (name) => {
      if (name === "vscode") return vscode;
      if (name === "node:fs") {
        return {
          ...fs,
          promises: {
            ...fs.promises,
            readFile: async (filePath, ...args) => {
              if (filePath === path.join(os.tmpdir(),
                `universal-chat-viewer-${typeof process.getuid === "function" ? process.getuid() : "user"}.json`
              )) {
                throw Object.assign(new Error("No handoff file"), { code: "ENOENT" });
              }
              return fs.promises.readFile(filePath, ...args);
            }
          }
        };
      }
      return extensionRequire(name);
    }
  };
  vm.runInNewContext(extensionSource, sandbox, { filename: extensionPath });
  await sandbox.module.exports.activate(context);
  await new Promise((resolve) => setImmediate(resolve));
  return { provider, commands, executed, errors, context, information, copied, opened, onConfigurationChange };
}

test("contributes only viewer commands and settings, not prompt routing", () => {
  assert.deepEqual(manifest.contributes.commands.map((command) => command.command), [
    "crossWorkspaceChatViewer.open",
    "crossWorkspaceChatViewer.refresh"
  ]);
  assert.equal(
    Object.keys(manifest.contributes.configuration.properties)
      .some((name) => /rout|semantic|embedding/i.test(name)),
    false
  );
  assert.equal(manifest.activationEvents.some((name) => /rout|semantic|embedding/i.test(name)), false);
});

test("activation ignores old pending prompts and starts only the viewer", async () => {
  const pendingRoute = {
    sessionId: "old-route",
    workspaceUri: "file:///project",
    prompt: "Do not insert this draft",
    savedAt: Date.now()
  };
  const { commands, executed, errors } = await activateViewer({
    "crossWorkspaceChatViewer.pendingRoute": pendingRoute
  });
  assert.deepEqual([...commands.keys()].sort(),
    manifest.contributes.commands.map((command) => command.command).sort());
  assert.deepEqual(executed, []);
  assert.deepEqual(errors, []);
});

test("existing native chats still continue from selection and across reload", async () => {
  const { provider, executed, errors } = await activateViewer({
    "crossWorkspaceChatViewer.pendingSession": [{
      id: "pending-chat",
      workspaceUri: "file:///project",
      savedAt: Date.now()
    }]
  });
  assert.deepEqual(executed.map(([command]) => command), [
    "workbench.view.extension.crossWorkspaceChatViewer",
    "workbench.action.chat.openSessionInEditorGroup"
  ]);
  const pendingResource = executed[1][1].resource;
  assert.equal(pendingResource.fsPath, `/${Buffer.from("pending-chat").toString("base64url")}`);

  executed.length = 0;
  provider.sessions = [{
    key: "selected",
    id: "selected-chat",
    workspaceUri: "file:///project",
    workspaceExists: true,
    sourceProduct: "stable"
  }];
  await provider.handleMessage({ type: "selectSession", key: "selected" });
  assert.deepEqual(executed.map(([command]) => command), [
    "workbench.action.chat.openSessionInEditorGroup"
  ]);
  assert.equal(executed[0][1].resource.fsPath,
    `/${Buffer.from("selected-chat").toString("base64url")}`);
  assert.deepEqual(errors, []);
});

test("webview retains search and previews with no prompt composer", async () => {
  const { provider } = await activateViewer();
  const webview = {
    cspSource: "vscode-webview:",
    onDidReceiveMessage() {}
  };
  provider.resolveWebviewView({ webview });
  assert.doesNotMatch(webview.html, /composer|textarea|sendPrompt|routePrompt|indexStatus/);

  function element() {
    return {
      value: "",
      checked: false,
      scrollTop: 0,
      children: [],
      listeners: {},
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      querySelector() { return undefined; },
      scrollIntoView() {}
    };
  }
  const elements = new Map(
    ["search", "showEmpty", "sessions", "summary", "listHeader",
      "detailHeader", "detailActions", "back"].map((id) => [id, element()])
  );
  const messages = [];
  let onMessage;
  const script = webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message) }),
    document: {
      getElementById: (id) => {
        assert.ok(elements.has(id), `Unexpected UI element: ${id}`);
        return elements.get(id);
      },
      createElement: element,
      addEventListener() {}
    },
    window: { addEventListener: (_, callback) => { onMessage = callback; } },
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback) => callback()
  });
  assert.equal(messages[0].type, "ready");
  onMessage({ data: {
    type: "snapshot",
    sessions: [{
      key: "cli",
      title: "CLI transcript",
      sourceLabel: "GitHub Copilot CLI",
      workspaceName: "Project",
      canContinue: false,
      messageCount: 1,
      modifiedAt: Date.now(),
      messages: [{ prompt: "Search this prompt", response: "Read this response" }]
    }]
  } });
  const search = elements.get("search");
  const container = elements.get("sessions");
  search.value = "missing text";
  search.listeners.input();
  assert.equal(container.children[0].textContent, "No chats match this search.");
  search.value = "read this response";
  search.listeners.input();
  container.children[0].children[0].listeners.click();
  assert.equal(messages.at(-1).type, "selectSession");
  assert.equal(elements.get("detailHeader").hidden, false);
  assert.equal(container.className, "detail-view");
  assert.equal(container.children.at(-1).children[1].textContent, "Read this response");
  const actions = elements.get("detailActions").children;
  for (const label of ["Continue as new chat", "Copy transcript path", "Raw transcript"]) {
    assert.ok(actions.some((button) => button.textContent === label));
  }
  actions.find((button) => button.textContent === "Continue as new chat").listeners.click();
  assert.equal(messages.at(-1).type, "continueAsNew");
  actions.find((button) => button.textContent === "Copy transcript path").listeners.click();
  assert.equal(messages.at(-1).type, "copyTranscriptPath");
  elements.get("back").listeners.click();
  assert.equal(container.className, "card-list");

  onMessage({ data: { type: "snapshot", sessions: [{
    key: "native",
    title: "Native chat",
    sourceLabel: "VS Code",
    workspaceExists: true,
    sourceProductAvailable: true,
    messageCount: 1,
    modifiedAt: Date.now(),
    messages: [{ prompt: "Search this prompt", response: "Read this response" }]
  }] } });
  container.children[0].children[1].children[0].listeners.click();
  assert.equal(messages.at(-1).type, "previewSession");
  assert.equal(elements.get("detailHeader").hidden, false);
  assert.ok(elements.get("detailActions").children.some((button) => button.textContent === "Continue chat"));
});

test("previewing a native chat does not reopen it, and transcript actions use the original path", async () => {
  const { provider, executed, copied, opened, information } = await activateViewer();
  provider.sessions = [{
    key: "native",
    id: "native",
    filePath: "/chat storage/original.jsonl",
    workspaceUri: "file:///project",
    workspaceExists: true,
    sourceProduct: "stable"
  }];
  await provider.handleMessage({ type: "previewSession", key: "native" });
  assert.deepEqual(executed, []);
  await provider.handleMessage({ type: "copyTranscriptPath", key: "native" });
  assert.deepEqual(copied, ["/chat storage/original.jsonl"]);
  assert.equal(information.length, 1);
  await provider.handleMessage({ type: "openRaw", key: "native" });
  assert.equal(opened[0][0].fsPath, "/chat storage/original.jsonl");
});

test("continues either supported storage format in a new unsent chat without switching workspace", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-new-chat-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nativePath = path.join(root, "native.json");
  fs.writeFileSync(nativePath, JSON.stringify({
    requests: [{ message: { text: "Original prompt" }, response: [{ value: "Original reply" }] }]
  }));
  const eventDirectory = path.join(root, "event-session");
  fs.mkdirSync(eventDirectory);
  const eventPath = path.join(eventDirectory, "events.jsonl");
  fs.writeFileSync(eventPath, JSON.stringify({
    type: "user.message", data: { content: "Event prompt" }
  }));
  const { provider, executed, errors } = await activateViewer({}, { globalStoragePath: path.join(root, "storage") });
  provider.sessions = [
    { key: "native", filePath: nativePath, sourceLabel: "VS Code", workspaceExists: false },
    { key: "events", filePath: eventPath, sourceKind: "copilot-cli", canContinue: false }
  ];
  await provider.handleMessage({ type: "selectSession", key: "events" });
  assert.deepEqual(executed, []);
  for (const session of provider.sessions) {
    executed.length = 0;
    await provider.handleMessage({ type: "continueAsNew", key: session.key });
    assert.deepEqual(executed.map(([command]) => command), [
      "workbench.action.chat.newLocalChat",
      "workbench.action.chat.open"
    ]);
    const options = executed[1][1];
    assert.equal(options.isPartialQuery, true);
    assert.equal(options.attachFiles.length, 1);
    assert.match(fs.readFileSync(options.attachFiles[0].fsPath, "utf8"),
      session.key === "native" ? /Original reply/ : /Event prompt/);
  }
  assert.deepEqual(errors, []);
});

test("falls back to the older new-chat command and fails explicitly if attachment commands are unavailable", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-chat-compat-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "native.json");
  fs.writeFileSync(filePath, JSON.stringify({ requests: [{ message: { text: "Prompt" } }] }));
  const session = { key: "native", filePath };
  const older = await activateViewer({}, {
    globalStoragePath: path.join(root, "storage"),
    availableCommands: ["workbench.action.chat.newChat", "workbench.action.chat.open"]
  });
  older.provider.sessions = [session];
  await older.provider.handleMessage({ type: "continueAsNew", key: "native" });
  assert.equal(older.executed[0][0], "workbench.action.chat.newChat");

  const unsupported = await activateViewer({}, { availableCommands: [] });
  unsupported.provider.sessions = [session];
  await assert.rejects(
    unsupported.provider.handleMessage({ type: "continueAsNew", key: "native" }),
    /Copy transcript path/
  );
  assert.deepEqual(unsupported.executed, []);
});

test("scans configured roots, deduplicates paths, and includes them in cache identity", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "viewer-storage-roots-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const copilotRoot = path.join(root, "copilot");
  const sessionDirectory = path.join(copilotRoot, "session");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.writeFileSync(path.join(sessionDirectory, "events.jsonl"),
    JSON.stringify({ type: "user.message", data: { content: "Custom root chat" } }));
  const vscodeRoot = path.join(root, "vscode");
  const storageDirectory = path.join(vscodeRoot, "workspace");
  fs.mkdirSync(path.join(storageDirectory, "chatSessions"), { recursive: true });
  fs.writeFileSync(path.join(storageDirectory, "workspace.json"),
    JSON.stringify({ folder: pathToFileURL(root).toString() }));
  fs.writeFileSync(path.join(storageDirectory, "chatSessions", "native.json"),
    JSON.stringify({ requests: [{ message: { text: "Native root chat" } }] }));
  const configuration = {
    storageRoots: [vscodeRoot],
    copilotSessionRoots: [copilotRoot, path.join(copilotRoot, ".")],
    additionalStorageRoots: []
  };
  const { provider, onConfigurationChange } = await activateViewer({}, {
    configuration,
    globalStoragePath: path.join(root, "storage")
  });
  t.after(() => provider.dispose());
  assert.deepEqual(Array.from(provider.copilotSessionRoots()), [copilotRoot]);
  await provider.scan();
  assert.equal(provider.sessions.length, 2);
  assert.ok(provider.sessions.some((session) => session.messages[0].prompt === "Custom root chat"));
  assert.ok(provider.sessions.some((session) => session.messages[0].prompt === "Native root chat"));
  assert.equal(provider.watchers.length, 3);
  const signature = provider.storageRootsSignature();
  configuration.copilotSessionRoots = [];
  assert.notEqual(provider.storageRootsSignature(), signature);
  configuration.storageRoots = [];
  await provider.scan();
  assert.equal(provider.sessions.length, 0);
  assert.equal(provider.watchers.length, 0);
  const activeScan = Promise.resolve();
  provider.refreshPromise = activeScan;
  let refreshed = false;
  provider.refresh = async () => { refreshed = true; };
  onConfigurationChange({
    affectsConfiguration: (key) => key === "crossWorkspaceChatViewer.copilotSessionRoots"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshed, true);
});

for (const version of [3, 4]) {
  test(`reparses unchanged Copilot histories when upgrading cache version ${version}`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-cache-upgrade-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const copilotRoot = path.join(root, "copilot");
    const sessionDirectory = path.join(copilotRoot, "session");
    fs.mkdirSync(sessionDirectory, { recursive: true });
    fs.writeFileSync(path.join(sessionDirectory, "workspace.yaml"), "name: Original prompt\n");
    const eventsPath = path.join(sessionDirectory, "events.jsonl");
    fs.writeFileSync(eventsPath, [
      { type: "user.message", data: { content: "Original prompt" } },
      {
        type: "assistant.message",
        data: {
          content: "Updated the title.",
          toolRequests: [{ name: "rename_chat", arguments: { title: "Renamed conversation" } }]
        }
      }
    ].map((event) => JSON.stringify(event)).join("\n"));
    const stats = fs.statSync(eventsPath);
    const options = {
      globalStoragePath: path.join(root, "storage"),
      configuration: { storageRoots: [], copilotSessionRoots: [copilotRoot] }
    };
    const initial = await activateViewer({}, options);
    t.after(() => initial.provider.dispose());
    await initial.provider.scan();
    initial.provider.dispose();
    const cachePath = initial.provider.cachePath;
    const stored = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const currentVersion = stored.version;
    assert.ok(currentVersion > version);
    stored.version = version;
    stored.sessions[0].title = "Original prompt";
    stored.sessions[0].searchableText = "original prompt";
    fs.writeFileSync(cachePath, JSON.stringify(stored));

    const upgraded = await activateViewer({}, options);
    t.after(() => upgraded.provider.dispose());
    await upgraded.provider.loadCache();
    assert.equal(upgraded.provider.hasLoaded, false);
    await upgraded.provider.handleMessage({ type: "ready" });

    assert.equal(upgraded.provider.sessions.length, 1);
    assert.equal(upgraded.provider.sessions[0].title, "Renamed conversation");
    assert.match(upgraded.provider.sessions[0].searchableText, /renamed conversation/);
    const persisted = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    assert.equal(persisted.version, currentVersion);
    assert.equal(persisted.sessions[0].title, "Renamed conversation");
    assert.equal(fs.statSync(eventsPath).size, stats.size);
    assert.equal(fs.statSync(eventsPath).mtimeMs, stats.mtimeMs);
    upgraded.provider.dispose();

    const reloaded = await activateViewer({}, options);
    t.after(() => reloaded.provider.dispose());
    await reloaded.provider.loadCache();
    assert.equal(reloaded.provider.hasLoaded, true);
    assert.equal(reloaded.provider.sessions[0].title, "Renamed conversation");
  });
}
