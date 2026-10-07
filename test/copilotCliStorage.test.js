"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  scanCopilotCliSessions
} = require("../src/copilotCliStorage");

test("scans GitHub Copilot CLI sessions without indexing tool payloads", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-cli-sessions-"));
  const sessionDirectory = path.join(root, "session-id");
  const workspace = path.join(root, "project");
  fs.mkdirSync(sessionDirectory);
  fs.mkdirSync(workspace);
  fs.writeFileSync(
    path.join(sessionDirectory, "workspace.yaml"),
    [
      "id: session-id",
      `cwd: ${workspace}`,
      "name: Pi touchscreen research",
      "created_at: 2026-09-16T04:50:47.896Z"
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(sessionDirectory, "events.jsonl"),
    [
      JSON.stringify({
        type: "user.message",
        data: { content: "Should I add a touchscreen?" },
        timestamp: "2026-09-16T05:00:00.000Z"
      }),
      JSON.stringify({
        type: "assistant.message",
        data: { content: "Use a lightweight DSI controller." },
        timestamp: "2026-09-16T05:00:01.000Z"
      }),
      JSON.stringify({
        type: "tool.execution_complete",
        data: { result: { content: "SECRET_TOOL_OUTPUT" } },
        timestamp: "2026-09-16T05:00:02.000Z"
      }),
      JSON.stringify({
        type: "assistant.message",
        data: { content: "Avoid a second Chromium dashboard." },
        timestamp: "2026-09-16T05:00:03.000Z"
      })
    ].join("\n")
  );

  const result = await scanCopilotCliSessions(root);

  assert.equal(result.errors.length, 0);
  assert.equal(result.sessions.length, 1);
  const session = result.sessions[0];
  assert.equal(session.id, "session-id");
  assert.equal(session.title, "Pi touchscreen research");
  assert.equal(session.workspaceName, "project");
  assert.equal(session.sourceLabel, "GitHub Copilot CLI");
  assert.equal(session.sourceKind, "copilot-cli");
  assert.equal(session.canContinue, false);
  assert.equal(session.messageCount, 1);
  assert.equal(session.responseCount, 1);
  assert.match(session.messages[0].response, /lightweight DSI controller/);
  assert.match(session.messages[0].response, /second Chromium dashboard/);
  assert.doesNotMatch(session.searchableText, /SECRET_TOOL_OUTPUT/);
});

test("falls back to tool summaries/results when assistant content is empty", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-cli-fallback-"));
  const sessionDirectory = path.join(root, "session-id");
  const workspace = path.join(root, "project");
  fs.mkdirSync(sessionDirectory);
  fs.mkdirSync(workspace);
  fs.writeFileSync(
    path.join(sessionDirectory, "workspace.yaml"),
    [
      "id: session-id",
      `cwd: ${workspace}`,
      "name: Original long first-prompt title",
      "user_named: false",
      "created_at: 2026-09-16T04:50:47.896Z"
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(sessionDirectory, "events.jsonl"),
    [
      JSON.stringify({
        type: "user.message",
        data: { content: "Check the cache state" },
        timestamp: "2026-09-16T05:00:00.000Z"
      }),
      JSON.stringify({
        type: "assistant.message",
        data: {
          content: "",
          toolRequests: [
            {
              name: "rename_chat",
              arguments: { title: "Cache purge investigation", automatic: true }
            },
            {
              name: "some_tool",
              arguments: { summary: "Inspecting the full-server cache." }
            }
          ]
        },
        timestamp: "2026-09-16T05:00:01.000Z"
      }),
      JSON.stringify({
        type: "tool.execution_complete",
        data: { result: { content: "Found a stale 12.7 KB cache entry." } },
        timestamp: "2026-09-16T05:00:02.000Z"
      }),
      JSON.stringify({
        type: "session.task_complete",
        data: { summary: "Purge and recovery verified as consistent." },
        timestamp: "2026-09-16T05:00:03.000Z"
      })
    ].join("\n")
  );

  const result = await scanCopilotCliSessions(root);

  assert.equal(result.errors.length, 0);
  const session = result.sessions[0];
  assert.equal(session.title, "Cache purge investigation");
  assert.match(session.messages[0].response, /Inspecting the full-server cache/);
  assert.match(session.messages[0].response, /stale 12\.7 KB cache entry/);
  assert.match(session.messages[0].response, /Purge and recovery verified/);
  assert.match(session.searchableText, /stale 12\.7 kb cache entry/);
});

test("continues scanning when a CLI event stream is malformed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-cli-errors-"));
  const validDirectory = path.join(root, "valid");
  const invalidDirectory = path.join(root, "invalid");
  fs.mkdirSync(validDirectory);
  fs.mkdirSync(invalidDirectory);
  fs.writeFileSync(
    path.join(validDirectory, "events.jsonl"),
    JSON.stringify({
      type: "user.message",
      data: { content: "Valid session" },
      timestamp: "2026-09-16T05:00:00.000Z"
    })
  );
  fs.writeFileSync(path.join(invalidDirectory, "events.jsonl"), "{not-json");

  const result = await scanCopilotCliSessions(root, { concurrency: 1 });

  assert.equal(result.sessions.length, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /invalid JSON on line 1/);
});
