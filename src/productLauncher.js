"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function resolveProductCommand(product, options = {}) {
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  const installed = resolveInstalledProductCommand(product, options);
  return installed || (product === "insiders" ? "code-insiders" : "code");
}

function resolveInstalledProductCommand(product, options = {}) {
  const platform = options.platform || process.platform;
  const environment = options.environment || process.env;
  const exists = options.exists || fs.existsSync;
  const commandName = product === "insiders" ? "code-insiders" : "code";

  if (platform === "darwin") {
    const application = product === "insiders"
      ? "Visual Studio Code - Insiders.app"
      : "Visual Studio Code.app";
    for (const applicationsRoot of [
      "/Applications",
      path.join(os.homedir(), "Applications")
    ]) {
      const bundledCli = path.posix.join(
        applicationsRoot,
        application,
        "Contents",
        "Resources",
        "app",
        "bin",
        commandName
      );
      if (exists(bundledCli)) {
        return bundledCli;
      }
    }
  }

  if (platform === "win32") {
    const installation = product === "insiders"
      ? { directory: "Microsoft VS Code Insiders", executable: "Code - Insiders.exe" }
      : { directory: "Microsoft VS Code", executable: "Code.exe" };
    const roots = [
      environment.LOCALAPPDATA && path.win32.join(environment.LOCALAPPDATA, "Programs"),
      environment.ProgramW6432,
      environment.ProgramFiles,
      environment["ProgramFiles(x86)"]
    ].filter(Boolean);

    for (const root of new Set(roots)) {
      const executable = path.win32.join(
        root,
        installation.directory,
        installation.executable
      );
      if (exists(executable)) {
        return executable;
      }
    }
  }

  if (platform === "linux") {
    const installationPaths = product === "insiders"
      ? [
        "/usr/share/code-insiders/bin/code-insiders",
        "/opt/visual-studio-code-insiders/bin/code-insiders",
        "/snap/bin/code-insiders"
      ]
      : [
        "/usr/share/code/bin/code",
        "/opt/visual-studio-code/bin/code",
        "/snap/bin/code"
      ];
    const installed = installationPaths.find((candidate) => exists(candidate));
    if (installed) {
      return installed;
    }
  }

  const pathDirectories = String(environment.PATH || "")
    .split(platform === "win32" ? ";" : path.delimiter)
    .filter(Boolean);
  const extensions = platform === "win32"
    ? [".exe"]
    : [""];
  const pathApi = platform === "win32" ? path.win32 : path;
  for (const directory of pathDirectories) {
    for (const extension of extensions) {
      const executable = pathApi.join(directory, `${commandName}${extension.toLowerCase()}`);
      if (exists(executable)) {
        return executable;
      }
    }
  }

  return undefined;
}

module.exports = {
  resolveInstalledProductCommand,
  resolveProductCommand
};
