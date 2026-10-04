"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { RouteIndex, chunkText } = require("../src/routeIndex");

test("chunks the complete discussion with overlap", () => {
  const chunks = chunkText("abcdefghij", 6, 2);
  assert.deepEqual(chunks, ["abcdef", "efghij"]);
});

test("stores semantic vectors for every full-discussion chunk", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-route-semantic-"));
  const storage = path.join(root, "workspace-hash");
  const chats = path.join(storage, "chatSessions");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(
    path.join(storage, "workspace.json"),
    JSON.stringify({ folder: pathToFileURL(root).toString() })
  );
  fs.writeFileSync(path.join(chats, "session.json"), JSON.stringify({
    sessionId: "semantic",
    requests: [{
      message: { text: "Authentication discussion" },
      response: [{ value: "Token middleware details" }]
    }]
  }));
  const embedded = [];
  const client = {
    signature: "test|embedding|2",
    embed: async (chunks) => {
      embedded.push(...chunks);
      return chunks.map(() => [1, 0]);
    }
  };
  const index = new RouteIndex(
    path.join(root, "state", "index.json"),
    () => [{ id: "insiders", label: "Insiders", path: root }],
    { embeddingProvider: async () => client }
  );

  await index.refresh();
  const session = (await index.getSessions())[0];
  assert.match(embedded.join("\n"), /authentication discussion/i);
  assert.match(embedded.join("\n"), /token middleware details/i);
  assert.equal(session.embeddingSignature, client.signature);
  assert.deepEqual(session.embeddingVectors, [[1, 0]]);
});

test("reports semantic index readiness while transcripts are processed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-route-status-"));
  const storage = path.join(root, "workspace-hash");
  const chats = path.join(storage, "chatSessions");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(
    path.join(storage, "workspace.json"),
    JSON.stringify({ folder: pathToFileURL(root).toString() })
  );
  fs.writeFileSync(path.join(chats, "session.json"), JSON.stringify({
    sessionId: "status",
    requests: [{ message: { text: "Index status" }, response: [{ value: "Ready" }] }]
  }));
  const index = new RouteIndex(
    path.join(root, "state", "index.json"),
    () => [{ id: "insiders", label: "Insiders", path: root }],
    {
      embeddingProvider: async () => ({
        signature: "test|embedding|2",
        embed: async (chunks) => chunks.map(() => [1, 0])
      })
    }
  );
  const statuses = [];
  const subscription = index.onDidChangeStatus((status) => statuses.push(status));

  await index.refresh();
  subscription.dispose();

  assert.ok(statuses.some((status) =>
    status.semanticEnabled
    && status.refreshing
    && status.pendingTranscripts === 1
  ));
  assert.deepEqual(index.getStatus(), {
    refreshing: false,
    totalTranscripts: 1,
    pendingTranscripts: 0,
    semanticEnabled: true,
    lastUpdatedAt: index.getStatus().lastUpdatedAt,
    indexedChats: 1,
    semanticIndexedChats: 1
  });
});

test("persists full-discussion terms and reparses only changed transcripts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-route-index-"));
  const storage = path.join(root, "workspace-hash");
  const chats = path.join(storage, "chatSessions");
  const indexPath = path.join(root, "state", "index.json");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(
    path.join(storage, "workspace.json"),
    JSON.stringify({ folder: pathToFileURL(root).toString() })
  );
  const transcript = path.join(chats, "session.json");
  fs.writeFileSync(transcript, JSON.stringify({
    sessionId: "session",
    customTitle: "Authentication",
    requests: [{
      message: { text: "Refactor login" },
      response: [{ value: "Use token middleware" }]
    }]
  }));

  const logs = [];
  const roots = [{ id: "insiders", label: "Insiders", path: root }];
  const index = new RouteIndex(indexPath, () => roots, {
    log: (message) => logs.push(message)
  });
  await index.refresh();

  const sessions = await index.getSessions();
  for (const term of ["authentication", "refactor", "login", "token", "middleware"]) {
    assert.ok(sessions[0].searchableTerms.includes(term), term);
  }
  assert.ok(fs.existsSync(indexPath));

  const reloaded = new RouteIndex(indexPath, () => roots, {
    log: (message) => logs.push(message)
  });
  assert.equal((await reloaded.getSessions())[0].id, "session");

  logs.length = 0;
  await reloaded.refresh();
  assert.ok(logs.some((line) => /0 changed transcripts/.test(line)));
});

test("remembers skipped transcripts until their files change", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-route-skipped-"));
  const storage = path.join(root, "workspace-hash");
  const chats = path.join(storage, "chatSessions");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(
    path.join(storage, "workspace.json"),
    JSON.stringify({ folder: pathToFileURL(root).toString() })
  );
  fs.writeFileSync(path.join(chats, "empty.json"), JSON.stringify({
    sessionId: "empty",
    requests: []
  }));
  fs.writeFileSync(path.join(chats, "broken.jsonl"), "{\"kind\":0,\"v\":");

  const logs = [];
  const index = new RouteIndex(
    path.join(root, "state", "index.json"),
    () => [{ id: "insiders", label: "Insiders", path: root }],
    { log: (message) => logs.push(message) }
  );
  await index.refresh();
  logs.length = 0;
  await index.refresh();

  assert.ok(logs.some((line) => /0 changed transcripts/.test(line)));
  assert.equal(await index.getSessions().then((sessions) => sessions.length), 0);
});
