"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  discoverSessionFiles,
  summarizeSessionCandidate,
  workspaceUri
} = require("./chatStorage");
const { terms } = require("./router");

const INDEX_VERSION = 1;
const DEFAULT_CHUNK_CHARACTERS = 6000;
const DEFAULT_CHUNK_OVERLAP = 400;

class RouteIndex {
  constructor(indexPath, rootsProvider, options = {}) {
    this.indexPath = indexPath;
    this.rootsProvider = rootsProvider;
    this.log = options.log || (() => {});
    this.maximumSessions = options.maximumSessions || 150;
    this.embeddingProvider = options.embeddingProvider || (async () => undefined);
    this.entries = new Map();
    this.loadPromise = undefined;
    this.refreshPromise = undefined;
    this.listeners = new Set();
    this.semanticSignature = undefined;
    this.state = {
      refreshing: false,
      totalTranscripts: 0,
      pendingTranscripts: 0,
      semanticEnabled: false,
      lastUpdatedAt: undefined
    };
  }

  async start() {
    await this.load();
    void this.refresh().catch((error) => {
      this.log(`Unable to refresh prompt-routing index: ${error.stack || error.message}`);
    });
  }

  async getSessions() {
    await this.load();
    if (this.sessionCount() === 0) {
      await this.refresh();
    }
    return [...this.entries.values()]
      .map((entry) => entry.session)
      .filter(Boolean)
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
  }

  refresh() {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshWithLock().finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return this.refreshPromise;
  }

  async refreshWithLock() {
    const release = await acquireIndexLock(`${this.indexPath}.lock`);
    if (!release) {
      this.log("Prompt-routing index refresh is already running in another VS Code window.");
      return;
    }
    try {
      await this.refreshIndex();
    } finally {
      await release();
    }
  }

  async clearEmbeddings() {
    await this.load();
    let changed = false;
    for (const entry of this.entries.values()) {
      if (entry.session?.embeddingSignature || entry.session?.embeddingVectors) {
        delete entry.session.embeddingSignature;
        delete entry.session.embeddingVectors;
        changed = true;
      }
    }
    if (changed) {
      await this.persist();
    }
    this.emitStatus();
  }

  getStatus() {
    const sessions = [...this.entries.values()]
      .map((entry) => entry.session)
      .filter(Boolean);
    return {
      ...this.state,
      indexedChats: sessions.length,
      semanticIndexedChats: sessions.filter((session) =>
        (!this.state.semanticEnabled || session.embeddingSignature === this.semanticSignature)
        && Array.isArray(session.embeddingVectors)
        && session.embeddingVectors.length > 0
      ).length
    };
  }

  onDidChangeStatus(listener) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  emitStatus() {
    const status = this.getStatus();
    for (const listener of this.listeners) {
      listener(status);
    }
  }

  async load() {
    if (!this.loadPromise) {
      this.loadPromise = this.loadIndex();
    }
    return this.loadPromise;
  }

  async loadIndex() {
    let stored;
    try {
      stored = JSON.parse(await fs.promises.readFile(this.indexPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.log(`Unable to read prompt-routing index; rebuilding it: ${error.message}`);
      }
      return;
    }
    if (stored?.version !== INDEX_VERSION || !Array.isArray(stored.entries)) {
      this.log("Prompt-routing index has an unsupported version; rebuilding it.");
      return;
    }
    for (const entry of stored.entries) {
      if (
        entry?.filePath
        && Object.prototype.hasOwnProperty.call(entry, "session")
        && !this.entries.has(entry.filePath)
      ) {
        this.entries.set(entry.filePath, entry);
      }
    }
    this.state.totalTranscripts = this.entries.size;
    this.emitStatus();
  }

  async refreshIndex() {
    const embeddingClient = await this.embeddingProvider();
    this.state.semanticEnabled = Boolean(embeddingClient);
    this.semanticSignature = embeddingClient?.signature;
    const { candidates, errors } = await discoverSessionFiles(this.rootsProvider());
    for (const error of errors) {
      this.log(error);
    }

    const selected = candidates.slice(0, this.maximumSessions);
    const selectedPaths = new Set(selected.map((candidate) => candidate.filePath));
    let pruned = 0;
    for (const filePath of this.entries.keys()) {
      if (!selectedPaths.has(filePath)) {
        this.entries.delete(filePath);
        pruned += 1;
      }
    }

    const changed = selected.filter((candidate) => {
      const existing = this.entries.get(candidate.filePath);
      return !existing
        || existing.size !== candidate.stats.size
        || existing.modifiedAt !== candidate.stats.mtimeMs
        || existing.workspaceExists !== candidate.workspace.exists
        || existing.workspaceUri !== candidate.workspace.uri
        || (
          embeddingClient
          && existing.session
          && existing.session.embeddingSignature !== embeddingClient.signature
        );
    });
    this.state.refreshing = changed.length > 0;
    this.state.totalTranscripts = selected.length;
    this.state.pendingTranscripts = changed.length;
    this.emitStatus();
    let nextIndex = 0;
    const refreshErrors = [];

    const worker = async () => {
      while (nextIndex < changed.length) {
        const candidate = changed[nextIndex];
        nextIndex += 1;
        try {
          const session = await summarizeSessionCandidate(candidate);
          if (!session) {
            this.entries.set(candidate.filePath, skippedEntry(candidate));
            continue;
          }
          if (
            session.workspaceExists
            && workspaceUri(session)
            && session.messageCount > 0
          ) {
            const compact = compactSession(session);
            if (embeddingClient) {
              try {
                const chunks = chunkText(session.searchableText);
                compact.embeddingSignature = embeddingClient.signature;
                compact.embeddingVectors = await embedBatches(embeddingClient, chunks);
              } catch (error) {
                refreshErrors.push(`${candidate.filePath}: ${error.message}`);
              }
            }
            this.entries.set(candidate.filePath, {
              filePath: candidate.filePath,
              size: candidate.stats.size,
              modifiedAt: candidate.stats.mtimeMs,
              workspaceExists: candidate.workspace.exists,
              workspaceUri: candidate.workspace.uri,
              session: compact
            });
            if (embeddingClient) {
              await this.persist();
            }
          } else {
            this.entries.set(candidate.filePath, skippedEntry(candidate));
          }

        } catch (error) {
          refreshErrors.push(`${candidate.filePath}: ${error.message}`);
          this.entries.set(candidate.filePath, skippedEntry(candidate));
        } finally {
          this.state.pendingTranscripts -= 1;
          this.emitStatus();
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.max(1, Math.min(embeddingClient ? 1 : 4, changed.length)) },
      worker
    ));
    for (const error of refreshErrors) {
      this.log(error);
    }

    if (changed.length > 0 || pruned > 0) {
      await this.persist();
    }
    this.state.refreshing = false;
    this.state.pendingTranscripts = 0;
    this.state.lastUpdatedAt = Date.now();
    this.emitStatus();
    this.log(
      `Prompt-routing index: ${this.sessionCount()} chats, ${changed.length} changed transcript${changed.length === 1 ? "" : "s"}.`
    );
  }

  async persist() {
    await fs.promises.mkdir(path.dirname(this.indexPath), { recursive: true });
    const temporaryPath = `${this.indexPath}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporaryPath, JSON.stringify({
      version: INDEX_VERSION,
      entries: [...this.entries.values()]
    }));
    await fs.promises.rename(temporaryPath, this.indexPath);
  }

  sessionCount() {
    return [...this.entries.values()].filter((entry) => entry.session).length;
  }
}

async function acquireIndexLock(lockPath) {
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const handle = await fs.promises.open(lockPath, "wx");
    await handle.writeFile(String(process.pid));
    return async () => {
      await handle.close();
      await fs.promises.rm(lockPath, { force: true });
    };
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }

  try {
    const pid = Number(await fs.promises.readFile(lockPath, "utf8"));
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return undefined;
      } catch (error) {
        if (error.code !== "ESRCH") {
          return undefined;
        }
      }
    }
    await fs.promises.rm(lockPath, { force: true });
    return acquireIndexLock(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return acquireIndexLock(lockPath);
    }
    throw error;
  }
}

async function embedBatches(client, chunks, batchSize = 8) {
  const vectors = [];
  for (let index = 0; index < chunks.length; index += batchSize) {
    vectors.push(...await client.embed(chunks.slice(index, index + batchSize)));
  }
  return vectors;
}

function chunkText(value, maximum = DEFAULT_CHUNK_CHARACTERS, overlap = DEFAULT_CHUNK_OVERLAP) {
  const text = String(value || "").trim();
  if (!text) {
    return [];
  }
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maximum, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf("\n", end);
      if (boundary > start + maximum / 2) {
        end = boundary;
      }
    }
    chunks.push(text.slice(start, end));
    if (end === text.length) {
      break;
    }
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

function skippedEntry(candidate) {
  return {
    filePath: candidate.filePath,
    size: candidate.stats.size,
    modifiedAt: candidate.stats.mtimeMs,
    workspaceExists: candidate.workspace.exists,
    workspaceUri: candidate.workspace.uri,
    session: null
  };
}

function compactSession(session) {
  return {
    key: session.key,
    id: session.id,
    title: session.title,
    workspaceName: session.workspaceName,
    workspaceUri: session.workspaceUri,
    workspacePath: session.workspacePath,
    workspaceExists: session.workspaceExists,
    sourceProduct: session.sourceProduct,
    sourceLabel: session.sourceLabel,
    filePath: session.filePath,
    modifiedAt: session.modifiedAt,
    messageCount: session.messageCount,
    searchableTerms: terms(session.searchableText)
  };
}

module.exports = {
  RouteIndex,
  acquireIndexLock,
  chunkText,
  compactSession,
  embedBatches
};
