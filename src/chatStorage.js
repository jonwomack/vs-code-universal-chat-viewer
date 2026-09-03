"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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

function parseJsonLines(text) {
  let state;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const record = JSON.parse(line);
    if (record.kind === 0) {
      state = record.v;
    } else if (record.kind === 1 && state !== undefined) {
      state = setAtPath(state, record.k || [], record.v);
    } else if (record.kind === 2 && state !== undefined) {
      state = appendAtPath(state, record.k || [], record.v);
    }
  }
  return state;
}

async function readSessionFile(filePath) {
  const text = await fs.promises.readFile(filePath, "utf8");
  if (filePath.endsWith(".jsonl")) {
    return parseJsonLines(text);
  }
  return JSON.parse(text);
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
    let exists = Boolean(uri);
    if (fsPath) {
      try {
        await fs.promises.access(fsPath, fs.constants.F_OK);
      } catch {
        exists = false;
      }
    }
    return { name, uri, fsPath, exists };
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

async function summarizeSession(data, filePath, storageDirectory, workspace, source) {
  const stats = await fs.promises.stat(filePath);
  const requests = Array.isArray(data?.requests) ? data.requests : [];
  const firstPrompt = requests.find((request) => request?.message?.text)?.message.text.trim();
  const id = data?.sessionId || path.basename(filePath, path.extname(filePath));
  const createdAt = Number(data?.creationDate) || stats.birthtimeMs || stats.mtimeMs;
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
    workspaceExists: workspace.exists,
    sourceProduct: source.id,
    sourceLabel: source.label,
    storageDirectory,
    filePath,
    createdAt,
    modifiedAt: stats.mtimeMs,
    messageCount: requests.length,
    searchableText: [
      data?.customTitle,
      workspace.name,
      source.label,
      ...messages.flatMap((message) => [message.prompt, message.response])
    ].filter(Boolean).join("\n").toLowerCase(),
    messages
  };
}

function truncate(value, maximum) {
  const normalized = String(value).replace(/\s+/g, " ").trim();
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 1)}...` : normalized;
}

async function scanStorageRoots(storageRoots) {
  const sessions = [];
  const errors = [];
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
      try {
        await fs.promises.access(chatsDirectory, fs.constants.R_OK);
      } catch (error) {
        if (error.code !== "ENOENT") {
          errors.push(`${chatsDirectory}: ${error.message}`);
        }
        return;
      }

      const workspace = await readWorkspace(storageDirectory);
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
          const data = await readSessionFile(realPath);
          if (data) {
            sessions.push(await summarizeSession(
              data,
              realPath,
              chatsDirectory,
              workspace,
              source
            ));
          }
        } catch (error) {
          errors.push(`${filePath}: ${error.message}`);
        }
      }));
    }));
  }));

  sessions.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return { sessions, errors };
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
  parseJsonLines,
  readSessionFile,
  scanStorageRoots,
  workspaceUri
};
