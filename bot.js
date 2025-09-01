// bot.js
import fs from "fs";
import path from "path";
import crypto from "crypto";
import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";

dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GITHUB_TOKEN_GLOBAL = process.env.GITHUB_TOKEN || null;
const BOT_SECRET = process.env.BOT_SECRET;
const ALLOWED_USERS = (process.env.ALLOWED_USERS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);
const OWNER = process.env.REPO_OWNER;
const REPO = process.env.REPO_NAME;
const WORKFLOW = process.env.WORKFLOW_ID;
const TOKENS_FILE = process.env.TOKENS_FILE || "tokens.json";
const GITHUB_API = "https://api.github.com";

if (!TELEGRAM_TOKEN) throw new Error("TELEGRAM_TOKEN is required");
if (!BOT_SECRET) throw new Error("BOT_SECRET is required");
if (!OWNER || !REPO || !WORKFLOW) throw new Error("REPO_OWNER, REPO_NAME, WORKFLOW_ID required");

// Ensure key is 32 bytes
let key = Buffer.from(BOT_SECRET, "base64");
if (key.length !== 32) {
  key = Buffer.from(BOT_SECRET);
}
if (key.length < 32) {
  // pad (deterministic; for production use proper KDF)
  const padded = Buffer.alloc(32);
  Buffer.from(BOT_SECRET).copy(padded);
  key = padded;
}
if (key.length !== 32) throw new Error("BOT_SECRET must be 32 bytes (raw or base64)");

function loadTokens() {
  try {
    const p = path.resolve(TOKENS_FILE);
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error("Failed to load tokens file:", e);
    return {};
  }
}

function saveTokens(obj) {
  fs.writeFileSync(path.resolve(TOKENS_FILE), JSON.stringify(obj, null, 2), { mode: 0o600 });
}

function encryptToken(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptToken(blob) {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.slice(0, 12);
  const tag = buf.slice(12, 28);
  const encrypted = buf.slice(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return out.toString("utf8");
}

function getUserToken(userId) {
  const store = loadTokens();
  const entry = store[String(userId)];
  if (!entry) return null;
  try {
    return decryptToken(entry.token);
  } catch (e) {
    console.error("Decrypt token failed:", e);
    return null;
  }
}

function setUserToken(userId, token) {
  const store = loadTokens();
  store[String(userId)] = { token: encryptToken(token) };
  saveTokens(store);
}

function delUserToken(userId) {
  const store = loadTokens();
  if (store[String(userId)]) {
    delete store[String(userId)];
    saveTokens(store);
  }
}

function allowed(userId) {
  return ALLOWED_USERS.length === 0 || ALLOWED_USERS.includes(userId);
}

function workflowUrl() {
  return `${GITHUB_API}/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}`;
}

async function getWorkflowRunsWithToken(token) {
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json"
  };
  const url = `${workflowUrl()}/runs`;
  const resp = await axios.get(url, { headers });
  return resp.data;
}

async function dispatchWorkflowWithToken(token, ref = "main", inputs = undefined) {
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json"
  };
  const url = `${workflowUrl()}/dispatches`;
  const payload = { ref };
  if (inputs) payload.inputs = inputs;
  return axios.post(url, payload, { headers, validateStatus: null });
}

async function rerunWorkflowRunWithToken(token, runId) {
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json"
  };
  const url = `${GITHUB_API}/repos/${OWNER}/${REPO}/actions/runs/${runId}/rerun`;
  return axios.post(url, null, { headers, validateStatus: null });
}

// Telegram bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

bot.onText(/\/start/, msg => {
  if (!allowed(msg.from.id)) return bot.sendMessage(msg.chat.id, "Доступ запрещён.");
  bot.sendMessage(msg.chat.id, "Бот готов. /help");
});

bot.onText(/\/help/, msg => {
  if (!allowed(msg.from.id)) return bot.sendMessage(msg.chat.id, "Доступ запрещён.");
  const txt = [
    "/addtoken <token> — сохранить ваш GitHub token (зашифровано)",
    "/deltoken — удалить ваш токен",
    "/mytoken_status — статус workflow с использованием вашего токена",
    "/run [ref] — запустить workflow (использует ваш токен, если есть)"
  ].join("\n");
  bot.sendMessage(msg.chat.id, txt);
});

bot.onText(/\/addtoken (.+)/, (msg, match) => {
  if (!allowed(msg.from.id)) return bot.sendMessage(msg.chat.id, "Доступ запрещён.");
  const token = match[1].trim();
  setUserToken(msg.from.id, token);
  bot.sendMessage(msg.chat.id, "Токен сохранён локально (зашифрован).");
});

bot.onText(/\/deltoken/, msg => {
  if (!allowed(msg.from.id)) return bot.sendMessage(msg.chat.id, "Доступ запрещён.");
  delUserToken(msg.from.id);
  bot.sendMessage(msg.chat.id, "Ваш токен удалён.");
});

bot.onText(/\/mytoken_status/, async msg => {
  if (!allowed(msg.from.id)) return bot.sendMessage(msg.chat.id, "Доступ запрещён.");
  const token = getUserToken(msg.from.id) || GITHUB_TOKEN_GLOBAL;
  if (!token) return bot.sendMessage(msg.chat.id, "Нет токена (ни пользовательского, ни глобального).");
  try {
    const runs = await getWorkflowRunsWithToken(token);
    if (!runs.total_count || runs.total_count === 0) {
      return bot.sendMessage(msg.chat.id, "Запусков workflow не найдено.");
    }
    const latest = runs.workflow_runs[0];
    const text = `Последний запуск id=${latest.id}\nstatus=${latest.status}\nconclusion=${latest.conclusion || "—"}`;
    bot.sendMessage(msg.chat.id, text);
  } catch (e) {
    console.error(e);
    bot.sendMessage(msg.chat.id, `Ошибка: ${e.response?.status || e.message}`);
  }
});

bot.onText(/\/run(?:\s+(\S+))?/, async (msg, match) => {
  if (!allowed(msg.from.id)) return bot.sendMessage(msg.chat.id, "Доступ запрещён.");
  const ref = match && match[1] ? match[1] : "main";
  const token = getUserToken(msg.from.id) || GITHUB_TOKEN_GLOBAL;
  if (!token) return bot.sendMessage(msg.chat.id, "Нет токена (ни пользовательского, ни глобального).");
  try {
    const runs = await getWorkflowRunsWithToken(token);
    const latest = (runs.workflow_runs && runs.workflow_runs[0]) ? runs.workflow_runs[0] : null;
    if (latest && ["queued", "in_progress"].includes(latest.status)) {
      return bot.sendMessage(msg.chat.id, "Workflow уже выполняется.");
    }
    // try dispatch
    const disp = await dispatchWorkflowWithToken(token, ref);
    if (disp.status === 204 || disp.status === 201) {
      return bot.sendMessage(msg.chat.id, `Workflow запрошен на ветке ${ref}.`);
    }
    // fallback to rerun
    if (latest) {
      const rr = await rerunWorkflowRunWithToken(token, latest.id);
      if (rr.status === 201 || rr.status === 202) {
        return bot.sendMessage(msg.chat.id, "Перезапуск workflow запущен.");
      } else {
        return bot.sendMessage(msg.chat.id, `Не удалось перезапустить: ${rr.status}`);
      }
    }
    bot.sendMessage(msg.chat.id, "Не удалось запустить workflow.");
  } catch (e) {
    console.error(e);
    bot.sendMessage(msg.chat.id, `Ошибка: ${e.response?.status || e.message}`);
  }
});

console.log("Bot started (polling)...");
