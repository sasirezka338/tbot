// worker.js
// Deploy with Wrangler v2+
// Required bindings in wrangler.toml:
// - kv_namespaces: [{ binding = "TOKENS_KV", id = "..." }]
// - env vars: TELEGRAM_TOKEN, BOT_SECRET (base64 or raw), GITHUB_TOKEN (optional),
//             REPO_OWNER, REPO_NAME, WORKFLOW_ID, ALLOWED_USERS

const GITHUB_API = "https://api.github.com";

// NOTE: do NOT hardcode secrets in source. They must be provided via env (wrangler secrets).
// The following placeholders are for local dev only — in production use env.* inside fetch handler.
function allowedUsersFromEnv(env) {
  const raw = env.ALLOWED_USERS || "";
  return raw.split(",").map(s => s.trim()).filter(Boolean).map(s => {
    // try number, otherwise keep string
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  });
}

function allowed(userId, env) {
  const list = allowedUsersFromEnv(env);
  // empty list means allow all
  if (list.length === 0) return true;
  return list.includes(userId);
}

function workflowUrl(env) {
  const owner = env.REPO_OWNER;
  const repo = env.REPO_NAME;
  const workflow = env.WORKFLOW_ID || env.WORKFLOW || "ci.yml";
  return `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${workflow}`;
}

function atobPoly(s) {
  // Cloudflare Workers have atob/btoa; this is a safe polyfill fallback
  try { return atob(s); } catch (e) {
    return Buffer.from(s, "base64").toString("binary");
  }
}
function btoaPoly(s) {
  try { return btoa(s); } catch (e) {
    return Buffer.from(s, "binary").toString("base64");
  }
}

function keyBytesFromSecret(rawSecret) {
  // BOT_SECRET may be base64 or raw utf-8. Try base64 decode first.
  if (!rawSecret) throw new Error("BOT_SECRET not provided");
  try {
    const b = atobPoly(rawSecret);
    if (b.length === 32) return new TextEncoder().encode(b);
  } catch (e) {
    // ignore
  }
  // fallback to utf8 bytes, pad/truncate to 32
  const kb = new TextEncoder().encode(rawSecret);
  if (kb.length === 32) return kb;
  const out = new Uint8Array(32);
  out.set(kb.slice(0, 32));
  return out;
}

async function importKey(rawSecret, usage = ["encrypt", "decrypt"]) {
  return crypto.subtle.importKey(
    "raw",
    keyBytesFromSecret(rawSecret),
    { name: "AES-GCM" },
    false,
    usage
  );
}

async function encryptToken(rawSecret, token) {
  const key = await importKey(rawSecret, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(token);
  const ctBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc);
  const ct = new Uint8Array(ctBuffer);
  const combined = new Uint8Array(iv.byteLength + ct.byteLength);
  combined.set(iv, 0);
  combined.set(ct, iv.byteLength);
  // convert to binary string for btoa
  const bin = Array.from(combined).map(n => String.fromCharCode(n)).join("");
  return btoaPoly(bin);
}

async function decryptToken(rawSecret, blob) {
  const bin = atobPoly(blob);
  const raw = new Uint8Array(Array.from(bin).map(c => c.charCodeAt(0)));
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const key = await importKey(rawSecret, ["decrypt"]);
  const ptBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(ptBuffer);
}

async function getWorkflowRunsWithToken(env, token) {
  const url = `${workflowUrl(env)}/runs`;
  const r = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json"
    }
  });
  if (!r.ok) throw new Error(`GitHub API error ${r.status}`);
  return r.json();
}

async function dispatchWorkflowWithToken(env, token, ref = "main", inputs) {
  const url = `${workflowUrl(env)}/dispatches`;
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

async function rerunWorkflowRunWithToken(env, token, runId) {
  const url = `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/actions/runs/${runId}/rerun`;
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json"
    }
  });
}

async function getTokenForUser(env, userId) {
  const stored = await env.TOKENS_KV.get(String(userId));
  if (stored) {
    try { return await decryptToken(env.BOT_SECRET, stored); } catch (e) { console.error("decrypt fail", e); }
  }
  // fallback to global token from env
  return env.GITHUB_TOKEN || null;
}

async function sendTelegram(env, chatId, text) {
  const TELEGRAM_TOKEN = env.TELEGRAM_TOKEN;
  if (!TELEGRAM_TOKEN) throw new Error("TELEGRAM_TOKEN missing");
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

async function handleHelp(env, chatId) {
  const txt = [
    "/addtoken <token> — сохранить ваш GitHub token (зашифровано в KV)",
    "/deltoken — удалить ваш токен",
    "/mytoken_status — статус workflow с использованием вашего токена",
    "/run [ref] — запустить workflow (использует ваш токен, если есть)"
  ].join("\n");
  return sendTelegram(env, chatId, txt);
}

export default {
  async fetch(request, env) {
    try {
      if (request.method !== "POST") return new Response("OK", { status: 200 });
      const body = await request.json();

      // Telegram update normalization
      const update = body;
      // Telegram sometimes wraps message inside callback_query
      const msg = update.message || (update.callback_query && update.callback_query.message) || null;
      const sender = update.from || (update.message && update.message.from) || (update.callback_query && update.callback_query.from) || null;
      if (!msg || !sender) return new Response("No update", { status: 200 });

      const chatId = msg.chat && msg.chat.id;
      const userId = sender.id;
      const text = (msg.text || "").trim();

      if (!allowed(userId, env)) {
        await sendTelegram(env, chatId, "Доступ запрещён.");
        return new Response("forbidden", { status: 200 });
      }

      if (text.startsWith("/start") || text.startsWith("/help")) {
        await handleHelp(env, chatId);
        return new Response("ok", { status: 200 });
      }

      if (text.startsWith("/addtoken")) {
        const parts = text.split(/\s+/, 2);
        if (parts.length < 2 || !parts[1]) {
          await sendTelegram(env, chatId, "Использование: /addtoken <token>");
          return new Response("ok", { status: 200 });
        }
        const token = parts[1].trim();
        const enc = await encryptToken(env.BOT_SECRET, token);
        await env.TOKENS_KV.put(String(userId), enc);
        await sendTelegram(env, chatId, "Токен сохранён (зашифрован) в KV.");
        return new Response("ok", { status: 200 });
      }

      if (text.startsWith("/deltoken")) {
        await env.TOKENS_KV.delete(String(userId));
        await sendTelegram(env, chatId, "Ваш токен удалён.");
        return new Response("ok", { status: 200 });
      }

      if (text.startsWith("/mytoken_status")) {
        const token = await getTokenForUser(env, userId);
        if (!token) {
          await sendTelegram(env, chatId, "Нет токена (ни пользовательского, ни глобального).");
          return new Response("ok", { status: 200 });
        }
        try {
          const runs = await getWorkflowRunsWithToken(env, token);
          if (!runs.total_count || runs.total_count === 0) {
            await sendTelegram(env, chatId, "Запусков workflow не найдено.");
            return new Response("ok", { status: 200 });
          }
          const latest = runs.workflow_runs[0];
          await sendTelegram(env, chatId, `Последний запуск id=${latest.id}\nstatus=${latest.status}\nconclusion=${latest.conclusion || "—"}`);
          return new Response("ok", { status: 200 });
        } catch (e) {
          await sendTelegram(env, chatId, `Ошибка GitHub: ${e.message}`);
          return new Response("ok", { status: 200 });
        }
      }

      if (text.startsWith("/run")) {
        const parts = text.split(/\s+/);
        const ref = parts[1] || "main";
        const token = await getTokenForUser(env, userId);
        if (!token) {
          await sendTelegram(env, chatId, "Нет токена (ни пользовательского, ни глобального).");
          return new Response("ok", { status: 200 });
        }
        try {
          const runs = await getWorkflowRunsWithToken(env, token);
          const latest = (runs.workflow_runs && runs.workflow_runs[0]) ? runs.workflow_runs[0] : null;
          if (latest && ["queued", "in_progress"].includes(latest.status)) {
            await sendTelegram(env, chatId, "Workflow уже выполняется.");
            return new Response("ok", { status: 200 });
          }
          // Try dispatch (recommended)
          const disp = await dispatchWorkflowWithToken(env, token, ref);
          // dispatch returns 204 No Content on success
          if (disp.ok || disp.status === 204 || disp.status === 201) {
            await sendTelegram(env, chatId, `Workflow запрошен на ветке ${ref}.`);
            return new Response("ok", { status: 200 });
          }
          // fallback: try rerun if we have latest run id
          if (latest) {
            const rr = await rerunWorkflowRunWithToken(env, token, latest.id);
            if (rr.ok || rr.status === 201 || rr.status === 202) {
              await sendTelegram(env, chatId, "Перезапуск workflow запущен.");
              return new Response("ok", { status: 200 });
            } else {
              await sendTelegram(env, chatId, `Не удалось перезапустить: ${rr.status}`);
              return new Response("ok", { status: 200 });
            }
          }
          await sendTelegram(env, chatId, "Не удалось запустить workflow.");
          return new Response("ok", { status: 200 });
        } catch (e) {
          await sendTelegram(env, chatId, `Ошибка GitHub: ${e.message}`);
          return new Response("ok", { status: 200 });
        }
      }

      await sendTelegram(env, chatId, "Неизвестная команда.");
      return new Response("ok", { status: 200 });
    } catch (err) {
      console.error(err);
      return new Response("error", { status: 500 });
    }
  }
};
