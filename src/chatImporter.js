"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { sameStoredWorkspaceUri } = require("./workspaceIdentity");

async function findWorkspaceStorageDirectory(storageRoot, workspaceUri, platform = process.platform) {
  let entries;
  try {
    entries = await fs.promises.readdir(storageRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const matches = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const storageDirectory = path.join(storageRoot, entry.name);
      try {
        const metadata = JSON.parse(
          await fs.promises.readFile(path.join(storageDirectory, "workspace.json"), "utf8")
        );
        const storedUri = metadata.folder || metadata.workspace;
        return sameStoredWorkspaceUri(storedUri, workspaceUri, platform)
          ? storageDirectory
          : undefined;
      } catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError) {
          return undefined;
        }
        throw error;
      }
    }));
  return matches.find(Boolean);
}

async function importChatSession(sourceFile, destinationStorageDirectory) {
  const chatsDirectory = path.join(destinationStorageDirectory, "chatSessions");
  const destinationFile = path.join(chatsDirectory, path.basename(sourceFile));
  await fs.promises.mkdir(chatsDirectory, { recursive: true });

  try {
    if (await filesMatch(sourceFile, destinationFile)) {
      return { destinationFile, copied: false };
    }

    throw new Error(
      `A different chat transcript already exists at ${destinationFile}. Nothing was overwritten.`
    );
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await fs.promises.copyFile(
      sourceFile,
      destinationFile,
      fs.constants.COPYFILE_EXCL
    );
  } catch (error) {
    if (error.code === "EEXIST") {
      if (await filesMatch(sourceFile, destinationFile)) {
        return { destinationFile, copied: false };
      }
      throw new Error(
        `A different chat transcript already exists at ${destinationFile}. Nothing was overwritten.`
      );
    }
    throw error;
  }

  return { destinationFile, copied: true };
}

async function moveChatSession(sourceFile, destinationStorageDirectory) {
  const result = await importChatSession(sourceFile, destinationStorageDirectory);
  if (path.resolve(sourceFile) === path.resolve(result.destinationFile)) {
    throw new Error("The source and destination chat transcript are the same file.");
  }
  if (!await filesMatch(sourceFile, result.destinationFile)) {
    if (result.copied) {
      await fs.promises.unlink(result.destinationFile);
    }
    throw new Error("The copied chat transcript could not be verified; the original was kept.");
  }
  await fs.promises.utimes(result.destinationFile, new Date(), new Date());
  await fs.promises.unlink(sourceFile);
  return { ...result, moved: true };
}

async function filesMatch(left, right) {
  const [leftStats, rightStats] = await Promise.all([
    fs.promises.stat(left),
    fs.promises.stat(right)
  ]);
  if (leftStats.size !== rightStats.size) {
    return false;
  }
  const [leftHash, rightHash] = await Promise.all([hashFile(left), hashFile(right)]);
  return leftHash === rightHash;
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

module.exports = {
  findWorkspaceStorageDirectory,
  importChatSession,
  moveChatSession
};
