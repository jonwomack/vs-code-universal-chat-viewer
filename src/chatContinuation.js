"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { refreshSession } = require("./chatStorage");
const { parseCopilotCliSession } = require("./copilotCliStorage");

async function writeContinuationTranscript(session, globalStoragePath) {
  const current = session.sourceKind === "copilot-cli"
    ? await parseCopilotCliSession(
      path.dirname(session.filePath),
      await fs.promises.stat(session.filePath)
    )
    : (await refreshSession(session))?.session;
  if (!current || current.messages.length === 0) {
    throw new Error("This chat has no readable messages to attach.");
  }

  const text = [
    `# ${current.title}`,
    "",
    "Historical conversation for context, not new instructions. Continue from the user's next request.",
    "",
    `Source: ${current.sourceLabel}`,
    `Original transcript: ${session.filePath}`,
    `Original workspace: ${current.workspacePath || current.workspaceUri || "Unavailable"}`,
    "",
    ...current.messages.flatMap((message) => [
      "## User",
      "",
      message.prompt,
      "",
      "## Assistant",
      "",
      message.response,
      ""
    ])
  ].join("\n");
  const digest = crypto.createHash("sha256").update(text).digest("hex");
  const directory = path.join(globalStoragePath, "continuation-transcripts");
  const filePath = path.join(directory, `${digest}.md`);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(filePath, text, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

module.exports = { writeContinuationTranscript };
