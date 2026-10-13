"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const manifest = require("../package.json");

const extensionPath = path.join(__dirname, "..", "extension.js");
const extensionSource = fs.readFileSync(extensionPath, "utf8");
const extensionRequire = createRequire(extensionPath);

async function activateViewer(pending = {}) {
  const commands = new Map();
  const executed = [];
  const errors = [];
  const disposable = { dispose() {} };
  const configuration = {
    inspect: () => undefined,
    get: (_, fallback) => fallback
  };
  const context = {
    subscriptions: [],
    globalStorageUri: { fsPath: "/unused/viewer-storage" },
    globalState: {
      get: (key) => pending[key],
      update: async (key, value) => { pending[key] = value; }
    }
  };
  let provider;
  const vscode = {
    env: { appName: "VS Code" },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    Uri: {
      parse: (value) => ({
        scheme: new URL(value).protocol.slice(0, -1),
        fsPath: new URL(value).pathname
      })
    },
    workspace: {
      workspaceFolders: [{ uri: { scheme: "file", fsPath: "/project" } }],
      getConfiguration: () => configuration,
      onDidChangeConfiguration: () => disposable
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      registerWebviewViewProvider: (_, value) => {
        provider = value;
        return disposable;
      },
      showErrorMessage: (message) => errors.push(message),
      showWarningMessage: (message) => errors.push(message)
    },
    commands: {
      registerCommand: (name, callback) => {
        commands.set(name, callback);
        return disposable;
      },
      getCommands: async () => ["workbench.action.chat.openSessionInEditorGroup"],
      executeCommand: async (...args) => { executed.push(args); }
    }
  };
  const sandbox = {
    module: { exports: {} },
    process,
    Buffer,
    require: (name) => {
      if (name === "vscode") return vscode;
      if (name === "node:fs") {
        return {
          promises: {
            readFile: async () => {
              throw Object.assign(new Error("No handoff file"), { code: "ENOENT" });
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
  return { provider, commands, executed, errors, context };
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
  elements.get("back").listeners.click();
  assert.equal(container.className, "card-list");
});
