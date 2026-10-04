"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  defaultStorageRoots,
  parseJsonLines,
  scanStorageRoots,
  sessionWordCounts
} = require("../src/chatStorage");

test("reconstructs JSONL set and append records", () => {
  const parsed = parseJsonLines([
    JSON.stringify({ kind: 0, v: { requests: [], inputState: {} } }),
    JSON.stringify({ kind: 2, k: ["requests"], v: [{ message: { text: "Hello" }, response: [] }] }),
    JSON.stringify({ kind: 2, k: ["requests", 0, "response"], v: [{ value: "Hi" }] }),
    JSON.stringify({ kind: 1, k: ["customTitle"], v: "Greeting" })
  ].join("\n"));

  assert.equal(parsed.customTitle, "Greeting");
  assert.equal(parsed.requests[0].message.text, "Hello");
  assert.equal(parsed.requests[0].response[0].value, "Hi");
});

test("scans workspace chat sessions and derives searchable metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cross-workspace-chat-viewer-"));
  const storage = path.join(root, "hash");
  const chats = path.join(storage, "chatSessions");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(
    path.join(storage, "workspace.json"),
    JSON.stringify({ folder: pathToFileURL("/tmp/sample-workspace").toString() })
  );
  fs.writeFileSync(
    path.join(chats, "session.jsonl"),
    [
      JSON.stringify({
        kind: 0,
        v: {
          sessionId: "session-id",
          creationDate: 100,
          requests: []
        }
      }),
      JSON.stringify({
        kind: 2,
        k: ["requests"],
        v: [{ message: { text: "Find my chat" }, response: [{ value: "Found it" }] }]
      })
    ].join("\n")
  );

  const result = await scanStorageRoots([{
    id: "insiders",
    label: "VS Code Insiders",
    path: root
  }]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].id, "session-id");
  assert.match(result.sessions[0].key, /^insiders:/);
  assert.equal(result.sessions[0].workspaceName, "sample-workspace");
  assert.deepEqual(result.sessions[0].workspaceFolders, [{
    name: "sample-workspace",
    location: "/tmp/sample-workspace",
    uri: pathToFileURL("/tmp/sample-workspace").toString()
  }]);
  assert.equal(result.sessions[0].sourceLabel, "VS Code Insiders");
  assert.equal(result.sessions[0].workspaceExists, false);
  assert.equal(result.sessions[0].messageCount, 1);
  assert.equal(result.sessions[0].responseCount, 1);
  assert.deepEqual(sessionWordCounts(result.sessions[0]), {
    user: 3,
    bot: 2
  });
  assert.match(result.sessions[0].searchableText, /found it/);
});

test("labels default Stable and Insiders storage roots", () => {
  const roots = defaultStorageRoots(
    path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Code - Insiders",
      "User",
      "globalStorage",
      "jonwomack.cross-workspace-chat-viewer"
    ),
    [],
    "insiders"
  );

  assert.ok(roots.some((root) => root.id === "stable" && root.label === "VS Code"));
  assert.ok(roots.some((root) =>
    root.id === "insiders" && root.label === "VS Code Insiders"
  ));
});

test("discovers workspaces without chats and lists saved workspace folders", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cross-workspace-destinations-"));
  const storage = path.join(root, "workspace-hash");
  const project = path.join(root, "project");
  const workspaceFile = path.join(root, "team.code-workspace");
  fs.mkdirSync(storage, { recursive: true });
  fs.mkdirSync(project);
  fs.writeFileSync(
    workspaceFile,
    [
      "{",
      "  // JSON with Comments is valid in a saved VS Code workspace.",
      `  "folders": [{ "name": "Project", "path": ${JSON.stringify("./project")} }],`,
      "}"
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(storage, "workspace.json"),
    JSON.stringify({ workspace: pathToFileURL(workspaceFile).toString() })
  );

  const result = await scanStorageRoots([{
    id: "stable",
    label: "VS Code",
    path: root
  }]);

  assert.equal(result.sessions.length, 0);
  assert.equal(result.workspaces.length, 1);
  assert.equal(result.workspaces[0].name, "team");
  assert.deepEqual(result.workspaces[0].folders, [{
    name: "Project",
    location: project,
    uri: pathToFileURL(project).toString()
  }]);
});

test("lists folders from untitled workspace configuration files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cross-workspace-untitled-"));
  const storage = path.join(root, "workspace-hash");
  const workspaceFile = path.join(root, "workspace.json");
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(
    workspaceFile,
    JSON.stringify({
      folders: [
        { path: "/project/backend" },
        { path: "/project/frontend" }
      ]
    })
  );
  fs.writeFileSync(
    path.join(storage, "workspace.json"),
    JSON.stringify({ workspace: pathToFileURL(workspaceFile).toString() })
  );

  const result = await scanStorageRoots([{
    id: "stable",
    label: "VS Code",
    path: root
  }]);

  assert.deepEqual(
    result.workspaces[0].folders.map((folder) => folder.name),
    ["backend", "frontend"]
  );
});

test("keeps remote workspace sessions continuable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cross-workspace-chat-viewer-remote-"));
  const storage = path.join(root, "remote-hash");
  const chats = path.join(storage, "chatSessions");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(
    path.join(storage, "workspace.json"),
    JSON.stringify({
      folder: "vscode-remote://ssh-remote+example/home/user/project"
    })
  );
  fs.writeFileSync(
    path.join(chats, "remote.json"),
    JSON.stringify({
      sessionId: "remote-session",
      requests: [{ message: { text: "Remote chat" }, response: [] }]
    })
  );

  const result = await scanStorageRoots([{
    id: "stable",
    label: "VS Code",
    path: root
  }]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.sessions[0].workspaceName, "project");
  assert.equal(result.sessions[0].workspaceExists, true);
  assert.equal(
    result.sessions[0].workspaceUri,
    "vscode-remote://ssh-remote+example/home/user/project"
  );
});

test("reports recently modified sessions progressively", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cross-workspace-chat-viewer-progress-"));
  const storage = path.join(root, "hash");
  const chats = path.join(storage, "chatSessions");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(
    path.join(storage, "workspace.json"),
    JSON.stringify({ folder: pathToFileURL("/tmp/sample-workspace").toString() })
  );

  const olderPath = path.join(chats, "older.json");
  const newerPath = path.join(chats, "newer.json");
  fs.writeFileSync(olderPath, JSON.stringify({ sessionId: "older", requests: [] }));
  fs.writeFileSync(newerPath, JSON.stringify({ sessionId: "newer", requests: [] }));
  fs.utimesSync(olderPath, new Date(1000), new Date(1000));
  fs.utimesSync(newerPath, new Date(2000), new Date(2000));

  const reported = [];
  await scanStorageRoots([{
    id: "stable",
    label: "VS Code",
    path: root
  }], {
    concurrency: 1,
    onSession: (session) => reported.push(session.id)
  });

  assert.deepEqual(reported, ["newer", "older"]);
});

test("stops progressive loading when the scan is cancelled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cross-workspace-chat-viewer-cancel-"));
  const storage = path.join(root, "hash", "chatSessions");
  fs.mkdirSync(storage, { recursive: true });
  for (let index = 0; index < 3; index += 1) {
    fs.writeFileSync(
      path.join(storage, `${index}.json`),
      JSON.stringify({ sessionId: `session-${index}`, requests: [] })
    );
  }

  let active = true;
  const reported = [];
  const result = await scanStorageRoots([{
    id: "stable",
    label: "VS Code",
    path: root
  }], {
    concurrency: 1,
    shouldContinue: () => active,
    onSession: (session) => {
      reported.push(session.id);
      active = false;
    }
  });

  assert.equal(reported.length, 1);
  assert.equal(result.sessions.length, 1);
});

test("continues scanning when one JSONL transcript is malformed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cross-workspace-chat-viewer-malformed-"));
  const storage = path.join(root, "hash", "chatSessions");
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(
    path.join(storage, "valid.json"),
    JSON.stringify({ sessionId: "valid-session", requests: [] })
  );
  fs.writeFileSync(path.join(storage, "invalid.jsonl"), "{\"kind\":0,\"v\":");

  const result = await scanStorageRoots([{
    id: "stable",
    label: "VS Code",
    path: root
  }]);

  assert.deepEqual(result.sessions.map((session) => session.id), ["valid-session"]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /invalid\.jsonl/);
});
