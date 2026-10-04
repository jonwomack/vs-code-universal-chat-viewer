"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  appendedChatActivity,
  classifyAppendedChatActivity,
  chatIsInProgress
} = require("../src/transcriptActivity");

test("detects request and response appends but ignores input state", () => {
  assert.equal(appendedChatActivity(JSON.stringify({
    kind: 2,
    k: ["requests", 0, "response"],
    v: [{ value: "partial" }]
  })), true);
  assert.equal(appendedChatActivity(JSON.stringify({
    kind: 1,
    k: ["inputState", "inputText"],
    v: "draft"
  })), false);
});

test("ignores mutations to historical requests", () => {
  assert.deepEqual(classifyAppendedChatActivity(JSON.stringify({
    kind: 1,
    k: ["requests", 2, "response", 0],
    v: { value: "historical metadata" }
  }), 58), {
    relevant: false,
    response: false
  });
  assert.deepEqual(classifyAppendedChatActivity(JSON.stringify({
    kind: 2,
    k: ["requests", 58, "response"],
    v: [{ value: "current response" }]
  }), 58), {
    relevant: true,
    response: true
  });
});

test("detects new requests and pending-request mutations", () => {
  assert.deepEqual(classifyAppendedChatActivity([
    JSON.stringify({ kind: 2, k: ["requests"], v: [{}] }),
    JSON.stringify({ kind: 1, k: ["pendingRequests", 0], v: {} })
  ].join("\n"), 58), {
    relevant: true,
    response: false
  });
});

test("requires pending state or response content to remain in progress", () => {
  assert.equal(chatIsInProgress({
    pendingRequests: [{}],
    requests: [{ result: {} }]
  }), true);
  assert.equal(chatIsInProgress({
    pendingRequests: [],
    requests: [{ response: [] }]
  }), false);
  assert.equal(chatIsInProgress({
    pendingRequests: [],
    requests: [{ mcpServersStarting: ["server"] }]
  }), false);
  assert.equal(chatIsInProgress({
    pendingRequests: [],
    requests: [{ response: [{ value: "partial" }] }]
  }), true);
  assert.equal(chatIsInProgress({
    pendingRequests: [],
    requests: [{ response: [], result: {} }]
  }), false);
});
