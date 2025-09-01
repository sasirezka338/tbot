// worker.js
// Deploy with Wrangler v2+
// Bindings required in wrangler.toml:
// - kv_namespaces: { binding = "TOKENS_KV", id = "..." }
// - env vars: TELEGRAM_TOKEN, BOT_SECRET (base64 or raw), GITHUB_TOKEN (optional),
//             REPO_OWNER, REPO_NAME, WORKFLOW_ID, ALLOWED_USERS

const TELEGRAM_TOKEN = "5391613004:AAEnMcQSprr_kly0_wlNvKKBvlCN6sPyGu4"; // provided by Wrangler environment
const BOT_SECRET_RAW = "QV3eVZkUvIpBiO9GeLqfhFmBw5mciHAxqh3is5G7CDs=";     // base64 or raw, provided by Wrangler secrets
const GITHUB_TOKEN_GLOBAL = "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" || null;
const OWNER = "sasirezka338";
const REPO = "tbot";
const WORKFLOW = "ci.yml";
const ALLOWED_USERS = (ALLOWED_USERS || "").split(",").map(s => s.trim()).filter(Boolean).map(Number);
const GITHUB_API = "https://api.github.com";

function allowed(userId) {
  return ALLOWED_USERS.length === 0 || ALLOWED_USERS.includes(userId);
}

function keyBytes() {
  // BOT_SECRET may be base64 or raw utf-8. Try base64 decode first.
  try {
    const b = atob(BOT_SECRET_RAW);
    if (b.length === 32) return new TextEncoder().encode(b);
  } catch (e) {}
  // fallback to utf8 bytes, pad/truncate to 32
  const kb = new TextEncoder().encode(BOT_SECRET_RAW);
  if (kb.length === 32) return kb;
  const out = new Uint8Array(32);
  out.set(kb.slice(0, 32));
  return out;
}

async function encryptToken(token) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes(),
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(token);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc);
  // store as base64(iv + ct)
  const combined = new Uint8Array(iv.byteLength + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.byteLength);
  return btoa(String.fromCharCode(...combined));
}

async function decryptToken(blob) {
  const raw = Uint8Array.from(atob(blob), c => c.charCodeAt(0));
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes(),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

function workflowUrl() {
  return `${GITHUB_API}/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}`;
}

async function getWorkflowRunsWithToken(token) {
  const url = `${workflowUrl()}/runs`;
  const r = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json"
    }
  });
  if (!r.ok) throw new Error(`GitHub API error ${r.status}`);
  return r.json();
}

async function dispatchWorkflowWithToken(token, ref = "main", inputs) {
  const url = `${workflowUrl()}/dispatches`;
  const body = { ref };
  if (inputs) body.inputs = inputs;
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function rerunWorkflowRunWithToken(token, runId) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/runs/${runId}/rerun`;
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json"
    }
  });
}

// KV bindings: TOKENS_KV available via global binding
export default {
  async fetch(request, env) {
    try {
      if (request.method !== "POST") return new Response("OK", { status: 200 });
      const body = await request.json();
      // Telegram sends updates as JSON
      if (!body.message && !body.callback_query) return new Response("No update", { status: 200 });
      const msg = body.message || body.callback_query.message;
      const chatId = msg.chat.id;
      const userId = (body.from || body.message.from || body.callback_query.from).id;
      const text = (msg.text || "").trim();
      if (!allowed(userId)) {
        await sendTelegram(chatId, "Доступ запрещён.");
        return new Response("forbidden", { status: 200 });
      }
      if (text.startsWith("/start") || text.startsWith("/help")) {
        return await handleHelp(chatId);
      }
      if (text.startsWith("/addtoken")) {
        const parts = text.split(/\s+/, 2);
        if (parts.length < 2 || !parts[1]) return await sendTelegram(chatId, "Использование: /addtoken <token>");
        const token = parts[1].trim();
        const enc = await encryptToken(token);
        await env.TOKENS_KV.put(String(userId), enc);
        return await sendTelegram(chatId, "Токен сохранён (зашифрован) в KV.");
      }
      if (text.startsWith("/deltoken")) {
        await env.TOKENS_KV.delete(String(userId));
        return await sendTelegram(chatId, "Ваш токен удалён.");
      }
      if (text.startsWith("/mytoken_status")) {
        const token = await getTokenForUser(env, userId);
        if (!token) return await sendTelegram(chatId, "Нет токена (ни пользовательского, ни глобального).");
        try {
          const runs = await getWorkflowRunsWithToken(token);
          if (!runs.total_count || runs.total_count === 0) {
            return await sendTelegram(chatId, "Запусков workflow не найдено.");
          }
          const latest = runs.workflow_runs[0];
          return await sendTelegram(chatId, `Последний запуск id=${latest.id}\nstatus=${latest.status}\nconclusion=${latest.conclusion || "—"}`);
        } catch (e) {
          return await sendTelegram(chatId, `Ошибка GitHub: ${e.message}`);
        }
      }
      if (text.startsWith("/run")) {
        const parts = text.split(/\s+/);
        const ref = parts[1] || "main";
        const token = await getTokenForUser(env, userId);
        if (!token) return await sendTelegram(chatId, "Нет токена (ни пользовательского, ни глобального).");
        try {
          const runs = await getWorkflowRunsWithToken(token);
          const latest = (runs.workflow_runs && runs.workflow_runs[0]) ? runs.workflow_runs[0] : null;
          if (latest && ["queued", "in_progress"].includes(latest.status)) {
            return await sendTelegram(chatId, "Workflow уже выполняется.");
          }
          // try dispatch
          const disp = await dispatchWorkflowWithToken(token, ref);
          if (disp.status === 204 || disp.status === 201) {
            return await sendTelegram(chatId, `Workflow запрошен на ветке ${ref}.`);
          }
          // fallback rerun
          if (latest) {
            const rr = await rerunWorkflowRunWithToken(token, latest.id);
            if (rr.status === 201 || rr.status === 202) {
              return await sendTelegram(chatId, "Перезапуск workflow запущен.");
            } else {
              return await sendTelegram(chatId, `Не удалось перезапустить: ${rr.status}`);
            }
          }
          return await sendTelegram(chatId, "Не удалось запустить workflow.");
        } catch (e) {
          return await sendTelegram(chatId, `Ошибка GitHub: ${e.message}`);
        }
      }
      return new Response("unknown command", { status: 200 });
    } catch (err) {
      console.error(err);
      return new Response("error", { status: 500 });
    }
  }
};

async function getTokenForUser(env, userId) {
  const stored = await env.TOKENS_KV.get(String(userId));
  if (stored) {
    try { return await decryptToken(stored); } catch (e) { console.error("decrypt fail", e); }
  }
  return GITHUB_TOKEN_GLOBAL;
}

async function sendTelegram(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

async function handleHelp(chatId) {
  const txt = [
    "/addtoken <token> — сохранить ваш GitHub token (зашифровано в KV)",
    "/deltoken — удалить ваш токен",
    "/mytoken_status — статус workflow с использованием вашего токена",
    "/run [ref] — запустить workflow (использует ваш токен, если есть)"
  ].join("\n");
  return await sendTelegram(chatId, txt);
}
