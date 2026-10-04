"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const {
  analyzeWorkspaceUsage,
  isUnavailableRecoveryPathError,
  normalizeLocalPath,
  recoveryLocationPaths
} = require("../src/workspaceAdvisor");

const folders = [
  {
    name: "backend",
    location: "/project/backend",
    uri: pathToFileURL("/project/backend").toString()
  },
  {
    name: "frontend",
    location: "/project/frontend",
    uri: pathToFileURL("/project/frontend").toString()
  },
  {
    name: "docs",
    location: "/project/docs",
    uri: pathToFileURL("/project/docs").toString()
  }
];

test("retains working-directory and referenced roots", () => {
  const result = analyzeWorkspaceUsage({
    workingDirectory: pathToFileURL("/project/backend").toString(),
    requests: [{
      variableData: {
        variables: [{
          name: "file",
          value: {
            scheme: "file",
            path: "/project/frontend/src/App.js"
          }
        }]
      },
      editedFileEvents: [{
        uri: pathToFileURL("/project/backend/src/server.js").toString()
      }]
    }]
  }, folders, "darwin");

  assert.equal(result[0].required, true);
  assert.equal(result[0].recommended, true);
  assert.ok(result[0].categories.includes("Edited files"));
  assert.equal(result[1].recommended, true);
  assert.ok(result[1].categories.includes("Attached context"));
  assert.equal(result[2].recommended, false);
});

test("maps relative tool paths against the working directory", () => {
  const result = analyzeWorkspaceUsage({
    workingDirectory: pathToFileURL("/project/backend").toString(),
    requests: [{
      response: [{
        kind: "toolInvocationSerialized",
        parameters: { filePath: "src/auth.js" }
      }]
    }]
  }, folders, "darwin");

  assert.equal(result[0].turnCount, 1);
  assert.ok(result[0].categories.includes("Tool activity"));
});

test("keeps all roots when the stored history has no usable evidence", () => {
  const result = analyzeWorkspaceUsage({
    requests: [{ message: { text: "Discuss architecture" }, response: [] }]
  }, folders, "darwin");

  assert.ok(result.every((root) => root.recommended));
});

test("maps serialized remote references to remote workspace roots", () => {
  const result = analyzeWorkspaceUsage({
    requests: [{
      contentReferences: [{
        reference: {
          uri: {
            scheme: "vscode-remote",
            authority: "ssh-remote+example",
            path: "/project/backend/src/server.js"
          }
        }
      }]
    }]
  }, [
    {
      name: "backend",
      location: "vscode-remote://ssh-remote+example/project/backend",
      uri: "vscode-remote://ssh-remote+example/project/backend"
    },
    {
      name: "docs",
      location: "vscode-remote://ssh-remote+example/project/docs",
      uri: "vscode-remote://ssh-remote+example/project/docs"
    }
  ], "linux");

  assert.equal(result[0].recommended, true);
  assert.ok(result[0].categories.includes("References"));
  assert.equal(result[1].recommended, false);
});

test("normalizes Windows file URIs case-insensitively", () => {
  assert.equal(
    normalizeLocalPath("file:///C:/Users/Jon/Project", "win32"),
    "c:\\users\\jon\\project"
  );
});

test("collects transcript-derived local paths for workspace recovery", () => {
  const result = recoveryLocationPaths({
    workingDirectory: pathToFileURL("/project/backend").toString(),
    requests: [{
      editedFileEvents: [{ uri: pathToFileURL("/project/frontend/src/App.js").toString() }],
      response: [{
        kind: "toolInvocationSerialized",
        parameters: { filePath: "src/auth.js" }
      }]
    }]
  }, "darwin");

  assert.ok(result.includes("/project/backend"));
  assert.ok(result.includes("/project/frontend/src/App.js"));
  assert.ok(result.includes("/project/backend/src/auth.js"));
});

test("rejects terminal output masquerading as a Windows recovery path", () => {
  const result = recoveryLocationPaths({
    requests: [{
      response: [{
        kind: "toolInvocationSerialized",
        result: {
          path: "C:\\Users\\Jon\\repo \u001b[93m[branch]\u001b[0m> $repo='C:\\Users\\Jon\\other'"
        }
      }, {
        kind: "toolInvocationSerialized",
        result: {
          path: "C:\\Users\\Jon\\repo> git show branch:file.md"
        }
      }]
    }]
  }, "win32");

  assert.deepEqual(result, []);
});

test("rejects oversized recovery path candidates", () => {
  const result = recoveryLocationPaths({
    requests: [{
      result: {
        filePath: `/project/${"a".repeat(5000)}`
      }
    }]
  }, "linux");

  assert.deepEqual(result, []);
});

test("treats blocked UNC hosts as unavailable recovery paths", () => {
  assert.equal(
    isUnavailableRecoveryPathError({ code: "ERR_UNC_HOST_NOT_ALLOWED" }),
    true
  );
  assert.equal(isUnavailableRecoveryPathError({ code: "EACCES" }), false);
});
