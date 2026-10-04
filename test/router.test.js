"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  chooseAutomatically,
  cosineSimilarity,
  rankSessions,
  rankSessionsByEmbedding,
  terms
} = require("../src/router");

const sessions = [
  {
    title: "Auth Refactor Thread",
    searchableText: "authentication login access token middleware",
    modifiedAt: 900,
    messageCount: 4
  },
  {
    title: "Database Performance",
    searchableText: "database query index performance",
    modifiedAt: 1000,
    messageCount: 3
  }
];

test("extracts distinct meaningful query terms", () => {
  assert.deepEqual(terms("How do we fix the auth auth flow?"), ["fix", "auth", "flow"]);
});

test("ranks threads by title and conversation overlap", () => {
  const ranked = rankSessions(
    "Refactor authentication and login middleware",
    sessions,
    1000
  );

  assert.equal(ranked[0].session.title, "Auth Refactor Thread");
  assert.deepEqual(ranked[0].matchedTerms, [
    "refactor",
    "authentication",
    "login",
    "middleware"
  ]);
});

test("uses recency when no terms match", () => {
  const ranked = rankSessions("unrelated subject", sessions, 1000);

  assert.equal(ranked[0].session.title, "Database Performance");
});

test("boosts terms found in the title", () => {
  const ranked = rankSessions("database", sessions, 1000);
  assert.ok(ranked[0].titleMatches.includes("database"));
});

test("automatically selects only the highest-ranked thread when enabled", () => {
  const ranked = rankSessions("database query", sessions, 1000);

  assert.equal(
    chooseAutomatically(ranked, true).session.title,
    "Database Performance"
  );
  assert.equal(chooseAutomatically(ranked, false), undefined);
});

test("ranks chats from their strongest and supporting semantic chunks", () => {
  const ranked = rankSessionsByEmbedding([1, 0], [
    {
      title: "Auth",
      modifiedAt: 1000,
      embeddingVectors: [[0.9, 0.1], [0.8, 0.2]]
    },
    {
      title: "Database",
      modifiedAt: 1000,
      embeddingVectors: [[0, 1]]
    }
  ], 1000);

  assert.equal(ranked[0].session.title, "Auth");
  assert.ok(ranked[0].semanticScore > ranked[1].semanticScore);
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
});
