"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  deduplicateHandoffs,
  isCurrentWorkspaceUri,
  normalizeLocalWorkspacePath,
  normalizedUriString
} = require("../src/workspaceIdentity");

function uri(scheme, fsPath, value = `${scheme}:${fsPath}`, uriPath = fsPath) {
  return {
    scheme,
    fsPath,
    path: uriPath,
    toString: () => value
  };
}

test("matches Windows file and untitled workspace URIs by local path", () => {
  const target = uri(
    "file",
    "C:\\Users\\Jon\\AppData\\Roaming\\Code\\Workspaces\\1755102938233\\workspace.json",
    "file:///c%3A/Users/Jon/AppData/Roaming/Code/Workspaces/1755102938233/workspace.json"
  );
  const workspaceFile = uri(
    "untitled",
    "1755102938233",
    "untitled:1755102938233",
    "1755102938233"
  );

  assert.equal(
    isCurrentWorkspaceUri(target, workspaceFile, [], "win32"),
    true
  );
});

test("matches an open workspace folder when no workspace file exists", () => {
  const target = uri("file", "/Users/jon/project", "file:///Users/jon/project");
  const folder = uri("file", "/Users/jon/project", "file:///Users/jon/project");

  assert.equal(isCurrentWorkspaceUri(target, undefined, [{ uri: folder }], "darwin"), true);
});

test("does not match a folder inside a different multi-root workspace", () => {
  const target = uri("file", "/Users/jon/project", "file:///Users/jon/project");
  const workspaceFile = uri(
    "file",
    "/Users/jon/team.code-workspace",
    "file:///Users/jon/team.code-workspace"
  );
  const folder = uri("file", "/Users/jon/project", "file:///Users/jon/project");

  assert.equal(
    isCurrentWorkspaceUri(target, workspaceFile, [{ uri: folder }], "darwin"),
    false
  );
});

test("matches equivalent remote workspace URIs exactly", () => {
  const target = uri(
    "vscode-remote",
    "/home/jon/project",
    "vscode-remote://ssh-remote+host/home/jon/project"
  );
  const folder = uri(
    "vscode-remote",
    "/home/jon/project",
    "vscode-remote://ssh-remote+host/home/jon/project"
  );

  assert.equal(isCurrentWorkspaceUri(target, undefined, [{ uri: folder }], "linux"), true);
});

test("does not match the same remote path on another host", () => {
  const target = uri(
    "vscode-remote",
    "/home/jon/project",
    "vscode-remote://ssh-remote+host-a/home/jon/project"
  );
  const folder = uri(
    "vscode-remote",
    "/home/jon/project",
    "vscode-remote://ssh-remote+host-b/home/jon/project"
  );

  assert.equal(isCurrentWorkspaceUri(target, undefined, [{ uri: folder }], "linux"), false);
});

test("does not treat different local workspaces as equal", () => {
  const target = uri("file", "C:\\project-a", "file:///C:/project-a");
  const workspaceFile = uri("untitled", "C:\\project-b", "untitled:C:\\project-b");

  assert.equal(isCurrentWorkspaceUri(target, workspaceFile, [], "win32"), false);
});

test("normalizes Windows workspace paths case-insensitively", () => {
  assert.equal(
    normalizeLocalWorkspacePath(uri("file", "C:\\Users\\JON\\Project"), "win32"),
    "c:\\users\\jon\\project"
  );
});

test("ignores trailing separators in local workspace paths", () => {
  const target = uri("file", "C:\\Users\\Jon\\Project\\", "file:///C:/Users/Jon/Project/");
  const folder = uri("file", "c:\\users\\jon\\project", "file:///c:/users/jon/project");

  assert.equal(isCurrentWorkspaceUri(target, undefined, [{ uri: folder }], "win32"), true);
});

test("normalizes equivalent encoded Windows file URIs for handoffs", () => {
  assert.equal(
    normalizedUriString(
      "file:///c%3A/Users/Jon/Project/workspace.json",
      "win32"
    ),
    normalizedUriString(
      "file:///C:/users/jon/project/workspace.json",
      "win32"
    )
  );
});

test("deduplicates repeated handoffs while keeping the newest item", () => {
  const older = {
    id: "session",
    workspaceUri: "file:///c%3A/project/workspace.json",
    product: "stable",
    savedAt: 1
  };
  const newer = {
    ...older,
    workspaceUri: "file:///C:/PROJECT/workspace.json",
    savedAt: 2
  };

  assert.deepEqual(deduplicateHandoffs([older, newer], "win32"), [newer]);
});
