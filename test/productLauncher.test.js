"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveInstalledProductCommand,
  resolveProductCommand
} = require("../src/productLauncher");

test("resolves a per-user Windows Stable installation", () => {
  const expected = "C:\\Users\\jon\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe";
  const command = resolveProductCommand("stable", {
    platform: "win32",
    environment: {
      LOCALAPPDATA: "C:\\Users\\jon\\AppData\\Local",
      ProgramFiles: "C:\\Program Files"
    },
    exists: (candidate) => candidate === expected
  });

  assert.equal(command, expected);
});

test("resolves a system Windows Insiders installation", () => {
  const expected = "C:\\Program Files\\Microsoft VS Code Insiders\\Code - Insiders.exe";
  const command = resolveProductCommand("insiders", {
    platform: "win32",
    environment: {
      LOCALAPPDATA: "C:\\Users\\jon\\AppData\\Local",
      ProgramFiles: "C:\\Program Files"
    },
    exists: (candidate) => candidate === expected
  });

  assert.equal(command, expected);
});

test("falls back to the product CLI for portable installations", () => {
  assert.equal(resolveProductCommand("stable", {
    platform: "win32",
    environment: {},
    exists: () => false
  }), "code");
  assert.equal(resolveProductCommand("insiders", {
    platform: "linux",
    environment: {},
    exists: () => false
  }), "code-insiders");
});

test("finds a Windows Store or portable executable on PATH", () => {
  const expected = "C:\\Users\\jon\\AppData\\Local\\Microsoft\\WindowsApps\\code.exe";
  assert.equal(resolveInstalledProductCommand("stable", {
    platform: "win32",
    environment: {
      PATH: "C:\\tools;C:\\Users\\jon\\AppData\\Local\\Microsoft\\WindowsApps"
    },
    exists: (candidate) => candidate === expected
  }), expected);
});

test("reports an unavailable counterpart product", () => {
  assert.equal(resolveInstalledProductCommand("insiders", {
    platform: "win32",
    environment: {},
    exists: () => false
  }), undefined);
});

test("finds a Linux installation outside PATH", () => {
  assert.equal(resolveInstalledProductCommand("stable", {
    platform: "linux",
    environment: {},
    exists: (candidate) => candidate === "/usr/share/code/bin/code"
  }), "/usr/share/code/bin/code");
});
