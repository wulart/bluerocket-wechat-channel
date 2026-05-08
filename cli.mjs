#!/usr/bin/env node

/**
 * BlueRocket WeChat Channel — CLI entry point
 *
 * Usage:
 *   npx bluerocket-wechat-channel setup   — WeChat QR login
 *   npx bluerocket-wechat-channel start   — Start channel server
 *   npx bluerocket-wechat-channel help    — Show help
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(__dirname, "dist");

function getRuntime() {
  try {
    return execSync("which bun", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return process.execPath;
  }
}

function runScript(script, args = []) {
  const scriptPath = resolve(DIST_DIR, script);
  if (!existsSync(scriptPath)) {
    console.error(`Error: ${scriptPath} not found. Run 'npm run build' first.`);
    process.exit(1);
  }
  const runtime = getRuntime();
  const result = spawnSync(runtime, [scriptPath, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

function help() {
  console.log(`
  BlueRocket WeChat Channel

  Usage: npx bluerocket-wechat-channel <command>

  Commands:
    setup     WeChat QR login (scan to authenticate)
    start     Start the channel server (connects WeChat to BlueRocket)
    help      Show this help message

  Quick Start:
    1. Start BlueRocket desktop app
    2. npx bluerocket-wechat-channel setup
    3. npx bluerocket-wechat-channel start
`);
}

const command = process.argv[2];

switch (command) {
  case "setup":
    runScript("setup.js");
    break;
  case "start":
    runScript("index.js");
    break;
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  default:
    if (command) {
      console.error(`Unknown command: ${command}`);
    }
    help();
    process.exit(command ? 1 : 0);
}
