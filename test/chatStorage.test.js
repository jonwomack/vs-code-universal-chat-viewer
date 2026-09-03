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
  scanStorageRoots
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "universal-chat-viewer-"));
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
  assert.equal(result.sessions[0].sourceLabel, "VS Code Insiders");
  assert.equal(result.sessions[0].workspaceExists, false);
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
      "jonwomack.universal-chat-viewer"
    ),
    [],
    "insiders"
  );

  assert.ok(roots.some((root) => root.id === "stable" && root.label === "VS Code"));
  assert.ok(roots.some((root) =>
    root.id === "insiders" && root.label === "VS Code Insiders"
  ));
});

test("keeps remote workspace sessions continuable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "universal-chat-viewer-remote-"));
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
