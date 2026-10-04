"use strict";

const path = require("node:path");

function normalizeLocalWorkspacePath(uri, platform = process.platform) {
  if (!uri || (uri.scheme !== "file" && uri.scheme !== "untitled") || !uri.fsPath) {
    return undefined;
  }

  if (platform === "win32") {
    if (!path.win32.isAbsolute(uri.fsPath)) {
      return undefined;
    }
    return removeTrailingSeparator(path.win32.normalize(uri.fsPath), path.win32)
      .toLowerCase();
  }
  if (!path.isAbsolute(uri.fsPath)) {
    return undefined;
  }
  return removeTrailingSeparator(path.normalize(uri.fsPath), path);
}

function removeTrailingSeparator(value, pathApi) {
  const root = pathApi.parse(value).root;
  let normalized = value;
  while (normalized.length > root.length && normalized.endsWith(pathApi.sep)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function matchesUntitledWorkspace(target, workspaceFile, platform) {
  if (target?.scheme !== "file" || workspaceFile?.scheme !== "untitled") {
    return false;
  }

  const targetPath = normalizeLocalWorkspacePath(target, platform);
  if (!targetPath) {
    return false;
  }

  const pathApi = platform === "win32" ? path.win32 : path;
  if (pathApi.basename(targetPath).toLowerCase() !== "workspace.json") {
    return false;
  }

  const workspaceId = path.posix.basename(
    String(workspaceFile.path || workspaceFile.fsPath || "").replaceAll("\\", "/")
  );
  const targetId = pathApi.basename(pathApi.dirname(targetPath));
  return platform === "win32"
    ? workspaceId.toLowerCase() === targetId.toLowerCase()
    : workspaceId === targetId;
}

function normalizedUriString(value, platform) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "file:") {
      return value;
    }

    let fsPath = decodeURIComponent(parsed.pathname);
    if (platform === "win32") {
      if (/^\/[a-z]:/i.test(fsPath)) {
        fsPath = fsPath.slice(1);
      }
      if (parsed.hostname) {
        fsPath = `\\\\${parsed.hostname}${fsPath}`;
      }
      return removeTrailingSeparator(
        path.win32.normalize(fsPath.replaceAll("/", "\\")),
        path.win32
      ).toLowerCase();
    }
    return removeTrailingSeparator(path.normalize(fsPath), path);
  } catch {
    return platform === "win32" ? value.toLowerCase() : value;
  }
}

function sameStoredWorkspaceUri(left, right, platform = process.platform) {
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }

  const normalizedLeft = normalizedUriString(left, platform);
  const normalizedRight = normalizedUriString(right, platform);
  return normalizedLeft === normalizedRight;
}

function isCurrentWorkspaceUri(target, workspaceFile, workspaceFolders = [], platform = process.platform) {
  if (!target) {
    return false;
  }

  const targetValue = target.toString();
  if (workspaceFile?.toString() === targetValue) {
    return true;
  }

  if (matchesUntitledWorkspace(target, workspaceFile, platform)) {
    return true;
  }

  const targetPath = normalizeLocalWorkspacePath(target, platform);
  if (
    targetPath
    && normalizeLocalWorkspacePath(workspaceFile, platform) === targetPath
  ) {
    return true;
  }

  if (workspaceFile) {
    return false;
  }

  return workspaceFolders.some((folder) => {
    const uri = folder.uri || folder;
    return uri?.toString() === targetValue
      || (
        targetPath
        && normalizeLocalWorkspacePath(uri, platform) === targetPath
      );
  });
}

function deduplicateHandoffs(items, platform = process.platform) {
  const unique = new Map();
  for (const item of items) {
    if (!item) {
      continue;
    }
    const key = [
      item.product || "",
      item.id || "",
      normalizedUriString(String(item.workspaceUri || ""), platform)
    ].join("\0");
    unique.set(key, item);
  }
  return [...unique.values()];
}

module.exports = {
  deduplicateHandoffs,
  isCurrentWorkspaceUri,
  normalizeLocalWorkspacePath,
  normalizedUriString,
  sameStoredWorkspaceUri
};
