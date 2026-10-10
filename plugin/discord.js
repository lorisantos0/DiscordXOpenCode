import { readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const DISCORD_API = "https://discord.com/api/v10";
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

export default {
  id: "discord-notification",

  setup(ctx) {
    console.log("[discord-notification] Plugin loaded");

    const debugFile = join(tmpdir(), "opencode-discord-debug.log");
    const debugLog = (label, data) => {
      try {
        writeFileSync(
          debugFile,
          `${new Date().toISOString()} ${label} ${JSON.stringify(data)}\n`,
          { flag: "a" }
        );
      } catch {
        /* ignore */
      }
    };

    debugLog("setup", {
      execPath: process.execPath,
      argv: process.argv,
      cwd: process.cwd(),
      bun: Boolean(process.versions?.bun),
      node: process.versions?.node,
    });

    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    const botTokenFile =
      process.env.DISCORD_BOT_TOKEN_FILE ||
      join(homedir(), ".config", "opencode", "discord-bot-token");
    const readTextFile = (file) => {
      try {
        return readFileSync(file, "utf8").trim() || null;
      } catch {
        return null;
      }
    };
    const userIdFile =
      process.env.DISCORD_USER_ID_FILE ||
      join(homedir(), ".config", "opencode", "discord-user-id");
    let userId =
      process.env.DISCORD_USER_ID || readTextFile(userIdFile) || null;
    const writeTextFile = (file, text) => {
      try {
        writeFileSync(file, String(text));
        return true;
      } catch {
        return false;
      }
    };
    const botToken = process.env.DISCORD_BOT_TOKEN || readTextFile(botTokenFile);
    const channelIdFile =
      process.env.DISCORD_CHANNEL_ID_FILE ||
      join(homedir(), ".config", "opencode", "discord-channel-id");
    let channelId =
      process.env.DISCORD_CHANNEL_ID || readTextFile(channelIdFile) || null;

    if (!webhookUrl && !botToken) {
      console.error(
        "[discord-notification] Nothing configured: set DISCORD_BOT_TOKEN (or token file) and/or DISCORD_WEBHOOK_URL"
      );
      return;
    }

    if (!userId) {
      console.warn(
        "[discord-notification] DISCORD_USER_ID is not set — the bot will answer ANYONE. Set it (env or discord-user-id file) to restrict access."
      );
    }

    const stateKey = "__opencodeDiscordNotificationState";
    const existingState = globalThis[stateKey];

    if (existingState?.controller && !existingState.controller.signal.aborted) {
      console.log(
        "[discord-notification] Plugin already active, skipping duplicate instance"
      );
      return () => {};
    }

    const controller = new AbortController();
    const state = {
      controller,
      lastNotificationAt: 0,
      lastAttentionAt: 0,
    };
    const pending = {
      form: null,
      permission: null,
    };
    const replies = {
      lastMessageId: null,
      polling: false,
    };
    let gatewayStatus = "disconnected";
    let gateway = null;
    let heartbeatTimer = null;
    let reconnectTimer = null;
    let reconnectDelay = 5000;

    const debounceFile = join(
      tmpdir(),
      "opencode-discord-notification-last.txt"
    );
    const attentionDebounceFile = join(
      tmpdir(),
      "opencode-discord-notification-attention.txt"
    );
    const statusFile = join(tmpdir(), "opencode-discord-gateway.json");

    globalThis[stateKey] = state;

    const notifyEvents = new Set([
      "session.idle",
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
    ]);

    const attentionEvents = new Set(["form.created", "permission.asked"]);

    const permissionChoices = [
      { number: 1, value: "once", label: "✅ Só desta vez", style: 1 },
      { number: 2, value: "always", label: "♾️ Sempre", style: 3 },
      { number: 3, value: "reject", label: "⛔ Rejeitar", style: 4 },
    ];

    const runModel = process.env.DISCORD_RUN_MODEL || null;

    // Session the user is actually chatting in, learned from events.
    let chatSessionID = null;
    // Sessions created by /question itself (fallback) — never treated as "the chat".
    const botSessions = new Set();

    const getSessionId = (event) =>
      event.sessionID ||
      event.data?.sessionID ||
      event.data?.session?.id ||
      event.data?.session?.sessionID ||
      event.data?.form?.sessionID ||
      "unknown-session";

    const getMessage = (event) => {
      if (event.type === "session.execution.failed") {
        return `❌ <@${userId}> OpenCode stopped with an error.`;
      }
      if (event.type === "session.execution.interrupted") {
        return `⚠️ <@${userId}> OpenCode was interrupted.`;
      }
      return `✅ <@${userId}> OpenCode finished working!`;
    };

    const truncate = (value, max) => {
      if (typeof value !== "string") return "";
      return value.length > max ? `${value.slice(0, max - 1)}…` : value;
    };

    const clamp = (content, max = 1900) =>
      content.length > max ? `${content.slice(0, max - 1)}…` : content;

    const writeStatus = () => {
      try {
        writeFileSync(
          statusFile,
          JSON.stringify(
            {
              at: new Date().toISOString(),
              gatewayStatus,
              channelId,
              botToken: Boolean(botToken),
              pendingForm: pending.form
                ? {
                    token: pending.form.token,
                    options: pending.form.choices.length,
                  }
                : null,
              pendingPermission: pending.permission
                ? { token: pending.permission.token }
                : null,
            },
            null,
            2
          )
        );
      } catch {
        /* ignore */
      }
    };

    const sendWebhook = async (content, options = {}) => {
      const url = options.captureChannel
        ? `${webhookUrl}${webhookUrl.includes("?") ? "&" : "?"}wait=true`
        : webhookUrl;

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: clamp(content),
            allowed_mentions: { users: [userId] },
          }),
        });

        if (!response.ok) {
          console.error(
            "[discord-notification] Discord error:",
            response.status,
            await response.text()
          );
          return null;
        }

        if (options.captureChannel) {
          try {
            const data = await response.json();
            if (data?.channel_id) channelId = data.channel_id;
          } catch {
            /* no body */
          }
        }

        return response;
      } catch (error) {
        console.error("[discord-notification] Discord send failed:", error);
        return null;
      }
    };

    const botRequest = async (path, method = "GET", body = null) => {
      if (!botToken) return { ok: false, status: 0, data: null };

      try {
        const response = await fetch(`${DISCORD_API}${path}`, {
          method,
          headers: {
            Authorization: `Bot ${botToken}`,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        const text = await response.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          /* non JSON */
        }

        if (!response.ok) {
          console.error(
            "[discord-notification] bot API",
            method,
            path,
            response.status,
            String(text).slice(0, 300)
          );
        }

        return { ok: response.ok, status: response.status, data };
      } catch (error) {
        console.error(
          "[discord-notification] bot API failed",
          method,
          path,
          error
        );
        return { ok: false, status: 0, data: null };
      }
    };

    // If no channel is configured, pick one automatically: prefer a channel
    // named like "general", otherwise the first text channel the bot can see.
    const detectChannel = async () => {
      if (channelId || !botToken) return channelId;
      try {
        const guilds = await botRequest("/users/@me/guilds");
        if (!guilds.ok || !Array.isArray(guilds.data)) return null;

        const preferred = /^(general|geral|chat|opencode|bot|bots)$/i;

        for (const guild of guilds.data) {
          const channels = await botRequest(`/guilds/${guild.id}/channels`);
          if (!channels.ok || !Array.isArray(channels.data)) continue;

          const text = channels.data.filter((c) => c.type === 0);
          if (!text.length) continue;

          const pick =
            text.find((c) => preferred.test(String(c.name))) || text[0];
          channelId = String(pick.id);
          writeTextFile(channelIdFile, channelId);
          debugLog("channel:detected", {
            guild: guild.name,
            channel: pick.name,
            channelId,
          });
          return channelId;
        }
      } catch (error) {
        debugLog("channel:detect:error", { error: String(error) });
      }
      return null;
    };

    // Who is allowed to drive the bot. If no owner is configured, the first
    // person to interact becomes the owner and is remembered on disk.
    const isAuthorized = (authorId) => {
      if (!authorId) return false;
      if (userId) return String(authorId) === String(userId);
      userId = String(authorId);
      writeTextFile(userIdFile, userId);
      console.log(`[discord-notification] Owner auto-bound to ${userId}`);
      debugLog("owner:auto-bound", { userId });
      return true;
    };

    const buildFormPresentation = (form) => {
      const choices = [];
      const lines = [];
      const fields = (form?.fields ?? []).filter((field) => !field.hidden);
      let number = 0;

      for (const field of fields) {
        if (fields.length > 1) {
          lines.push(`**${truncate(field.title || field.key, 80)}**`);
        }

        const options = Array.isArray(field.options) ? field.options : [];

        if (options.length === 0) {
          choices.push({
            number: null,
            key: field.key,
            type: field.type,
            value: null,
            label: field.title || field.key,
          });
          lines.push(
            `✏️ ${truncate(field.title || field.key, 80)} (responde com o texto)`
          );
          continue;
        }

        for (const option of options) {
          number += 1;
          const label = option.label || option.value || String(number);
          choices.push({
            number,
            key: field.key,
            type: field.type,
            value: option.value ?? option.label ?? label,
            label,
          });
          lines.push(`${number}. ${truncate(label, 120)}`);
        }
      }

      return { choices, lines };
    };

    const getAttentionMessage = (event) => {
      if (event.type === "permission.asked") {
        const action = event.data?.action || "an action";
        const resources = Array.isArray(event.data?.resources)
          ? event.data.resources
          : [];
        const detail = resources.length
          ? `\n${resources
              .slice(0, 3)
              .map((resource) => `• ${truncate(resource, 120)}`)
              .join("\n")}`
          : "";

        return clamp(
          `🔐 <@${userId}> OpenCode needs your permission to continue.\nAction: \`${truncate(
            action,
            120
          )}\`${detail}\n\nResponde aqui com: **1** (once) · **2** (always) · **3** (reject)`
        );
      }

      const form = event.data?.form;
      const title =
        truncate(form?.title, 150) || "OpenCode is waiting for your choice";
      const { lines } = buildFormPresentation(form);
      const detail = lines.length ? `\n${lines.join("\n")}` : "";
      const hint =
        "\n\nResponde aqui no Discord com o número da opção (ex.: `1`, ou `1,2` se forem várias).";

      return clamp(
        `📝 <@${userId}> OpenCode is waiting for you to choose!\n**${title}**${detail}${hint}`
      );
    };

    const buildButtonComponents = (choices, kind, token) => {
      const rows = [];
      const list = choices.slice(0, 25);

      for (let index = 0; index < list.length; index += 5) {
        const row = { type: 1, components: [] };

        for (const choice of list.slice(index, index + 5)) {
          row.components.push({
            type: 2,
            style: choice.style ?? 1,
            label: truncate(choice.label, 80) || String(choice.number),
            custom_id: `oc|${kind}|${token}|${choice.number}`,
          });
        }

        rows.push(row);
      }

      return rows;
    };

    const sendMessage = async (content, options = {}) => {
      if (botToken && !channelId) {
        await detectChannel();
      }

      if (botToken && channelId) {
        return botRequest(`/channels/${channelId}/messages`, "POST", {
          content: clamp(content),
          allowed_mentions: { users: [userId] },
          ...(options.components ? { components: options.components } : {}),
        });
      }

      return sendWebhook(content, {
        ...options,
        captureChannel: !channelId,
      });
    };

    const sendToChannel = (channel, content) =>
      botRequest(`/channels/${channel}/messages`, "POST", {
        content: clamp(content),
        allowed_mentions: { users: [userId] },
      });

    const shouldNotifyWith = (file, key, windowMs) => {
      const now = Date.now();
      let lastFromFile = 0;

      try {
        lastFromFile = Number(readFileSync(file, "utf8")) || 0;
      } catch {
        lastFromFile = 0;
      }

      const last = Math.max(state[key], lastFromFile);
      if (now - last < windowMs) return false;

      state[key] = now;
      writeFileSync(file, String(now));
      return true;
    };

    const shouldNotify = () =>
      shouldNotifyWith(debounceFile, "lastNotificationAt", 20_000);

    const shouldNotifyAttention = () =>
      shouldNotifyWith(attentionDebounceFile, "lastAttentionAt", 5_000);

    const replyToForm = (form, answer) =>
      new Promise((resolve) => {
        execFile(
          process.execPath,
          [
            "api",
            "post",
            `/api/session/${form.sessionID}/form/${form.formID}/reply`,
            "--data",
            JSON.stringify({ answer }),
          ],
          { timeout: 20_000 },
          (error, _stdout, stderr) => {
            if (error) {
              console.error(
                "[discord-notification] form reply failed:",
                String(error),
                stderr
              );
              resolve(false);
            } else {
              resolve(true);
            }
          }
        );
      });

    const serverAuthFile =
      process.env.OPENCODE_SERVICE_FILE ||
      join(homedir(), ".config", "opencode", "service.json");
    let serverUrl = null;

    const toBase64 = (value) => {
      if (typeof Buffer !== "undefined") {
        return Buffer.from(value).toString("base64");
      }
      return btoa(unescape(encodeURIComponent(value)));
    };

    const getServerUrl = () =>
      new Promise((resolve) => {
        if (serverUrl) return resolve(serverUrl);

        execFile(
          process.execPath,
          ["api", "get", "/api/info"],
          { timeout: 15_000 },
          (error, stdout) => {
            if (error) return resolve(null);
            try {
              serverUrl = JSON.parse(String(stdout))?.urls?.[0] || null;
            } catch {
              serverUrl = null;
            }
            resolve(serverUrl);
          }
        );
      });

    const getServerPassword = () => {
      try {
        return JSON.parse(readFileSync(serverAuthFile, "utf8"))?.password || null;
      } catch {
        return null;
      }
    };

    const serverRequest = async (method, path, body = null) => {
      try {
        const url = await getServerUrl();
        const password = getServerPassword();
        if (!url || !password) {
          debugLog("server:auth", { url, hasPassword: Boolean(password) });
          return { ok: false, status: 0, data: null };
        }

        const response = await fetch(`${url}${path}`, {
          method,
          headers: {
            Authorization: `Basic ${toBase64(`opencode:${password}`)}`,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        const text = await response.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          /* non JSON */
        }

        if (!response.ok) {
          debugLog("server:error", {
            method,
            path,
            status: response.status,
            body: text.slice(0, 300),
          });
        }

        return { ok: response.ok, status: response.status, data };
      } catch (error) {
        console.error(
          "[discord-notification] server request failed:",
          method,
          path,
          error
        );
        return { ok: false, status: 0, data: null };
      }
    };

    const replyToPermission = async (sessionID, requestID, decision) => {
      // The V2 runtime expects `decision` ("once" | "always" | "reject");
      // V1 used `reply`. Try the plugin API first, then the HTTP endpoint.
      try {
        await ctx.permission.reply({ sessionID, requestID, decision });
        return;
      } catch (error) {
        debugLog("permission:ctx-failed", {
          message: String(error?.message ?? error),
        });
      }

      const result = await serverRequest(
        "POST",
        `/api/session/${sessionID}/permission/${requestID}/reply`,
        { decision }
      );
      if (!result.ok) {
        throw new Error(
          result.data?.message || `HTTP ${result.status || "sem ligação"}`
        );
      }
    };

    const parseModelRef = (model) => {
      const modelStr = String(model || "").trim();
      if (!modelStr) return null;
      const [providerID, ...rest] = modelStr.split("/");
      const id = rest.join("/");
      if (!providerID || !id) return null;
      return { id, providerID };
    };

    const extractAssistantText = (messages, since = 0) => {
      if (!Array.isArray(messages)) return null;

      const threshold = Math.max(0, since - 1_500);
      const assistants = messages.filter((item) => {
        if (item?.type !== "assistant") return false;
        if (!threshold) return true;
        const created = item?.time?.created ?? 0;
        const streamed = item?.time?.streamed ?? 0;
        const completed = item?.time?.completed ?? 0;
        return (
          created >= threshold ||
          streamed >= threshold ||
          completed >= threshold
        );
      });
      if (assistants.length === 0) return null;

      const last = assistants.reduce((best, item) => {
        const current =
          item?.time?.completed ??
          item?.time?.streamed ??
          item?.time?.created ??
          0;
        const previous =
          best?.time?.completed ??
          best?.time?.streamed ??
          best?.time?.created ??
          0;
        return current > previous ? item : best;
      });

      const parts = Array.isArray(last?.content) ? last.content : [];
      const text = parts
        .filter(
          (part) =>
            part?.type === "text" &&
            typeof part.text === "string" &&
            part.text.trim()
        )
        .map((part) => part.text)
        .join("\n")
        .trim();

      return text || null;
    };

    const normalizeDir = (dir) =>
      String(dir || "")
        .replace(/[\\/]+$/, "")
        .toLowerCase();

    const homeDirectory = normalizeDir(homedir());

    // A session is only useful if it lives in a real project directory — not
    // the home dir, where contextless sessions pile up.
    const isUsableDirectory = (dir) => {
      const normalized = normalizeDir(dir);
      return Boolean(normalized) && normalized !== homeDirectory;
    };

    const aliasesFile =
      process.env.DISCORD_ALIASES_FILE ||
      join(homedir(), ".config", "opencode", "discord-aliases.json");

    // { sessionID: "alias" } so a session can be pointed at by a short name.
    let sessionAliases = (() => {
      try {
        const parsed = JSON.parse(readFileSync(aliasesFile, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        return {};
      }
    })();

    const persistAliases = () => {
      try {
        writeFileSync(aliasesFile, JSON.stringify(sessionAliases, null, 2));
      } catch {
        /* ignore */
      }
    };

    const slugify = (value) =>
      String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24);

    const aliasTaken = (alias, exceptId) =>
      Object.entries(sessionAliases).some(
        ([id, value]) => value === alias && id !== exceptId
      );

    // Give every session a stable, typeable name (e.g. "loja-tcg").
    const ensureAlias = (session) => {
      const id = session?.id;
      if (!id) return null;
      if (sessionAliases[id]) return sessionAliases[id];

      const base =
        slugify(session.title) ||
        `sessao-${slugify(String(id).slice(-8)) || "nova"}`;
      let alias = base;
      let n = 2;
      while (aliasTaken(alias, id)) {
        alias = `${base}-${n}`;
        n += 1;
      }
      sessionAliases[id] = alias;
      persistAliases();
      return alias;
    };

    // Recent project sessions, each with a stable alias, newest first.
    const listProjectSessions = async (limit = 15) =>
      (await listSessions())
        .filter(
          (item) =>
            item?.id &&
            !botSessions.has(item.id) &&
            isUsableDirectory(item?.location?.directory)
        )
        .sort(
          (a, b) =>
            (b?.time?.updated ?? b?.time?.created ?? 0) -
            (a?.time?.updated ?? a?.time?.created ?? 0)
        )
        .slice(0, limit)
        .map((item) => ({
          id: item.id,
          title: item.title || "",
          directory: item.location?.directory ?? null,
          alias: ensureAlias(item),
        }));

    const listSessions = async () => {
      const result = await serverRequest("GET", "/api/session");
      return Array.isArray(result.data?.data) ? result.data.data : [];
    };

    const sessionDirectory = async (sessionID) => {
      const result = await serverRequest("GET", `/api/session/${sessionID}`);
      return result.data?.data?.location?.directory ?? null;
    };

    // Pick the conversation the user is actually working in: the one open in
    // the app, otherwise the most recently updated real project session.
    // Sessions created by this plugin, or living in the home directory, are
    // never used (they have no project context and may never run).
    const findProjectSession = async () => {
      if (chatSessionID && !botSessions.has(chatSessionID)) {
        const dir = await sessionDirectory(chatSessionID);
        if (isUsableDirectory(dir)) {
          return { id: chatSessionID, directory: dir };
        }
      }

      const items = await listSessions();
      const usable = items
        .filter(
          (item) =>
            item?.id &&
            !botSessions.has(item.id) &&
            isUsableDirectory(item?.location?.directory)
        )
        .sort(
          (a, b) =>
            (b?.time?.updated ?? b?.time?.created ?? 0) -
            (a?.time?.updated ?? a?.time?.created ?? 0)
        );

      const best = usable[0];
      return best
        ? { id: best.id, directory: best.location.directory }
        : null;
    };

    // Resolve a session the user pointed at explicitly: either a full id
    // (ses_...) or a case-insensitive fragment of its title.
    const resolveSessionReference = async (reference) => {
      const ref = String(reference || "").trim();
      if (!ref) return null;

      if (/^ses/i.test(ref)) {
        const found = await serverRequest("GET", `/api/session/${ref}`);
        if (found.ok && found.data?.data?.id) {
          return {
            id: found.data.data.id,
            title: found.data.data.title || "",
            directory: found.data.data.location?.directory ?? null,
          };
        }
        return null;
      }

      // Match by the session's alias (the short name shown by /sessions).
      const aliasId = Object.keys(sessionAliases).find(
        (id) => String(sessionAliases[id]).toLowerCase() === ref.toLowerCase()
      );
      if (aliasId) {
        const found = await serverRequest("GET", `/api/session/${aliasId}`);
        if (found.ok && found.data?.data?.id) {
          return {
            id: found.data.data.id,
            title: found.data.data.title || "",
            directory: found.data.data.location?.directory ?? null,
          };
        }
      }

      const needle = ref.toLowerCase();
      const items = await listSessions();
      const match = items
        .filter((item) =>
          String(item?.title || "")
            .toLowerCase()
            .includes(needle)
        )
        .sort(
          (a, b) =>
            (b?.time?.updated ?? b?.time?.created ?? 0) -
            (a?.time?.updated ?? a?.time?.created ?? 0)
        )[0];

      return match
        ? {
            id: match.id,
            title: match.title || "",
            directory: match.location?.directory ?? null,
          }
        : null;
    };

    const runOpenCode = async (prompt, options = {}) => {
      const runTimeout = Number(process.env.DISCORD_RUN_TIMEOUT || 600_000);
      const modelRef = parseModelRef(runModel);
      const sessionRef = String(options.sessionID || "").trim();
      const mode = options.mode === "new" ? "new" : "current";

      // The conversation open in the app, or the most recent project session.
      const resolved = await findProjectSession();

      let sessionID = null;
      let source = null;
      let sessionTitle = null;

      if (sessionRef) {
        // Explicit target: connect to an existing session.
        const referenced = await resolveSessionReference(sessionRef);
        if (!referenced) {
          return {
            ok: false,
            error: `Não encontrei nenhuma sessão com "${sessionRef}".`,
          };
        }
        sessionID = referenced.id;
        sessionTitle = referenced.title;
        source = sessionID === chatSessionID ? "chat" : "explicit";
      } else if (mode === "current" && resolved) {
        sessionID = resolved.id;
        sessionTitle = resolved.title || null;
        source = sessionID === chatSessionID ? "chat" : "project";
      }

      // `new` mode — or nothing usable to reuse: create a fresh session that
      // inherits the project working directory.
      if (!sessionID) {
        const runDirectory =
          process.env.DISCORD_RUN_DIRECTORY || resolved?.directory || null;

        const created = await serverRequest("POST", "/api/session", {
          agent: process.env.DISCORD_RUN_AGENT || "build",
          ...(modelRef ? { model: modelRef } : {}),
          ...(runDirectory ? { location: { directory: runDirectory } } : {}),
        });
        source = "created";
        if (!created.ok) {
          return {
            ok: false,
            error: `Falha ao criar sessão (${created.status || "sem ligação"}).`,
          };
        }
        sessionID = created.data?.data?.id;
        if (!sessionID) {
          return { ok: false, error: "Falha ao criar sessão." };
        }

        if (mode === "new") {
          // Explicit New_Session: adopt it as the conversation the plugin
          // uses from now on (and keep learning it from app events).
          chatSessionID = sessionID;
          debugLog("chat:adopt", { sessionID, reason: "new-session" });
        } else {
          // Contextless fallback session — never treat it as "the chat".
          botSessions.add(sessionID);
        }
      }

      debugLog("run:session", {
        sessionID,
        source,
        mode,
        model: runModel,
        prompt,
      });

      const before = await serverRequest("GET", `/api/session/${sessionID}`);
      const beforeIdle = before.data?.data?.time?.idle ?? null;

      const promptSentAt = Date.now();
      const promptResult = await serverRequest(
        "POST",
        `/api/session/${sessionID}/prompt`,
        { text: prompt }
      );
      if (!promptResult.ok) {
        return {
          ok: false,
          error: "Falha ao enviar o prompt.",
          source,
          sessionTitle,
        };
      }

      const deadline = Date.now() + runTimeout;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));

        const current = await serverRequest("GET", `/api/session/${sessionID}`);
        const info = current.data?.data;
        if (!info) continue;

        const idle = info.time?.idle ?? null;
        const idleChanged = idle !== null && idle !== beforeIdle;
        if (!idleChanged) continue;

        // Idle can flip a moment before the streamed text is persisted, so
        // keep reading the transcript for a short while before giving up.
        const textDeadline = Math.min(deadline, Date.now() + 20_000);
        while (Date.now() < textDeadline) {
          const messages = await serverRequest(
            "GET",
            `/api/session/${sessionID}/message`
          );
          const output = extractAssistantText(
            messages.data?.data,
            promptSentAt
          );
          if (output) return { ok: true, output, source, sessionTitle };
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }

        return {
          ok: false,
          error: `Terminou (${info.outcome || "idle"}) sem texto de resposta.`,
          source,
          sessionTitle,
        };
      }

      return {
        ok: false,
        error: `Tempo limite excedido (${Math.round(runTimeout / 60_000)} min).`,
        source,
        sessionTitle,
      };
    };

    const buildFormAnswer = (text, form) => {
      const tokens = text
        .split(/[,\n;]+/)
        .map((token) => token.trim())
        .filter(Boolean);

      if (tokens.length === 0) return null;

      const freeTextFields = form.choices.filter(
        (choice) => choice.number === null
      );

      if (
        freeTextFields.length === form.choices.length &&
        form.choices.length === 1
      ) {
        return { [form.choices[0].key]: text.trim() };
      }

      const matched = [];

      for (const token of tokens) {
        const numeric = Number.parseInt(token.replace(/[^\d]/g, ""), 10);
        let choice = null;

        if (Number.isInteger(numeric)) {
          choice = form.choices.find((item) => item.number === numeric);
        }

        if (!choice) {
          choice = form.choices.find(
            (item) => item.label.toLowerCase() === token.toLowerCase()
          );
        }

        if (!choice) return null;
        matched.push(choice);
      }

      const answer = {};

      for (const choice of matched) {
        if (choice.type === "multiselect") {
          answer[choice.key] = [...(answer[choice.key] || []), choice.value];
        } else if (!(choice.key in answer)) {
          answer[choice.key] = choice.value;
        }
      }

      return answer;
    };

    const parsePermissionReply = (text) => {
      const value = text.trim().toLowerCase();

      if (["1", "once", "allow", "y", "yes", "sim", "s"].includes(value)) {
        return "once";
      }
      if (["2", "always", "sempre", "a"].includes(value)) {
        return "always";
      }
      if (["3", "reject", "deny", "no", "n", "não", "nao"].includes(value)) {
        return "reject";
      }

      return null;
    };

    const handleReply = async (text) => {
      if (pending.form) {
        const answer = buildFormAnswer(text, pending.form);

        if (!answer) {
          await sendMessage(
            `❓ <@${userId}> Não percebi. Responde com o número de uma das opções.`
          );
          return;
        }

        const label = Object.entries(answer)
          .map(
            ([key, value]) =>
              `${key}: ${Array.isArray(value) ? value.join(", ") : value}`
          )
          .join(" · ");

        const ok = await replyToForm(pending.form, answer);

        if (ok) {
          pending.form = null;
          await sendMessage(`✅ <@${userId}> Resposta enviada (${label}).`);
        } else {
          await sendMessage(
            `❌ <@${userId}> Não consegui enviar a resposta (o formulário pode já ter sido respondido).`
          );
        }
        return;
      }

      if (pending.permission) {
        const reply = parsePermissionReply(text);

        if (!reply) {
          await sendMessage(
            `❓ <@${userId}> Responde com: **1** (once) · **2** (always) · **3** (reject)`
          );
          return;
        }

        try {
          await replyToPermission(
            pending.permission.sessionID,
            pending.permission.requestID,
            reply
          );
          pending.permission = null;
          await sendMessage(`✅ <@${userId}> Permissão respondida: ${reply}.`);
        } catch (error) {
          console.error(
            "[discord-notification] permission reply failed:",
            error
          );
          await sendMessage(
            `❌ <@${userId}> Não consegui responder à permissão: ${
              error?.message ?? error
            }`
          );
        }
        return;
      }
    };

    const pollDiscord = async () => {
      if (replies.polling) return;
      if (botToken && !channelId) {
        await detectChannel();
      }
      if (!botToken || !channelId) return;

      replies.polling = true;

      try {
        const response = await fetch(
          `${DISCORD_API}/channels/${channelId}/messages?limit=10`,
          { headers: { Authorization: `Bot ${botToken}` } }
        );

        if (!response.ok) {
          if (response.status !== 429) {
            console.error(
              "[discord-notification] Discord read error:",
              response.status,
              await response.text()
            );
          }
          return;
        }

        const messages = await response.json();
        if (!Array.isArray(messages) || messages.length === 0) return;

        const ordered = [...messages].sort((a, b) =>
          BigInt(a.id) < BigInt(b.id) ? -1 : 1
        );
        const newest = ordered[ordered.length - 1].id;

        if (replies.lastMessageId === null) {
          replies.lastMessageId = newest;
          return;
        }

        for (const message of ordered) {
          if (BigInt(message.id) <= BigInt(replies.lastMessageId)) continue;
          replies.lastMessageId = message.id;

          if (message.author?.bot) continue;
          if (userId && String(message.author?.id) !== String(userId)) continue;

          const content = String(message.content || "").trim();
          if (!content) continue;

          await handleReply(content);
        }
      } catch (error) {
        console.error("[discord-notification] Poll failed:", error);
      } finally {
        replies.polling = false;
      }
    };

    const editInteraction = async (interaction, content) => {
      await botRequest(
        `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
        "PATCH",
        { content, components: [] }
      );
    };

    let slashRegistered = false;

    const registerSlashCommands = async () => {
      if (slashRegistered || !botToken) return;

      try {
        const app = await botRequest("/applications/@me");
        const appId = app.ok && app.data?.id ? String(app.data.id) : null;
        if (!appId) {
          console.error(
            "[discord-notification] Could not resolve the application id; skipping slash command registration"
          );
          return;
        }

        if (!channelId) {
          await detectChannel();
        }

        const channelInfo = channelId
          ? await botRequest(`/channels/${channelId}`)
          : null;
        const guildId = channelInfo?.data?.guild_id;
        if (!guildId) return;

        slashRegistered = true;

        const result = await botRequest(
          `/applications/${appId}/guilds/${guildId}/commands`,
          "PUT",
          [
            {
              name: "question",
              description: "Faz uma pergunta ou pedido ao OpenCode",
              options: [
                {
                  type: 3,
                  name: "prompt",
                  description: "O que queres que o OpenCode faça",
                  required: true,
                },
                {
                  type: 3,
                  name: "session",
                  description: "Onde correr: conversa atual ou uma sessão nova",
                  required: false,
                  choices: [
                    { name: "Current_Session", value: "current" },
                    { name: "New_Session", value: "new" },
                  ],
                },
                {
                  type: 3,
                  name: "session_id",
                  description:
                    "Sessão existente: nome (de /sessions), ID ou título",
                  required: false,
                  autocomplete: true,
                },
              ],
            },
            {
              name: "sessions",
              description: "Lista as sessões existentes e os seus nomes",
            },
          ]
        );

        console.log(
          "[discord-notification] slash /question registered:",
          result.status
        );
      } catch (error) {
        console.error(
          "[discord-notification] register slash command failed:",
          error
        );
      }
    };

    const handleCommandInteraction = async (interaction) => {
      const authorId = interaction.member?.user?.id || interaction.user?.id;
      const isOwner = isAuthorized(authorId);
      debugLog("command", {
        name: interaction.data?.name,
        authorId,
        isOwner,
        options: interaction.data?.options,
      });
      const reply = (data) =>
        botRequest(
          `/interactions/${interaction.id}/${interaction.token}/callback`,
          "POST",
          { type: 4, data }
        );

      if (!isOwner) {
        await reply({ content: "⛔ Este comando não é para ti.", flags: 64 });
        return;
      }

      if (interaction.data?.name === "sessions") {
        const sessions = await listProjectSessions(12);
        if (!sessions.length) {
          await reply({ content: "📭 Não há sessões de projeto.", flags: 64 });
          return;
        }
        const lines = sessions.map(
          (s) => `\`${s.alias}\` — ${truncate(s.title || "(sem título)", 80)}`
        );
        await reply({
          content: clamp(
            `**Sessões existentes** — usa o nome em \`session_id\`:\n\n${lines.join(
              "\n"
            )}`
          ),
          flags: 64,
        });
        return;
      }

      if (interaction.data?.name !== "question") {
        await reply({ content: "❓ Comando desconhecido.", flags: 64 });
        return;
      }

      const options = interaction.data?.options || [];
      const optionValue = (name) =>
        String(
          options.find((option) => option.name === name)?.value || ""
        ).trim();

      const prompt = optionValue("prompt");
      const mode = optionValue("session") === "new" ? "new" : "current";
      const sessionRef = optionValue("session_id");

      if (!prompt) {
        await reply({
          content:
            "⚠️ Escreve o prompt, ex.: `/question prompt:o que é um TCG?`",
          flags: 64,
        });
        return;
      }

      const authorName = interaction.member?.user?.username || "Discord";
      const modeLabel = sessionRef
        ? `sessão \`${sessionRef}\``
        : mode === "new"
        ? "sessão nova"
        : "conversa atual";

      await reply({
        content: `⏳ <@${userId}> **OpenCode a processar** (${modeLabel})…\n\n${truncate(
          prompt,
          500
        )}`,
        allowed_mentions: { users: [userId] },
      });

      const result = await runOpenCode(prompt, {
        mode,
        sessionID: sessionRef,
      });

      const usedTitle = result.sessionTitle
        ? `\n-# Sessão: ${truncate(result.sessionTitle, 120)}`
        : "";

      const createdNote =
        result.source === "created"
          ? mode === "new"
            ? "\n\n🆕 Criei uma sessão nova e passei a usá-la como **current session**."
            : "\n\n⚠️ Criei uma sessão nova (não havia nenhuma existente para usar)."
          : "";

      if (result.ok) {
        await sendToChannel(
          interaction.channel_id,
          `🤖 **Resultado** (para ${authorName}):\n${clamp(
            result.output
          )}${usedTitle}${createdNote}`
        );
      } else {
        await sendToChannel(
          interaction.channel_id,
          `❌ Falha ao executar (${authorName}): ${clamp(
            result.error,
            300
          )}${usedTitle}${createdNote}`
        );
      }
    };

    const handleAutocomplete = async (interaction) => {
      const focused = (interaction.data?.options || []).find((o) => o.focused);
      const typed = String(focused?.value || "").toLowerCase();

      let choices = [];
      try {
        choices = (await listProjectSessions(20))
          .filter(
            (s) =>
              !typed ||
              s.alias.toLowerCase().includes(typed) ||
              String(s.title).toLowerCase().includes(typed)
          )
          .slice(0, 25)
          .map((s) => ({
            name: `${s.alias} — ${truncate(
              s.title || "(sem título)",
              60
            )}`.slice(0, 100),
            value: s.alias,
          }));
      } catch {
        choices = [];
      }

      await botRequest(
        `/interactions/${interaction.id}/${interaction.token}/callback`,
        "POST",
        { type: 8, data: { choices } }
      );
    };

    const handleInteraction = async (interaction) => {
      if (interaction.type === 2) {
        await handleCommandInteraction(interaction);
        return;
      }
      if (interaction.type === 4) {
        await handleAutocomplete(interaction);
        return;
      }
      if (interaction.type !== 3) return;

      const customId = String(interaction.data?.custom_id || "");
      const parts = customId.split("|");
      if (parts[0] !== "oc") return;

      const authorId = interaction.member?.user?.id || interaction.user?.id;
      const isOwner = isAuthorized(authorId);

      if (!isOwner) {
        await botRequest(
          `/interactions/${interaction.id}/${interaction.token}/callback`,
          "POST",
          {
            type: 4,
            data: { content: "⛔ Esta escolha não é para ti.", flags: 64 },
          }
        );
        return;
      }

      await botRequest(
        `/interactions/${interaction.id}/${interaction.token}/callback`,
        "POST",
        { type: 6 }
      );

      const kind = parts[1];
      const token = parts[2];
      const number = Number.parseInt(parts[3], 10);

      if (kind === "f" && pending.form && pending.form.token === token) {
        const form = pending.form;
        const choice = form.choices.find((item) => item.number === number);

        if (!choice) {
          await editInteraction(interaction, "❌ Opção inválida.");
          return;
        }

        const ok = await replyToForm(form, { [choice.key]: choice.value });
        pending.form = null;
        writeStatus();
        await editInteraction(
          interaction,
          `✅ <@${userId}> escolheu: **${truncate(choice.label, 150)}**`
        );
        if (!ok) {
          await sendMessage(
            `❌ <@${userId}> Falha ao enviar a resposta (o formulário pode já ter sido respondido).`
          );
        }
        return;
      }

      if (
        kind === "p" &&
        pending.permission &&
        pending.permission.token === token
      ) {
        const permission = pending.permission;
        const choice = permissionChoices.find((item) => item.number === number);

        if (!choice) {
          await editInteraction(interaction, "❌ Opção inválida.");
          return;
        }

        try {
          await replyToPermission(
            permission.sessionID,
            permission.requestID,
            choice.value
          );
          pending.permission = null;
          writeStatus();
          await editInteraction(
            interaction,
            `✅ <@${userId}> Permissão respondida: **${choice.value}**`
          );
        } catch (error) {
          console.error(
            "[discord-notification] permission reply failed:",
            error
          );
          await editInteraction(
            interaction,
            `❌ Falha: ${error?.message ?? error}`
          );
        }
        return;
      }

      await editInteraction(
        interaction,
        "⚠️ Já não há nada pendente (talvez já tenha sido respondido)."
      );
    };

    const scheduleReconnect = () => {
      if (controller.signal.aborted) return;

      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
      reconnectTimer = setTimeout(() => {
        if (!controller.signal.aborted) void connectGateway();
      }, delay);
    };

    const connectGateway = async () => {
      if (!botToken || typeof WebSocket !== "function") return;

      let url = GATEWAY_URL;
      const info = await botRequest("/gateway/bot");
      if (info.ok && info.data?.url) {
        url = `${info.data.url}/?v=10&encoding=json`;
      }

      gatewayStatus = "connecting";
      writeStatus();

      let ws;
      try {
        ws = new WebSocket(url);
      } catch (error) {
        console.error("[discord-notification] gateway connect failed:", error);
        gatewayStatus = "connect-error";
        scheduleReconnect();
        return;
      }

      gateway = ws;
      let seq = null;

      const send = (payload) => {
        try {
          ws.send(JSON.stringify(payload));
        } catch {
          /* socket closed */
        }
      };

      ws.onopen = () => {
        gatewayStatus = "open";
        writeStatus();
      };

      ws.onclose = (event) => {
        gatewayStatus = `closed:${event?.code ?? "?"}`;
        writeStatus();
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        gateway = null;
        scheduleReconnect();
      };

      ws.onerror = () => {
        gatewayStatus = "error";
      };

      ws.onmessage = async (event) => {
        let payload;
        try {
          const raw =
            typeof event.data === "string"
              ? event.data
              : await event.data.text();
          payload = JSON.parse(raw);
        } catch {
          return;
        }

        const { op, d, s } = payload;
        if (s != null) seq = s;

        if (op === 10) {
          const interval = d?.heartbeat_interval ?? 45_000;
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = setInterval(() => send({ op: 1, d: seq }), interval);
          send({
            op: 2,
            d: {
              token: botToken,
              intents: 1,
              properties: {
                os: "windows",
                browser: "opencode",
                device: "opencode",
              },
            },
          });
        } else if (op === 1) {
          send({ op: 1, d: seq });
        } else if (op === 7 || op === 9) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        } else if (op === 0) {
          const eventName = payload.t;
          if (eventName === "READY") {
            gatewayStatus = "ready";
            reconnectDelay = 5000;
            writeStatus();
            void (async () => {
              await detectChannel();
              writeStatus();
              await registerSlashCommands();
            })();
          } else if (eventName === "INTERACTION_CREATE") {
            void handleInteraction(d);
          }
        }
      };
    };

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
        })) {
          const trackedSessionID = getSessionId(event);
          if (
            trackedSessionID !== "unknown-session" &&
            !botSessions.has(trackedSessionID)
          ) {
            if (chatSessionID !== trackedSessionID) {
              chatSessionID = trackedSessionID;
              debugLog("chat:track", {
                eventType: event.type,
                sessionID: trackedSessionID,
              });
            }
          }

          if (event.type === "form.replied" || event.type === "form.cancelled") {
            if (pending.form && event.data?.id === pending.form.formID) {
              pending.form = null;
            }
            continue;
          }

          if (event.type === "permission.replied") {
            pending.permission = null;
            continue;
          }

          const isCompletion = notifyEvents.has(event.type);
          const isAttention = attentionEvents.has(event.type);

          if (!isCompletion && !isAttention) continue;
          if (isAttention && !shouldNotifyAttention()) continue;
          if (isCompletion && !shouldNotify()) continue;

          if (isAttention) {
            const token = `${Date.now().toString(36)}${Math.floor(
              Math.random() * 1e6
            ).toString(36)}`;

            if (event.type === "form.created") {
              const form = event.data?.form;

              if (form) {
                const presentation = buildFormPresentation(form);
                const singleField =
                  new Set(presentation.choices.map((item) => item.key)).size <=
                    1 &&
                  presentation.choices.length > 0 &&
                  presentation.choices.every((item) => item.number !== null);

                pending.form = {
                  sessionID: form.sessionID,
                  formID: form.id,
                  title: form.title,
                  choices: presentation.choices,
                  token,
                };

                const canUseButtons =
                  Boolean(botToken) &&
                  Boolean(channelId) &&
                  singleField &&
                  presentation.choices.length <= 25;

                if (canUseButtons) {
                  const content = `📝 <@${userId}> OpenCode is waiting for you to choose!\n**${
                    truncate(form.title, 150) ||
                    "OpenCode is waiting for your choice"
                  }**\n\nClica numa opção 👇`;
                  const sent = await sendMessage(content, {
                    components: buildButtonComponents(
                      presentation.choices,
                      "f",
                      token
                    ),
                  });

                  if (!sent.ok) {
                    await sendMessage(getAttentionMessage(event));
                  }
                } else {
                  await sendMessage(getAttentionMessage(event));
                }

                writeStatus();
                continue;
              }
            } else if (event.type === "permission.asked") {
              pending.permission = {
                sessionID: event.data?.sessionID,
                requestID: event.data?.id,
                action: event.data?.action,
                token,
              };

              if (botToken && channelId) {
                const action = truncate(
                  event.data?.action || "an action",
                  150
                );
                const content = `🔐 <@${userId}> OpenCode needs your permission:\n\`${action}\`\n\nEscolhe 👇`;
                const sent = await sendMessage(content, {
                  components: buildButtonComponents(
                    permissionChoices,
                    "p",
                    token
                  ),
                });

                if (!sent.ok) {
                  await sendMessage(getAttentionMessage(event));
                }
              } else {
                await sendMessage(getAttentionMessage(event));
              }

              writeStatus();
              continue;
            }
          }

          console.log(
            "[discord-notification] Sending notification for",
            event.type,
            getSessionId(event)
          );

          await sendMessage(getMessage(event));
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error("[discord-notification] Error:", error);
        }
      }
    })();

    let pollTimer = null;

    if (botToken) {
      pollTimer = setInterval(() => void pollDiscord(), 3_000);
      void connectGateway();
      console.log("[discord-notification] Discord bot gateway enabled");
    } else {
      console.log(
        "[discord-notification] DISCORD_BOT_TOKEN missing, replies from Discord disabled"
      );
    }

    return () => {
      controller.abort();

      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);

      if (gateway) {
        try {
          gateway.close();
        } catch {
          /* ignore */
        }
        gateway = null;
      }

      if (globalThis[stateKey] === state) {
        delete globalThis[stateKey];
      }
    };
  },
};
