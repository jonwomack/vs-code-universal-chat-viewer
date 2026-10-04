"use strict";

const path = require("node:path");
const { fileURLToPath } = require("node:url");

const LOCATION_KEY = /(uri|path|file|folder|resource|location|directory|cwd|workingdirectory)/i;
const MAX_RECOVERY_PATH_BYTES = 4096;
const UNAVAILABLE_PATH_ERROR_CODES = new Set([
  "ENOENT",
  "ENOTDIR",
  "EINVAL",
  "ENAMETOOLONG",
  "ERR_UNC_HOST_NOT_ALLOWED"
]);

function isPlausibleLocalPath(candidate, platform) {
  if (
    typeof candidate !== "string"
    || !candidate
    || Buffer.byteLength(candidate, "utf8") > MAX_RECOVERY_PATH_BYTES
    || /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    return false;
  }

  if (platform !== "win32") {
    return true;
  }
  const withoutDrive = /^[a-z]:/i.test(candidate) ? candidate.slice(2) : candidate;
  return !/[<>:"|?*]/.test(withoutDrive);
}

function isUnavailableRecoveryPathError(error) {
  return Boolean(error && UNAVAILABLE_PATH_ERROR_CODES.has(error.code));
}

function uriComponentsToString(value) {
  if (!value || typeof value !== "object" || !value.scheme || typeof value.path !== "string") {
    return undefined;
  }
  const authority = value.authority ? `//${value.authority}` : value.scheme === "file" ? "//" : "";
  return `${value.scheme}:${authority}${value.path}`;
}

function normalizeLocalPath(value, platform, basePath) {
  let candidate = value;
  if (candidate && typeof candidate === "object") {
    candidate = uriComponentsToString(candidate);
  }
  if (typeof candidate !== "string" || !candidate) {
    return undefined;
  }

  try {
    if (candidate.startsWith("file:")) {
      if (platform === "win32") {
        const uri = new URL(candidate);
        let uriPath = decodeURIComponent(uri.pathname);
        if (/^\/[a-z]:/i.test(uriPath)) {
          uriPath = uriPath.slice(1);
        }
        candidate = uri.hostname
          ? `\\\\${uri.hostname}${uriPath.replaceAll("/", "\\")}`
          : uriPath.replaceAll("/", "\\");
      } else {
        candidate = fileURLToPath(candidate);
      }
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(candidate) && !/^[a-z]:[\\/]/i.test(candidate)) {
      return undefined;
    } else if (!path.posix.isAbsolute(candidate) && !path.win32.isAbsolute(candidate)) {
      if (!basePath) {
        return undefined;
      }
      candidate = platform === "win32"
        ? path.win32.resolve(basePath, candidate)
        : path.resolve(basePath, candidate);
    }
  } catch {
    return undefined;
  }

  if (!isPlausibleLocalPath(candidate, platform)) {
    return undefined;
  }
  const pathApi = platform === "win32" ? path.win32 : path;
  const normalized = pathApi.normalize(candidate).replace(/[\\/]+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeRemoteUri(value) {
  let candidate = value;
  if (candidate && typeof candidate === "object") {
    candidate = uriComponentsToString(candidate);
  }
  if (typeof candidate !== "string" || !/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    return undefined;
  }
  try {
    const uri = new URL(candidate);
    if (uri.protocol === "file:") {
      return undefined;
    }
    const pathname = uri.pathname.replace(/\/+$/, "");
    return `${uri.protocol.toLowerCase()}//${uri.host.toLowerCase()}${pathname}`;
  } catch {
    return undefined;
  }
}

function isWithin(candidate, root, separator) {
  return candidate === root || candidate.startsWith(`${root}${separator}`);
}

function createRootState(folder, index, platform) {
  return {
    folder,
    index,
    localPath: normalizeLocalPath(folder.uri || folder.location, platform),
    remoteUri: normalizeRemoteUri(folder.uri || folder.location),
    required: false,
    turns: new Set(),
    categories: new Set()
  };
}

function findRoot(value, roots, platform, basePath) {
  const local = normalizeLocalPath(value, platform, basePath);
  if (local) {
    const separator = platform === "win32" ? "\\" : "/";
    return roots
      .filter((root) => root.localPath && isWithin(local, root.localPath, separator))
      .sort((left, right) => right.localPath.length - left.localPath.length)[0];
  }

  const remote = normalizeRemoteUri(value);
  if (remote) {
    return roots
      .filter((root) => root.remoteUri && isWithin(remote, root.remoteUri, "/"))
      .sort((left, right) => right.remoteUri.length - left.remoteUri.length)[0];
  }
  return undefined;
}

function recordLocation(value, roots, platform, basePath, category, turn, required = false) {
  const root = findRoot(value, roots, platform, basePath);
  if (!root) {
    return;
  }
  root.categories.add(category);
  if (Number.isInteger(turn)) {
    root.turns.add(turn);
  }
  if (required) {
    root.required = true;
  }
}

function scanLocations(value, roots, options, seen = new Set(), locationHint = false) {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    if (
      locationHint
      || value.startsWith("file:")
      || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
      || path.posix.isAbsolute(value)
      || path.win32.isAbsolute(value)
    ) {
      recordLocation(
        value,
        roots,
        options.platform,
        options.basePath,
        options.category,
        options.turn
      );
    }
    return;
  }
  if (typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);

  const uri = uriComponentsToString(value);
  if (uri) {
    recordLocation(
      uri,
      roots,
      options.platform,
      options.basePath,
      options.category,
      options.turn
    );
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      scanLocations(item, roots, options, seen, locationHint);
    }
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    scanLocations(
      nested,
      roots,
      options,
      seen,
      locationHint || LOCATION_KEY.test(key)
    );
  }
}

function analyzeWorkspaceUsage(data, workspaceFolders, platform = process.platform) {
  const roots = workspaceFolders.map((folder, index) =>
    createRootState(folder, index, platform)
  );
  const workingDirectory = data?.workingDirectory;
  const workingDirectoryPath = normalizeLocalPath(workingDirectory, platform);
  if (workingDirectory) {
    recordLocation(
      workingDirectory,
      roots,
      platform,
      workingDirectoryPath,
      "Working directory",
      undefined,
      true
    );
  }

  const requests = Array.isArray(data?.requests) ? data.requests : [];
  requests.forEach((request, turn) => {
    const options = { roots, platform, basePath: workingDirectoryPath, turn };
    const sources = [
      ["Attached context", request?.variableData],
      ["Edited files", request?.editedFileEvents],
      ["Used context", request?.usedContext],
      ["References", request?.contentReferences],
      ["Code citations", request?.codeCitations],
      ["Tool activity", Array.isArray(request?.response)
        ? request.response.filter((part) =>
          part && typeof part === "object"
          && part.kind !== "markdownContent"
          && part.kind !== "markdownVuln"
          && part.kind !== "thinking"
        )
        : undefined],
      ["Result metadata", request?.result]
    ];
    for (const [category, value] of sources) {
      scanLocations(value, roots, { ...options, category });
    }
  });

  const hasObservedUsage = roots.some((root) => root.required || root.turns.size > 0);
  return roots.map((root) => ({
    folder: root.folder,
    required: root.required,
    turnCount: root.turns.size,
    categories: [...root.categories],
    recommended: hasObservedUsage
      ? root.required || root.turns.size > 0
      : true
  }));
}

function recoveryLocationPaths(data, platform = process.platform) {
  const found = new Set();
  const workingDirectory = normalizeLocalPath(data?.workingDirectory, platform);
  if (workingDirectory) {
    found.add(workingDirectory);
  }

  const visit = (value, seen = new Set(), locationHint = false) => {
    if (typeof value === "string") {
      if (
        locationHint
        || value.startsWith("file:")
        || path.posix.isAbsolute(value)
        || path.win32.isAbsolute(value)
      ) {
        const normalized = normalizeLocalPath(value, platform, workingDirectory);
        if (normalized) {
          found.add(normalized);
        }
      }
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) {
      return;
    }
    seen.add(value);
    const uri = uriComponentsToString(value);
    if (uri) {
      const normalized = normalizeLocalPath(uri, platform, workingDirectory);
      if (normalized) {
        found.add(normalized);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, seen, locationHint);
      }
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      visit(nested, seen, locationHint || LOCATION_KEY.test(key));
    }
  };

  for (const request of Array.isArray(data?.requests) ? data.requests : []) {
    visit({
      variableData: request?.variableData,
      editedFileEvents: request?.editedFileEvents,
      usedContext: request?.usedContext,
      contentReferences: request?.contentReferences,
      codeCitations: request?.codeCitations,
      response: request?.response,
      result: request?.result
    });
  }
  return [...found];
}

module.exports = {
  analyzeWorkspaceUsage,
  isUnavailableRecoveryPathError,
  normalizeLocalPath,
  normalizeRemoteUri,
  recoveryLocationPaths
};
