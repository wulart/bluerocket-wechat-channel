/**
 * OpenCode WeChat Channel
 *
 * Bridges WeChat messages to an OpenCode AI coding agent (BlueRocket desktop app).
 * Discovers the desktop app's server via ~/.opencode/server.json.
 *
 * Flow:
 *   1. Read server credentials from ~/.opencode/server.json
 *   2. QR login (or load saved WeChat credentials)
 *   3. Long-poll WeChat for incoming messages
 *   4. For each user: create/find an OpenCode session, send prompt, reply with response
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createOpencodeClient } from "@opencode-ai/sdk";
import {
  type AccountData,
  type InboundMessage,
  loadCredentials,
  doQRLogin,
  startPolling,
  sendTextMessage,
  getCachedContextToken,
  startTypingKeepalive,
  log,
  logError,
} from "./wechat.js";

// ── Server discovery ────────────────────────────────────────────────────────

interface ServerInfo {
  url: string;
  username: string;
  password: string;
}

function loadServerInfo(): ServerInfo {
  const serverInfoPath = path.join(os.homedir(), ".opencode", "server.json");
  if (!fs.existsSync(serverInfoPath)) {
    logError("未找到 BlueRocket 服务器信息。请先启动 BlueRocket 桌面应用。");
    logError(`期望文件: ${serverInfoPath}`);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(serverInfoPath, "utf-8")) as ServerInfo;
  } catch (err) {
    logError(`读取服务器信息失败: ${String(err)}`);
    process.exit(1);
  }
}

function createClient(serverInfo: ServerInfo) {
  const authHeader =
    "Basic " + Buffer.from(`${serverInfo.username}:${serverInfo.password}`).toString("base64");

  return createOpencodeClient({
    baseUrl: serverInfo.url,
    fetch: (request: Request) => {
      const headers = new Headers(request.headers);
      headers.set("Authorization", authHeader);
      return fetch(new Request(request, { headers }));
    },
  });
}

// ── Session state ───────────────────────────────────────────────────────────

const sessions = new Map<string, string>();

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Discover OpenCode server from desktop app
  log("正在连接 BlueRocket 桌面应用...");
  const serverInfo = loadServerInfo();
  const client = createClient(serverInfo);

  // Verify connection
  const authHeader = "Basic " + Buffer.from(`${serverInfo.username}:${serverInfo.password}`).toString("base64");
  try {
    const health = await fetch(`${serverInfo.url}/global/health`, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(5000),
    });
    if (!health.ok) throw new Error(`health check returned ${health.status}`);
    log(`已连接到 BlueRocket 服务器: ${serverInfo.url}`);
  } catch (err) {
    logError(`无法连接 BlueRocket 服务器: ${String(err)}`);
    logError("请确认 BlueRocket 桌面应用正在运行。");
    process.exit(1);
  }

  // 2. Authenticate with WeChat
  let account: AccountData | null = loadCredentials();

  if (!account) {
    log("未找到已保存的凭据，启动微信扫码登录...");
    account = await doQRLogin();
    if (!account) {
      logError("登录失败，退出。");
      process.exit(1);
    }
  } else {
    log(`使用已保存账号: ${account.accountId}`);
  }

  // 3. Subscribe to OpenCode events for tool activity (auto-reconnect)
  ;(async function subscribeEvents() {
    while (true) {
      try {
        const events = await client.event.subscribe();
        for await (const event of events.stream) {
          if (event.type === "message.part.updated") {
            const part = event.properties.part as any;
            if (part?.type === "tool" && part.state?.status === "completed") {
              log(`[tool] ${part.tool} — ${part.state.title ?? ""}`);
            }
          }
        }
        log("事件流结束，正在重连...");
      } catch (err) {
        logError(`事件订阅异常: ${String(err)}，5s 后重连`);
      }
      await new Promise(r => setTimeout(r, 5000));
    }
  })();

  // 4. Start polling WeChat and handling messages
  await startPolling(account, async (msg: InboundMessage) => {
    if (!msg.canReply) {
      log(`跳过无法回复的消息: from=${msg.senderShort}`);
      return;
    }

    const sessionKey = msg.isGroup && msg.groupId
      ? `group:${msg.groupId}`
      : `dm:${msg.senderId}`;

    // Get or create an OpenCode session for this conversation
    let sessionId = sessions.get(sessionKey);

    if (!sessionId) {
      log(`创建 BlueRocket 会话: ${sessionKey}`);
      try {
        const createResult = await client.session.create({
          body: { title: `WeChat ${sessionKey}` },
        });

        if (createResult.error) {
          logError(`创建会话失败: ${JSON.stringify(createResult.error)}`);
          return;
        }

        sessionId = createResult.data.id!;
        sessions.set(sessionKey, sessionId);
        log(`会话已创建: ${sessionId}`);
      } catch (err) {
        logError(`创建会话异常: ${String(err)}`);
        return;
      }
    }

    // Send the user's message as a prompt
    log(`发送到 BlueRocket: "${msg.text.slice(0, 60)}"`);
    const contextToken = getCachedContextToken(msg.senderId);
    const typing = contextToken
      ? startTypingKeepalive(account!.baseUrl, account!.token, msg.senderId, contextToken)
      : null;
    try {
      const result = await client.session.prompt({
        path: { id: sessionId },
        body: { parts: [{ type: "text" as const, text: msg.text }] },
      });

      if (result.error) {
        logError(`BlueRocket 响应错误: ${JSON.stringify(result.error)}`);
        if (contextToken) {
          await sendTextMessage(
            account!.baseUrl,
            account!.token,
            msg.senderId,
            "抱歉，处理消息时出了问题，请重试。",
            contextToken,
          );
        }
        return;
      }

      // Extract response text from the assistant message
      const response = result.data as any;
      const responseText =
        response.parts
          ?.filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n") ||
        response.info?.text ||
        "我收到了你的消息，但没有生成回复。";

      // Strip markdown for WeChat (plain text only)
      const plainText = stripMarkdown(responseText);

      log(`回复微信 (${plainText.length} 字): "${plainText.slice(0, 60)}"`);

      if (!contextToken) {
        logError(`无 context_token，无法回复: senderId=${msg.senderId}`);
        return;
      }
      try {
        // Split long messages (WeChat has ~4096 char limit per message)
        const chunks = splitMessage(plainText, 3500);
        for (const chunk of chunks) {
          await sendTextMessage(
            account!.baseUrl,
            account!.token,
            msg.senderId,
            chunk,
            contextToken,
          );
        }
        log("微信回复已发送");
      } catch (sendErr) {
        logError(`微信发送失败: ${String(sendErr)}`);
      }
    } catch (err) {
      logError(`处理消息异常: ${String(err)}`);
    } finally {
      typing?.stop();
    }
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function stripMarkdown(text: string): string {
  return text
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, (match) => {
      return match.replace(/```\w*\n?/g, "").trim();
    })
    // Remove inline code
    .replace(/`([^`]+)`/g, "$1")
    // Remove bold
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    // Remove italic
    .replace(/\*([^*]+)\*/g, "$1")
    // Remove links [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Remove headings
    .replace(/^#{1,6}\s+/gm, "")
    // Remove horizontal rules
    .replace(/^---+$/gm, "")
    .trim();
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

main().catch((err) => {
  logError(`Fatal: ${String(err)}`);
  process.exit(1);
});
