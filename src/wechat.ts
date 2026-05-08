/**
 * WeChat ilink API layer
 *
 * Provides QR login, message polling, text/image sending,
 * typing indicators, and context token caching.
 * Extracted from claude-code-wechat-channel for reuse with OpenCode SDK.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";
export const CREDENTIALS_DIR = path.join(
  os.homedir(),
  ".opencode",
  "channels",
  "wechat",
);
export const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, "account.json");

const LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

// ── Logging ─────────────────────────────────────────────────────────────────

export function log(msg: string) {
  console.log(`[wechat] ${msg}`);
}

export function logError(msg: string) {
  console.error(`[wechat] ERROR: ${msg}`);
}

// ── Credentials ─────────────────────────────────────────────────────────────

export type AccountData = {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
};

export function loadCredentials(): AccountData | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) return null;
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
  } catch {
    return null;
  }
}

export function saveCredentials(data: AccountData): void {
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(CREDENTIALS_FILE, 0o600);
  } catch {
    // best-effort
  }
}

// ── WeChat ilink HTTP helpers ───────────────────────────────────────────────

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token?: string, body?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (body) {
    headers["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
  }
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
}): Promise<string> {
  const base = params.baseUrl.endsWith("/")
    ? params.baseUrl
    : `${params.baseUrl}/`;
  const url = new URL(params.endpoint, base).toString();
  const headers = buildHeaders(params.token, params.body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return text;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── AES-128-ECB crypto (CDN media) ─────────────────────────────────────────

function encryptAesEcb(data: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function decryptAesEcb(data: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// ── Image download ──────────────────────────────────────────────────────────

const IMAGE_TMP_DIR = path.join(CREDENTIALS_DIR, "tmp");

export async function downloadAndSaveImage(cdnUrl: string, aesKeyHex: string): Promise<string> {
  const res = await fetch(cdnUrl, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Image download failed: ${res.status}`);
  const encrypted = Buffer.from(await res.arrayBuffer());
  const key = Buffer.from(aesKeyHex, "hex");
  const decrypted = decryptAesEcb(encrypted, key);

  fs.mkdirSync(IMAGE_TMP_DIR, { recursive: true });
  const filePath = path.join(IMAGE_TMP_DIR, `img_${Date.now()}.jpg`);
  fs.writeFileSync(filePath, decrypted);
  return filePath;
}

// ── CDN media upload ────────────────────────────────────────────────────────

interface UploadUrlResp {
  upload_url?: string;
  media_id?: string;
  ret?: number;
}

async function getUploadUrl(
  baseUrl: string,
  token: string,
  toUserId: string,
  contextToken: string,
  mediaType: number,
  contentLength: number,
): Promise<UploadUrlResp> {
  const raw = await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      to_user_id: toUserId,
      context_token: contextToken,
      media_type: mediaType,
      content_length: contentLength,
      base_info: { channel_version: "1.0.0" },
    }),
    token,
    timeoutMs: 10_000,
  });
  return JSON.parse(raw) as UploadUrlResp;
}

async function uploadToCdn(
  uploadUrl: string,
  encryptedData: Buffer,
): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    body: new Uint8Array(encryptedData),
    headers: { "Content-Length": String(encryptedData.length) },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`CDN upload failed: ${res.status}`);
}

// ── Typing indicator (keepalive) ────────────────────────────────────────────

const TYPING_STATUS_TYPING = 1;
const TYPING_STATUS_CANCEL = 2;
const TYPING_KEEPALIVE_MS = 5_000;

const typingTicketCache = new Map<string, { ticket: string; expiresAt: number }>();

function cleanExpiredTypingTickets(): void {
  const now = Date.now();
  for (const [key, entry] of typingTicketCache) {
    if (now >= entry.expiresAt) typingTicketCache.delete(key);
  }
}

async function getTypingTicket(
  baseUrl: string,
  token: string,
  toUserId: string,
  contextToken: string,
): Promise<string | null> {
  cleanExpiredTypingTickets();
  const cached = typingTicketCache.get(toUserId);
  if (cached && Date.now() < cached.expiresAt) return cached.ticket;

  try {
    const raw = await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/getconfig",
      body: JSON.stringify({
        ilink_user_id: toUserId,
        context_token: contextToken,
        base_info: { channel_version: "1.0.0" },
      }),
      token,
      timeoutMs: 10_000,
    });
    const resp = JSON.parse(raw) as { typing_ticket?: string };
    const ticket = resp.typing_ticket ?? null;
    if (ticket) {
      typingTicketCache.set(toUserId, {
        ticket,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      });
    }
    return ticket;
  } catch {
    return null;
  }
}

async function sendTyping(
  baseUrl: string,
  token: string,
  toUserId: string,
  typingTicket: string,
  status: number,
): Promise<void> {
  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({
      ilink_user_id: toUserId,
      typing_ticket: typingTicket,
      status,
      base_info: { channel_version: "1.0.0" },
    }),
    token,
    timeoutMs: 5_000,
  });
}

export function startTypingKeepalive(
  baseUrl: string,
  token: string,
  toUserId: string,
  contextToken: string,
): { stop: () => void } {
  let stopped = false;
  let ticket: string | null = null;

  const send = async (status: number) => {
    if (!ticket) return;
    try {
      await sendTyping(baseUrl, token, toUserId, ticket, status);
    } catch {
      // best-effort
    }
  };

  // Fetch ticket then start typing
  getTypingTicket(baseUrl, token, toUserId, contextToken).then(async (t) => {
    ticket = t;
    if (ticket && !stopped) {
      await send(TYPING_STATUS_TYPING);
    }
  }).catch(() => {});

  // Keepalive: re-send every 5s so the indicator stays visible
  const interval = setInterval(() => {
    if (!stopped && ticket) {
      send(TYPING_STATUS_TYPING).catch(() => {});
    }
  }, TYPING_KEEPALIVE_MS);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      if (ticket) {
        send(TYPING_STATUS_CANCEL).catch(() => {});
      }
    },
  };
}

// ── QR Login ────────────────────────────────────────────────────────────────

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface QRStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

async function fetchQRCode(baseUrl: string): Promise<QRCodeResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
    base,
  );
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`);
  return (await res.json()) as QRCodeResponse;
}

async function pollQRStatus(
  baseUrl: string,
  qrcode: string,
): Promise<QRStatusResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    base,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch(url.toString(), {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`QR status failed: ${res.status}`);
    return (await res.json()) as QRStatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

export async function doQRLogin(baseUrl: string = DEFAULT_BASE_URL): Promise<AccountData | null> {
  log("正在获取微信登录二维码...");
  const qrResp = await fetchQRCode(baseUrl);

  log(`\n扫码链接（可复制到浏览器或用"从相册选取"扫描）:\n${qrResp.qrcode_img_content}\n`);

  try {
    const qrterm = await import("qrcode-terminal");
    await new Promise<void>((resolve) => {
      qrterm.default.generate(
        qrResp.qrcode_img_content,
        { small: true },
        (qr: string) => {
          console.log(qr);
          resolve();
        },
      );
    });
  } catch {
    // qrcode-terminal unavailable — URL above is sufficient
  }

  log("等待扫码...");
  const deadline = Date.now() + 480_000;
  let scannedPrinted = false;

  while (Date.now() < deadline) {
    const status = await pollQRStatus(baseUrl, qrResp.qrcode);

    switch (status.status) {
      case "wait":
        break;
      case "scaned":
        if (!scannedPrinted) {
          log("已扫码，请在微信中确认...");
          scannedPrinted = true;
        }
        break;
      case "expired":
        logError("二维码已过期，请重新启动。");
        return null;
      case "confirmed": {
        if (!status.ilink_bot_id || !status.bot_token) {
          logError("登录确认但未返回 bot 信息");
          return null;
        }
        const account: AccountData = {
          token: status.bot_token,
          baseUrl: status.baseurl || baseUrl,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          savedAt: new Date().toISOString(),
        };
        saveCredentials(account);
        log("微信连接成功！");
        return account;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  logError("登录超时");
  return null;
}

// ── WeChat Message Types ────────────────────────────────────────────────────

const MSG_TYPE_USER = 1;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;

const MSG_ITEM_TEXT = 1;
const MSG_ITEM_IMAGE = 2;
const MSG_ITEM_VOICE = 3;
const MSG_ITEM_FILE = 4;
const MSG_ITEM_VIDEO = 5;

interface TextItem { text?: string }
interface ImageMedia {
  full_url?: string;
  aes_key?: string;
  encrypt_query_param?: string;
}
interface ImageItem {
  aeskey?: string;
  media?: ImageMedia;
  mid_size?: number;
  thumb_width?: number;
  thumb_height?: number;
  hd_size?: number;
}
interface VoiceItem {
  text?: string;
  aes_key?: string;
  cdn_url?: string;
  duration_ms?: number;
}
interface FileItem {
  file_name?: string;
  file_size?: number;
  aes_key?: string;
  cdn_url?: string;
  media_id?: string;
}
interface VideoItem {
  aes_key?: string;
  cdn_url?: string;
  duration_ms?: number;
  thumb_cdn_url?: string;
  media_id?: string;
}
interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}
interface MessageItem {
  type?: number;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
  ref_msg?: RefMessage;
}
interface WeixinMessage {
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  create_time_ms?: number;
}
interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

// ── Message content extraction ──────────────────────────────────────────────

type ExtractedContent = {
  text: string;
  msgType: "text" | "voice" | "image" | "file" | "video" | "unknown";
  imageCdnUrl?: string;
  imageAesKey?: string;
};

function extractContent(msg: WeixinMessage): ExtractedContent | null {
  if (!msg.item_list?.length) return null;

  for (const item of msg.item_list) {
    switch (item.type) {
      case MSG_ITEM_TEXT: {
        if (!item.text_item?.text) continue;
        let text = item.text_item.text;
        if (item.ref_msg?.title) {
          text = `[引用: ${item.ref_msg.title}]\n${text}`;
        }
        return { text, msgType: "text" };
      }
      case MSG_ITEM_VOICE: {
        const transcript = item.voice_item?.text;
        if (transcript) {
          return { text: `[语音转文字] ${transcript}`, msgType: "voice" };
        }
        return { text: "[语音消息（无文字转录）]", msgType: "voice" };
      }
      case MSG_ITEM_IMAGE: {
        const img = item.image_item;
        const cdnUrl = img?.media?.full_url;
        const aesKey = img?.aeskey;
        const dims = img?.thumb_width && img?.thumb_height
          ? ` (${img.thumb_width}×${img.thumb_height})`
          : "";
        return {
          text: `[图片${dims}]`,
          msgType: "image",
          imageCdnUrl: cdnUrl,
          imageAesKey: aesKey,
        };
      }
      case MSG_ITEM_FILE: {
        const f = item.file_item;
        const name = f?.file_name ? ` "${f.file_name}"` : "";
        const size = f?.file_size
          ? ` (${(f.file_size / 1024).toFixed(1)} KB)`
          : "";
        return { text: `[文件${name}${size}]`, msgType: "file" };
      }
      case MSG_ITEM_VIDEO: {
        const v = item.video_item;
        const dur = v?.duration_ms
          ? ` (${(v.duration_ms / 1000).toFixed(1)}s)`
          : "";
        return { text: `[视频${dur}]`, msgType: "video" };
      }
      default:
        return { text: `[未知消息类型 ${item.type}]`, msgType: "unknown" };
    }
  }
  return null;
}

// ── Context token cache (persisted to disk) ─────────────────────────────────

const CONTEXT_TOKEN_FILE = path.join(CREDENTIALS_DIR, "context_tokens.json");

const contextTokenCache = new Map<string, string>(
  (() => {
    try {
      const raw = fs.readFileSync(CONTEXT_TOKEN_FILE, "utf-8");
      return Object.entries(JSON.parse(raw)) as [string, string][];
    } catch {
      return [];
    }
  })(),
);

function cacheContextToken(key: string, token: string): void {
  contextTokenCache.set(key, token);
  try {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
    fs.writeFileSync(
      CONTEXT_TOKEN_FILE,
      JSON.stringify(Object.fromEntries(contextTokenCache), null, 2),
      "utf-8",
    );
  } catch { /* best-effort */ }
}

export function getCachedContextToken(key: string): string | undefined {
  return contextTokenCache.get(key);
}

// ── getUpdates / sendMessage ────────────────────────────────────────────────

async function getUpdates(
  baseUrl: string,
  token: string,
  getUpdatesBuf: string,
): Promise<GetUpdatesResp> {
  try {
    const raw = await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: getUpdatesBuf,
        base_info: { channel_version: "1.0.0" },
      }),
      token,
      timeoutMs: LONG_POLL_TIMEOUT_MS,
    });
    return JSON.parse(raw) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

function generateClientId(): string {
  return `bluerocket-wechat:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

export async function sendTextMessage(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken: string,
): Promise<void> {
  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: generateClientId(),
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{ type: MSG_ITEM_TEXT, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: { channel_version: "1.0.0" },
    }),
    token,
    timeoutMs: 15_000,
  });
}

export async function sendImageMessage(
  baseUrl: string,
  token: string,
  to: string,
  imageBuffer: Buffer,
  contextToken: string,
): Promise<void> {
  const aesKey = crypto.randomBytes(16);
  const encrypted = encryptAesEcb(imageBuffer, aesKey);

  const uploadResp = await getUploadUrl(
    baseUrl, token, to, contextToken,
    MSG_ITEM_IMAGE, encrypted.length,
  );
  if (!uploadResp.upload_url || !uploadResp.media_id) {
    throw new Error(`getuploadurl failed: ${JSON.stringify(uploadResp)}`);
  }

  await uploadToCdn(uploadResp.upload_url, encrypted);

  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: generateClientId(),
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{
          type: MSG_ITEM_IMAGE,
          image_item: {
            media_id: uploadResp.media_id,
            aes_key: aesKey.toString("base64"),
          },
        }],
        context_token: contextToken,
      },
      base_info: { channel_version: "1.0.0" },
    }),
    token,
    timeoutMs: 15_000,
  });
}

// ── Polling with callback ───────────────────────────────────────────────────

export interface InboundMessage {
  text: string;
  msgType: string;
  senderId: string;
  senderShort: string;
  groupId?: string;
  isGroup: boolean;
  canReply: boolean;
  imageCdnUrl?: string;
  imageAesKey?: string;
}

export async function startPolling(
  account: AccountData,
  onMessage: (msg: InboundMessage) => Promise<void>,
): Promise<void> {
  const { baseUrl, token } = account;
  let getUpdatesBuf = "";
  let consecutiveFailures = 0;

  const syncBufFile = path.join(CREDENTIALS_DIR, "sync_buf.txt");
  try {
    if (fs.existsSync(syncBufFile)) {
      getUpdatesBuf = fs.readFileSync(syncBufFile, "utf-8");
      log(`恢复上次同步状态 (${getUpdatesBuf.length} bytes)`);
    }
  } catch { /* ignore */ }

  log("开始监听微信消息...");

  while (true) {
    try {
      const resp = await getUpdates(baseUrl, token, getUpdatesBuf);

      const isError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);
      if (isError) {
        consecutiveFailures++;
        logError(`getUpdates 失败: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logError(`连续失败 ${MAX_CONSECUTIVE_FAILURES} 次，等待 ${BACKOFF_DELAY_MS / 1000}s`);
          consecutiveFailures = 0;
          await new Promise((r) => setTimeout(r, BACKOFF_DELAY_MS));
        } else {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf) {
        getUpdatesBuf = resp.get_updates_buf;
        try { fs.writeFileSync(syncBufFile, getUpdatesBuf, "utf-8"); } catch { /* ignore */ }
      }

      for (const msg of resp.msgs ?? []) {
        if (msg.message_type !== MSG_TYPE_USER) continue;

        const extracted = extractContent(msg);
        if (!extracted) continue;

        const senderId = msg.from_user_id ?? "unknown";
        const groupId = msg.group_id;
        const isGroup = Boolean(groupId);

        const contextKey = groupId || senderId;
        if (msg.context_token) {
          cacheContextToken(contextKey, msg.context_token);
          log(`缓存 context_token: key=${contextKey} token=${msg.context_token.slice(0, 20)}...`);
          if (isGroup) cacheContextToken(senderId, msg.context_token);
        } else {
          logError(`消息缺少 context_token: from=${senderId} — 无法回复，等待下一条消息`);
        }

        const canReply = Boolean(getCachedContextToken(contextKey));
        log(`canReply=${canReply} contextKey=${contextKey}`);
        const senderShort = senderId.split("@")[0] || senderId;

        log(`收到${isGroup ? "群" : "私"}消息 [${extracted.msgType}]: from=${senderShort}${isGroup ? ` group=${groupId}` : ""} "${extracted.text.slice(0, 60)}"`);

        await onMessage({
          text: extracted.text,
          msgType: extracted.msgType,
          senderId: isGroup ? (groupId as string) : senderId,
          senderShort,
          groupId: groupId ?? undefined,
          isGroup,
          canReply,
          imageCdnUrl: extracted.imageCdnUrl,
          imageAesKey: extracted.imageAesKey,
        });
      }
    } catch (err) {
      consecutiveFailures++;
      logError(`轮询异常: ${String(err)}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await new Promise((r) => setTimeout(r, BACKOFF_DELAY_MS));
      } else {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
}
