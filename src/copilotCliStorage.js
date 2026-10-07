"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { pathToFileURL } = require("node:url");

function defaultCopilotCliRoot() {
  return path.join(os.homedir(), ".copilot", "session-state");
}

function metadataValue(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  if (!match) {
    return undefined;
  }
  const value = match[1].trim();
  if (!value) {
    return undefined;
  }
  if (value.startsWith("\"") || value.startsWith("'")) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

async function readMetadata(sessionDirectory) {
  try {
    const text = await fs.promises.readFile(
      path.join(sessionDirectory, "workspace.yaml"),
      "utf8"
    );
    return {
      id: metadataValue(text, "id"),
      cwd: metadataValue(text, "cwd"),
      name: metadataValue(text, "name"),
      createdAt: metadataValue(text, "created_at")
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function pathExists(value) {
  if (!value) {
    return false;
  }
  try {
    await fs.promises.access(value, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function truncate(value, maximum) {
  const normalized = String(value).replace(/\s+/g, " ").trim();
  return normalized.length > maximum
    ? `${normalized.slice(0, maximum - 1)}...`
    : normalized;
}

async function parseCopilotCliSession(sessionDirectory, stats) {
  const eventsPath = path.join(sessionDirectory, "events.jsonl");
  const metadata = await readMetadata(sessionDirectory);
  const messages = [];
  let firstTimestamp;
  let lineNumber = 0;
  let latestRenameTitle;
  const lines = readline.createInterface({
    input: fs.createReadStream(eventsPath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  for await (const rawLine of lines) {
    lineNumber += 1;
    if (!rawLine.trim()) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(rawLine);
    } catch (error) {
      throw new Error(`invalid JSON on line ${lineNumber}: ${error.message}`);
    }
    if (!firstTimestamp && event.timestamp) {
      firstTimestamp = Date.parse(event.timestamp);
    }
    if (event.type === "user.message" && typeof event.data?.content === "string") {
      messages.push({
        prompt: event.data.content,
        response: "",
        timestamp: event.timestamp ? Date.parse(event.timestamp) : undefined,
        fallbackResponseParts: []
      });
    } else if (
      event.type === "assistant.message"
      && typeof event.data?.content === "string"
      && event.data.content.trim()
      && messages.length > 0
    ) {
      const message = messages.at(-1);
      message.response = [message.response, event.data.content]
        .filter(Boolean)
        .join("\n\n");
    } else if (
      event.type === "assistant.message"
      && Array.isArray(event.data?.toolRequests)
      && messages.length > 0
    ) {
      const message = messages.at(-1);
      for (const toolRequest of event.data.toolRequests) {
        const summary = toolRequest?.arguments?.summary;
        if (typeof summary === "string" && summary.trim()) {
          message.fallbackResponseParts.push(summary);
        }
        if (
          toolRequest?.name === "rename_chat"
          && typeof toolRequest?.arguments?.title === "string"
          && toolRequest.arguments.title.trim()
        ) {
          latestRenameTitle = toolRequest.arguments.title.trim();
        }
      }
    } else if (
      event.type === "tool.execution_complete"
      && typeof event.data?.result?.content === "string"
      && event.data.result.content.trim()
      && messages.length > 0
    ) {
      messages.at(-1).fallbackResponseParts.push(event.data.result.content);
    } else if (
      event.type === "session.task_complete"
      && typeof event.data?.summary === "string"
      && event.data.summary.trim()
      && messages.length > 0
    ) {
      messages.at(-1).fallbackResponseParts.push(event.data.summary);
    }
  }

  // Some turns never emit narrated assistant content (e.g. tool-call-only
  // turns like automatic chat renames). For those, fall back to the text
  // surfaced via tool-call summaries, tool results, or the task-complete
  // summary so the turn isn't indexed/displayed as blank.
  for (const message of messages) {
    if (!message.response.trim() && message.fallbackResponseParts.length > 0) {
      message.response = message.fallbackResponseParts.join("\n\n");
    }
    delete message.fallbackResponseParts;
  }

  const id = metadata.id || path.basename(sessionDirectory);
  const workspacePath = metadata.cwd;
  const workspaceExists = await pathExists(workspacePath);
  const workspaceName = workspacePath ? path.basename(workspacePath) : "No workspace";
  const createdAt = Date.parse(metadata.createdAt || "") || firstTimestamp || stats.birthtimeMs;
  const title = truncate(
    latestRenameTitle || metadata.name
      || messages.find((message) => message.prompt.trim())?.prompt
      || "Untitled CLI chat",
    100
  );

  return {
    key: `copilot-cli:${eventsPath}`,
    id,
    title,
    workspaceName,
    workspaceUri: workspacePath ? pathToFileURL(workspacePath).toString() : undefined,
    workspacePath,
    workspaceFolders: workspacePath ? [{
      name: workspaceName,
      location: workspacePath,
      uri: pathToFileURL(workspacePath).toString()
    }] : [],
    workspaceExists,
    sourceProduct: "copilot-cli",
    sourceLabel: "GitHub Copilot CLI",
    sourceKind: "copilot-cli",
    canContinue: false,
    storageDirectory: sessionDirectory,
    filePath: eventsPath,
    createdAt,
    modifiedAt: stats.mtimeMs,
    fileSizeBytes: stats.size,
    messageCount: messages.length,
    responseCount: messages.filter((message) => message.response).length,
    searchableText: [
      title,
      workspaceName,
      "GitHub Copilot CLI",
      ...messages.flatMap((message) => [message.prompt, message.response])
    ].filter(Boolean).join("\n").toLowerCase(),
    messages
  };
}

async function scanCopilotCliSessions(root = defaultCopilotCliRoot(), options = {}) {
  const sessions = [];
  const errors = [];
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      errors.push(`${root}: ${error.message}`);
    }
    return { sessions, errors };
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sessionDirectory = path.join(root, entry.name);
    const eventsPath = path.join(sessionDirectory, "events.jsonl");
    try {
      const stats = await fs.promises.stat(eventsPath);
      candidates.push({ sessionDirectory, eventsPath, stats });
    } catch (error) {
      if (error.code !== "ENOENT") {
        errors.push(`${eventsPath}: ${error.message}`);
      }
    }
  }
  candidates.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs);

  const concurrency = Math.max(1, Math.min(options.concurrency || 4, candidates.length || 1));
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < candidates.length && options.shouldContinue?.() !== false) {
      const candidate = candidates[nextIndex];
      nextIndex += 1;
      try {
        const session = await parseCopilotCliSession(
          candidate.sessionDirectory,
          candidate.stats
        );
        if (options.shouldContinue?.() === false) {
          continue;
        }
        sessions.push(session);
        await options.onSession?.(session);
      } catch (error) {
        errors.push(`${candidate.eventsPath}: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  sessions.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return { sessions, errors };
}

module.exports = {
  defaultCopilotCliRoot,
  parseCopilotCliSession,
  scanCopilotCliSessions
};
