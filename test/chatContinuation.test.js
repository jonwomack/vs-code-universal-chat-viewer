"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeContinuationTranscript } = require("../src/chatContinuation");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-continuation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("exports every native turn from disk, not the cached preview, without modifying the source", async (t) => {
  const root = fixture(t);
  const filePath = path.join(root, "native.json");
  const source = JSON.stringify({
    sessionId: "native",
    customTitle: "Historical discussion",
    requests: [
      { message: { text: "First question" }, response: [{ value: "First answer" }] },
      { message: { text: "Latest question" }, response: [{ value: "Latest answer" }] }
    ]
  });
  fs.writeFileSync(filePath, source);
  const session = {
    filePath,
    sourceLabel: "VS Code",
    sourceProduct: "stable",
    workspaceName: "Missing workspace",
    workspacePath: "/missing-project",
    messages: [{ prompt: "Stale cache", response: "" }]
  };
  const exported = await writeContinuationTranscript(session, path.join(root, "storage"));
  const text = fs.readFileSync(exported, "utf8");
  assert.match(text, /# Historical discussion/);
  assert.match(text, /First question[\s\S]*First answer[\s\S]*Latest question[\s\S]*Latest answer/);
  assert.match(text, /Original workspace: \/missing-project/);
  assert.doesNotMatch(text, /Stale cache/);
  assert.equal(fs.readFileSync(filePath, "utf8"), source);
  assert.equal(await writeContinuationTranscript(session, path.join(root, "storage")), exported);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(exported).mode & 0o777, 0o600);
  }
});

test("exports Copilot event streams and gives updated conversations a separate snapshot", async (t) => {
  const root = fixture(t);
  const directory = path.join(root, "session");
  fs.mkdirSync(directory);
  const filePath = path.join(directory, "events.jsonl");
  fs.writeFileSync(filePath, [
    JSON.stringify({ type: "user.message", data: { content: "Event question" } }),
    JSON.stringify({ type: "assistant.message", data: { content: "Event answer" } })
  ].join("\n") + "\n");
  const session = { filePath, sourceKind: "copilot-cli" };
  const exported = await writeContinuationTranscript(session, path.join(root, "storage"));
  const original = fs.readFileSync(exported, "utf8");
  assert.match(original, /Event question[\s\S]*Event answer/);
  assert.match(original, /Copilot session history/);
  fs.appendFileSync(filePath,
    JSON.stringify({ type: "user.message", data: { content: "New question" } }) + "\n");
  const updated = await writeContinuationTranscript(session, path.join(root, "storage"));
  assert.notEqual(exported, updated);
  assert.match(fs.readFileSync(updated, "utf8"), /New question/);
  assert.equal(fs.readFileSync(exported, "utf8"), original);
});

test("supports native JSONL journals and preserves multiline text", async (t) => {
  const root = fixture(t);
  const filePath = path.join(root, "native.jsonl");
  fs.writeFileSync(filePath, [
    JSON.stringify({ kind: 0, v: { requests: [] } }),
    JSON.stringify({ kind: 2, k: ["requests"], v: [{
      message: { text: "Question\nwith multiple lines" },
      response: [{ value: "Answer\nwith multiple lines" }]
    }] })
  ].join("\n"));
  const exported = await writeContinuationTranscript({
    filePath,
    sourceProduct: "stable",
    sourceLabel: "VS Code"
  }, path.join(root, "storage"));
  const text = fs.readFileSync(exported, "utf8");
  assert.match(text, /Question\nwith multiple lines/);
  assert.match(text, /Answer\nwith multiple lines/);
});

test("surfaces missing, corrupt, and empty transcripts instead of using stale cached messages", async (t) => {
  const root = fixture(t);
  const filePath = path.join(root, "native.json");
  const session = { filePath, messages: [{ prompt: "Stale cached question" }] };
  await assert.rejects(writeContinuationTranscript(session, root), { code: "ENOENT" });
  fs.writeFileSync(filePath, "{bad json");
  await assert.rejects(writeContinuationTranscript(session, root), SyntaxError);
  fs.writeFileSync(filePath, JSON.stringify({ requests: [] }));
  await assert.rejects(writeContinuationTranscript(session, root), /no readable messages/);
});
