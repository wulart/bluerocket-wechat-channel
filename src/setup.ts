/**
 * WeChat QR Login Setup — standalone tool
 *
 * Run before starting the channel to authenticate with WeChat:
 *   npx bluerocket-wechat-channel setup
 */

import {
  loadCredentials,
  saveCredentials,
  doQRLogin,
  log,
  logError,
} from "./wechat.js";

async function main() {
  const existing = loadCredentials();
  if (existing) {
    log(`已有保存的账号: ${existing.accountId}`);
    log(`保存时间: ${existing.savedAt}`);
    console.log();

    const readline = await import("node:readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await new Promise<string>((resolve) => {
      rl.question("是否重新登录？(y/N) ", resolve);
    });
    rl.close();
    if (answer.toLowerCase() !== "y") {
      log("保持现有凭据，退出。");
      process.exit(0);
    }
  }

  const account = await doQRLogin();
  if (!account) {
    logError("登录失败。");
    process.exit(1);
  }

  console.log();
  log(`账号 ID: ${account.accountId}`);
  log(`用户 ID: ${account.userId ?? "N/A"}`);
  log(`凭据保存至: 已保存`);
  console.log();
  console.log("现在可以启动 BlueRocket 微信通道：");
  console.log("  npx bluerocket-wechat-channel start");
}

main().catch((err) => {
  logError(`${String(err)}`);
  process.exit(1);
});
