"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  findWorkspaceStorageDirectory,
  importChatSession,
  moveChatSession
} = require("../src/chatImporter");

test("finds destination storage using equivalent Windows workspace URIs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-import-storage-"));
  const storage = path.join(root, "hash");
  fs.mkdirSync(storage);
  fs.writeFileSync(
    path.join(storage, "workspace.json"),
    JSON.stringify({
      workspace: "file:///c%3A/Users/Jon/Project/team.code-workspace"
    })
  );

  const found = await findWorkspaceStorageDirectory(
    root,
    "file:///C:/users/jon/project/team.code-workspace",
    "win32"
  );

  assert.equal(found, storage);
});

test("copies a chat transcript without modifying the source", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-import-copy-"));
  const source = path.join(root, "session.jsonl");
  const destinationStorage = path.join(root, "destination");
  fs.writeFileSync(source, "{\"kind\":0,\"v\":{\"sessionId\":\"session\"}}");

  const result = await importChatSession(source, destinationStorage);
  const destination = path.join(destinationStorage, "chatSessions", "session.jsonl");

  assert.equal(result.copied, true);
  assert.equal(result.destinationFile, destination);
  assert.equal(fs.readFileSync(source, "utf8"), fs.readFileSync(destination, "utf8"));
});

test("reuses an identical imported transcript", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-import-existing-"));
  const source = path.join(root, "session.jsonl");
  const destinationStorage = path.join(root, "destination");
  const destinationDirectory = path.join(destinationStorage, "chatSessions");
  fs.mkdirSync(destinationDirectory, { recursive: true });
  fs.writeFileSync(source, "same transcript");
  fs.writeFileSync(path.join(destinationDirectory, "session.jsonl"), "same transcript");

  const result = await importChatSession(source, destinationStorage);

  assert.equal(result.copied, false);
});

test("moves a chat only after creating an identical destination", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-import-move-"));
  const source = path.join(root, "session.jsonl");
  const destinationStorage = path.join(root, "destination");
  fs.writeFileSync(source, "chat to move");

  const result = await moveChatSession(source, destinationStorage);

  assert.equal(result.moved, true);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(result.destinationFile, "utf8"), "chat to move");
});

test("keeps the source when a move destination conflicts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-import-move-conflict-"));
  const source = path.join(root, "session.jsonl");
  const destinationStorage = path.join(root, "destination");
  const destinationDirectory = path.join(destinationStorage, "chatSessions");
  fs.mkdirSync(destinationDirectory, { recursive: true });
  fs.writeFileSync(source, "source transcript");
  fs.writeFileSync(path.join(destinationDirectory, "session.jsonl"), "different transcript");

  await assert.rejects(
    moveChatSession(source, destinationStorage),
    /Nothing was overwritten/
  );
  assert.equal(fs.readFileSync(source, "utf8"), "source transcript");
});

test("refuses to overwrite a different transcript with the same filename", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-import-collision-"));
  const source = path.join(root, "session.jsonl");
  const destinationStorage = path.join(root, "destination");
  const destinationDirectory = path.join(destinationStorage, "chatSessions");
  fs.mkdirSync(destinationDirectory, { recursive: true });
  fs.writeFileSync(source, "source transcript");
  fs.writeFileSync(path.join(destinationDirectory, "session.jsonl"), "different transcript");

  await assert.rejects(
    importChatSession(source, destinationStorage),
    /Nothing was overwritten/
  );
});
