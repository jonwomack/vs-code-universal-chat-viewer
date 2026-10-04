"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { pathToFileURL, fileURLToPath } = require("node:url");

function setAtPath(target, keys, value) {
  if (keys.length === 0) {
    return value;
  }

  let current = target;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    if (current[key] === undefined || current[key] === null) {
      current[key] = typeof keys[index + 1] === "number" ? [] : {};
    }
    current = current[key];
  }
  current[keys.at(-1)] = value;
  return target;
}

function appendAtPath(target, keys, value) {
  if (keys.length === 0) {
    if (!Array.isArray(target) || !Array.isArray(value)) {
      return value;
    }
    target.push(...value);
    return target;
  }

  let current = target;
  for (const key of keys) {
    if (current[key] === undefined || current[key] === null) {
      current[key] = [];
    }
    current = current[key];
  }
  if (!Array.isArray(current) || !Array.isArray(value)) {
    return setAtPath(target, keys, value);
  }
  current.push(...value);
  return target;
}

function applyJsonLineRecord(state, record) {
  if (record.kind === 0) {
    return record.v;
  }
  if (record.kind === 1 && state !== undefined) {
    return setAtPath(state, record.k || [], record.v);
  }
  if (record.kind === 2 && state !== undefined) {
    return appendAtPath(state, record.k || [], record.v);
  }
  return state;
}

function parseJsonLines(text) {
  let state;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line) {
      state = applyJsonLineRecord(state, JSON.parse(line));
    }
  }
  return state;
}

async function readSessionFile(filePath) {
  if (filePath.endsWith(".jsonl")) {
    let state;
    const lines = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity
    });
    for await (const rawLine of lines) {
      const line = rawLine.trim();
      if (line) {
        state = applyJsonLineRecord(state, JSON.parse(line));
      }
    }
    return state;
  }
  return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
}

function uriToFsPath(value) {
  if (!value || typeof value !== "string") {
    return undefined;
  }
  try {
    if (value.startsWith("file:")) {
      return fileURLToPath(value);
    }
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? undefined : value;
  } catch {
    return undefined;
  }
}

function workspaceName(uri, fsPath, storageDirectory) {
  if (fsPath) {
    return path.basename(
      fsPath,
      path.extname(fsPath) === ".code-workspace" ? ".code-workspace" : ""
    );
  }
  if (uri) {
    try {
      const parsed = new URL(uri);
      const name = path.posix.basename(parsed.pathname);
      if (name) {
        return decodeURIComponent(name);
      }
    } catch {
      // Fall through to the orphaned label.
    }
  }
  return `Orphaned (${path.basename(storageDirectory).slice(0, 8)})`;
}

function workspaceFolder(value, name, baseDirectory) {
  if (!value || typeof value !== "string") {
    return undefined;
  }

  const localPath = uriToFsPath(value);
  const resolvedPath = localPath
    ? (baseDirectory && !path.isAbsolute(localPath)
      ? path.resolve(baseDirectory, localPath)
      : localPath)
    : undefined;
  const uri = resolvedPath
    ? pathToFileURL(resolvedPath).toString()
    : value;
  let defaultName;
  if (resolvedPath) {
    defaultName = path.basename(resolvedPath);
  } else {
    try {
      defaultName = decodeURIComponent(path.posix.basename(new URL(value).pathname));
    } catch {
      defaultName = value;
    }
  }

  return {
    name: name || defaultName,
    location: resolvedPath || value,
    uri
  };
}

function parseJsonWithComments(text) {
  let withoutComments = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        withoutComments += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (character === "\n") {
        withoutComments += character;
      }
      continue;
    }
    if (!inString && character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (!inString && character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    withoutComments += character;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
    } else if (character === "\"") {
      inString = true;
    }
  }

  let withoutTrailingCommas = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const character = withoutComments[index];
    if (!inString && character === ",") {
      let nextIndex = index + 1;
      while (/\s/.test(withoutComments[nextIndex] || "")) {
        nextIndex += 1;
      }
      if (withoutComments[nextIndex] === "}" || withoutComments[nextIndex] === "]") {
        continue;
      }
    }

    withoutTrailingCommas += character;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
    } else if (character === "\"") {
      inString = true;
    }
  }
  return JSON.parse(withoutTrailingCommas);
}

async function readWorkspaceFolders(data, workspacePath) {
  if (data.folder) {
    const folder = workspaceFolder(data.folder);
    return folder ? [folder] : [];
  }
  if (!data.workspace || !workspacePath) {
    return [];
  }

  try {
    const configuration = parseJsonWithComments(
      await fs.promises.readFile(workspacePath, "utf8")
    );
    if (!Array.isArray(configuration?.folders)) {
      return [];
    }
    return configuration.folders
      .map((folder) => workspaceFolder(
        folder?.path || folder?.uri,
        folder?.name,
        path.dirname(workspacePath)
      ))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readWorkspace(storageDirectory) {
  const workspaceFile = path.join(storageDirectory, "workspace.json");
  try {
    await fs.promises.access(workspaceFile, fs.constants.R_OK);
  } catch {
    return {
      name: `Orphaned (${path.basename(storageDirectory).slice(0, 8)})`,
      uri: undefined,
      fsPath: undefined,
      exists: false
    };
  }

  try {
    const data = JSON.parse(await fs.promises.readFile(workspaceFile, "utf8"));
    const uri = data.folder || data.workspace;
    const fsPath = uriToFsPath(uri);
    const name = workspaceName(uri, fsPath, storageDirectory);
    const folders = await readWorkspaceFolders(data, fsPath);
    let exists = Boolean(uri);
    if (fsPath) {
      try {
        await fs.promises.access(fsPath, fs.constants.F_OK);
      } catch {
        exists = false;
      }
    }
    return { name, uri, fsPath, exists, folders };
  } catch {
    return {
      name: `Orphaned (${path.basename(storageDirectory).slice(0, 8)})`,
      uri: undefined,
      fsPath: undefined,
      exists: false
    };
  }
}

function responseText(request) {
  if (!Array.isArray(request?.response)) {
    return "";
  }
  return request.response
    .map((part) => typeof part?.value === "string" ? part.value : "")
    .filter(Boolean)
    .join("\n\n");
}

function countWords(text) {
  if (!text) {
    return 0;
  }
  let count = 0;
  const words = /\S+/g;
  while (words.exec(text)) {
    count += 1;
  }
  return count;
}

async function summarizeSession(data, filePath, storageDirectory, workspace, source, stats) {
  const fileStats = stats || await fs.promises.stat(filePath);
  const requests = Array.isArray(data?.requests) ? data.requests : [];
  const firstPrompt = requests.find((request) => request?.message?.text)?.message.text.trim();
  const id = data?.sessionId || path.basename(filePath, path.extname(filePath));
  const createdAt = Number(data?.creationDate) || fileStats.birthtimeMs || fileStats.mtimeMs;
  const messages = requests.map((request) => ({
    prompt: request?.message?.text || "",
    response: responseText(request),
    timestamp: Number(request?.timestamp) || undefined
  }));

  return {
    key: `${source.id}:${filePath}`,
    id,
    title: data?.customTitle || truncate(firstPrompt || "Untitled chat", 100),
    workspaceName: workspace.name,
    workspaceUri: workspace.uri,
    workspacePath: workspace.fsPath,
    workspaceFolders: workspace.folders || [],
    workspaceExists: workspace.exists,
    sourceProduct: source.id,
    sourceLabel: source.label,
    storageDirectory,
    filePath,
    createdAt,
    modifiedAt: fileStats.mtimeMs,
    fileSizeBytes: fileStats.size,
    messageCount: requests.length,
    responseCount: requests.filter((request) =>
      Array.isArray(request?.response) && request.response.length > 0
    ).length,
    searchableText: [
      data?.customTitle,
      workspace.name,
      source.label,
      ...messages.flatMap((message) => [message.prompt, message.response])
    ].filter(Boolean).join("\n").toLowerCase(),
    messages
  };
}

function sessionWordCount(session) {
  const counts = sessionWordCounts(session);
  return counts.user + counts.bot;
}

function sessionWordCounts(session) {
  return session.messages.reduce(
    (counts, message) => {
      counts.user += countWords(message.prompt);
      counts.bot += countWords(message.response);
      return counts;
    },
    { user: 0, bot: 0 }
  );
}

function truncate(value, maximum) {
  const normalized = String(value).replace(/\s+/g, " ").trim();
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 1)}...` : normalized;
}

async function discoverSessionFiles(storageRoots) {
  const candidates = [];
  const errors = [];
  const workspaces = [];
  const seenFiles = new Set();

  await Promise.all(storageRoots.map(async (root) => {
    const source = typeof root === "string"
      ? { id: "custom", label: "Custom storage", path: root }
      : root;
    if (!source?.path) {
      return;
    }
    try {
      await fs.promises.access(source.path, fs.constants.R_OK);
    } catch (error) {
      if (error.code !== "ENOENT") {
        errors.push(`${source.path}: ${error.message}`);
      }
      return;
    }

    let directories;
    try {
      const entries = await fs.promises.readdir(source.path, { withFileTypes: true });
      directories = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          directories.push(entry);
        } else if (entry.isSymbolicLink()) {
          try {
            const stats = await fs.promises.stat(path.join(source.path, entry.name));
            if (stats.isDirectory()) {
              directories.push(entry);
            }
          } catch (error) {
            errors.push(`${path.join(source.path, entry.name)}: ${error.message}`);
          }
        }
      }
    } catch (error) {
      errors.push(`${source.path}: ${error.message}`);
      return;
    }

    await Promise.all(directories.map(async (directory) => {
      const storageDirectory = path.join(source.path, directory.name);
      const chatsDirectory = path.join(storageDirectory, "chatSessions");
      const workspace = await readWorkspace(storageDirectory);
      if (workspace.uri) {
        workspaces.push({
          ...workspace,
          storageDirectory,
          sourceProduct: source.id,
          sourceLabel: source.label
        });
      }
      try {
        await fs.promises.access(chatsDirectory, fs.constants.R_OK);
      } catch (error) {
        if (error.code !== "ENOENT") {
          errors.push(`${chatsDirectory}: ${error.message}`);
        }
        return;
      }

      let files;
      try {
        files = (await fs.promises.readdir(chatsDirectory))
          .filter((name) => name.endsWith(".jsonl") || name.endsWith(".json"));
      } catch (error) {
        errors.push(`${chatsDirectory}: ${error.message}`);
        return;
      }

      await Promise.all(files.map(async (name) => {
        const filePath = path.join(chatsDirectory, name);
        try {
          const realPath = await fs.promises.realpath(filePath);
          if (seenFiles.has(realPath)) {
            return;
          }
          seenFiles.add(realPath);
          const stats = await fs.promises.stat(realPath);
          candidates.push({
            filePath: realPath,
            storageDirectory: chatsDirectory,
            workspace,
            source,
            stats
          });
        } catch (error) {
          errors.push(`${filePath}: ${error.message}`);
        }
      }));
    }));
  }));

  candidates.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs);
  return { candidates, workspaces, errors };
}

async function scanStorageRoots(storageRoots, options = {}) {
  const sessions = [];
  const { candidates, workspaces, errors } = await discoverSessionFiles(storageRoots);
  const concurrency = Math.max(1, Math.min(options.concurrency || 4, candidates.length || 1));
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < candidates.length && options.shouldContinue?.() !== false) {
      const candidate = candidates[nextIndex];
      nextIndex += 1;
      let session;
      try {
        const data = await readSessionFile(candidate.filePath);
        if (!data || options.shouldContinue?.() === false) {
          continue;
        }
        session = await summarizeSession(
          data,
          candidate.filePath,
          candidate.storageDirectory,
          candidate.workspace,
          candidate.source,
          candidate.stats
        );
      } catch (error) {
        errors.push(`${candidate.filePath}: ${error.message}`);
        continue;
      }

      sessions.push(session);
      if (options.onSession) {
        try {
          await options.onSession(session);
        } catch (error) {
          errors.push(`Unable to report ${candidate.filePath}: ${error.message}`);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  sessions.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return { sessions, workspaces, errors };
}

async function summarizeSessionCandidate(candidate) {
  const data = await readSessionFile(candidate.filePath);
  if (!data) {
    return undefined;
  }

  return summarizeSession(
    data,
    candidate.filePath,
    candidate.storageDirectory,
    candidate.workspace,
    candidate.source,
    candidate.stats
  );
}

async function refreshSession(session) {
  const stats = await fs.promises.stat(session.filePath);
  const data = await readSessionFile(session.filePath);
  if (!data) {
    return undefined;
  }
  return {
    session: await summarizeSession(
      data,
      session.filePath,
      session.storageDirectory,
      {
        name: session.workspaceName,
        uri: session.workspaceUri,
        fsPath: session.workspacePath,
        folders: session.workspaceFolders,
        exists: session.workspaceExists
      },
      {
        id: session.sourceProduct,
        label: session.sourceLabel
      },
      stats
    ),
    data
  };
}

function defaultStorageRoots(currentGlobalStoragePath, additionalRoots = [], currentProductId) {
  const roots = new Map();
  const addRoot = (rootPath, id, label) => {
    const resolved = path.resolve(rootPath);
    const existing = roots.get(resolved);
    if (!existing || id === currentProductId) {
      roots.set(resolved, { path: resolved, id, label });
    }
  };

  if (currentGlobalStoragePath) {
    const currentRoot = path.resolve(currentGlobalStoragePath, "..", "..", "workspaceStorage");
    const id = currentProductId || detectProductFromPath(currentRoot);
    addRoot(currentRoot, id, productLabel(id));
  }

  const home = os.homedir();
  if (process.platform === "darwin") {
    addRoot(
      path.join(home, "Library", "Application Support", "Code", "User", "workspaceStorage"),
      "stable",
      "VS Code"
    );
    addRoot(
      path.join(home, "Library", "Application Support", "Code - Insiders", "User", "workspaceStorage"),
      "insiders",
      "VS Code Insiders"
    );
  } else if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) {
      addRoot(path.join(appData, "Code", "User", "workspaceStorage"), "stable", "VS Code");
      addRoot(
        path.join(appData, "Code - Insiders", "User", "workspaceStorage"),
        "insiders",
        "VS Code Insiders"
      );
    }
  } else {
    addRoot(path.join(home, ".config", "Code", "User", "workspaceStorage"), "stable", "VS Code");
    addRoot(
      path.join(home, ".config", "Code - Insiders", "User", "workspaceStorage"),
      "insiders",
      "VS Code Insiders"
    );
  }

  for (const [index, root] of additionalRoots.entries()) {
    addRoot(root.replace(/^~/, home), `custom-${index + 1}`, "Custom storage");
  }
  return [...roots.values()];
}

function detectProductFromPath(value) {
  return value.includes("Code - Insiders") ? "insiders" : "stable";
}

function productLabel(productId) {
  if (productId === "insiders") {
    return "VS Code Insiders";
  }
  if (productId === "stable") {
    return "VS Code";
  }
  return "Current VS Code";
}

function workspaceUri(workspace) {
  if (workspace.workspaceUri) {
    return workspace.workspaceUri;
  }
  return workspace.workspacePath ? pathToFileURL(workspace.workspacePath).toString() : undefined;
}

module.exports = {
  defaultStorageRoots,
  discoverSessionFiles,
  parseJsonWithComments,
  parseJsonLines,
  readSessionFile,
  refreshSession,
  scanStorageRoots,
  sessionWordCount,
  sessionWordCounts,
  summarizeSessionCandidate,
  workspaceUri
};
