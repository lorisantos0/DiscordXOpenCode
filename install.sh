#!/usr/bin/env bash
# OpenCode x Discord bridge - installer
# Usage:  ./install.sh
set -euo pipefail

CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
PLUGIN_DIR="$CONFIG_DIR/plugins"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API="https://discord.com/api/v10"
PERMISSIONS=68608 # View Channel + Send Messages + Read Message History

say()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
err()  { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }

need() { command -v "$1" >/dev/null 2>&1 || { err "Falta '$1' no PATH."; exit 1; }; }
need curl
need node

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# JSON array (stdin) -> "n<TAB>name<TAB>id" lines.
enumerate() {
  local field="${1:-name}"
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try {
        JSON.parse(s).forEach((x, i) =>
          console.log([i + 1, x["'"$field"'"], x.id].join("\t")));
      } catch {}
    });
  '
}

# Read a top-level string field from a JSON file.
json_field() {
  node -e '
    try {
      const j = require(process.argv[1]);
      process.stdout.write(String(j[process.argv[2]] ?? ""));
    } catch {}
  ' "$1" "$2"
}

say "==> OpenCode x Discord - instalacao"
echo

# --- 1. Token (the only thing you type) --------------------------------------
echo "Cria a app/bot em https://discord.com/developers/applications (1 min):"
echo "  New Application -> Bot -> Reset Token -> copia o token."
echo "  (aba Bot: liga tambem 'Message Content Intent')"
echo
read -rsp "Cola o token do bot: " TOKEN
echo
[ -n "${TOKEN:-}" ] || { err "Token vazio. A abortar."; exit 1; }

if ! printf '%s' "$TOKEN" | curl -s -f -H "Authorization: Bot $TOKEN" \
      "$API/applications/@me" -o "$TMP_DIR/app.json"; then
  err "Token invalido (a API do Discord rejeitou). Confirma e volta a tentar."
  exit 1
fi

mkdir -p "$CONFIG_DIR"
umask 077
printf '%s' "$TOKEN" > "$CONFIG_DIR/discord-bot-token"
chmod 600 "$CONFIG_DIR/discord-bot-token" 2>/dev/null || true

APP_ID="$(json_field "$TMP_DIR/app.json" id)"
APP_NAME="$(json_field "$TMP_DIR/app.json" name)"
ok "  Bot:    $APP_NAME"
ok "  Guardei o token em $CONFIG_DIR/discord-bot-token"

INVITE="https://discord.com/oauth2/authorize?client_id=${APP_ID}&scope=bot%20applications.commands&permissions=${PERMISSIONS}"

# --- 2. Make sure the bot is in a server -------------------------------------
echo
warn "Convida o bot para o teu servidor:"
echo "  $INVITE"

GUILD_ID=""
for attempt in 1 2 3 4 5; do
  curl -s -H "Authorization: Bot $TOKEN" "$API/users/@me/guilds" -o "$TMP_DIR/guilds.json"
  enumerate name < "$TMP_DIR/guilds.json" > "$TMP_DIR/guilds.txt" || true
  COUNT="$(wc -l < "$TMP_DIR/guilds.txt" | tr -d ' ')"
  if [ "$COUNT" = "1" ]; then
    GUILD_ID="$(awk -F'\t' 'NR==1{print $3}' "$TMP_DIR/guilds.txt")"
    break
  elif [ "$COUNT" -gt 1 ]; then
    break
  fi
  read -rp "Prime Enter depois de adicionares o bot ao servidor..." _
done

if [ -z "$GUILD_ID" ] && [ -s "$TMP_DIR/guilds.txt" ]; then
  echo "Servidores:"
  cat "$TMP_DIR/guilds.txt"
  read -rp "Numero do servidor: " GN
  GUILD_ID="$(awk -F'\t' -v n="$GN" '$1 == n { print $3; exit }' "$TMP_DIR/guilds.txt")"
fi

if [ -z "$GUILD_ID" ]; then
  warn "Bot ainda nao esta em nenhum servidor."
  warn "O plugin vai detetar o canal sozinho quando entrares num servidor."
else
  # --- 3. Auto channel -------------------------------------------------------
  curl -s -H "Authorization: Bot $TOKEN" \
    "$API/guilds/${GUILD_ID}/channels" -o "$TMP_DIR/channels.json"
  CHANNEL_ID="$(node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const text = JSON.parse(s).filter(c => c.type === 0);
        const pref = /^(general|geral|chat|opencode|bot|bots)$/i;
        const pick = text.find(c => pref.test(c.name)) || text[0];
        if (pick) process.stdout.write(String(pick.id));
      } catch {}
    });
  ' < "$TMP_DIR/channels.json")"

  if [ -n "$CHANNEL_ID" ]; then
    printf '%s' "$CHANNEL_ID" > "$CONFIG_DIR/discord-channel-id"
    ok "  Canal:  #$(node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{const c=JSON.parse(s).find(c=>String(c.id)===process.argv[1]);process.stdout.write(c?c.name:"?")}catch{}
      });' "$CHANNEL_ID" < "$TMP_DIR/channels.json")"
  else
    warn "Nao encontrei canais de texto; o plugin escolhe sozinho."
  fi

  # --- 4. Auto owner (server owner) -----------------------------------------
  curl -s -H "Authorization: Bot $TOKEN" "$API/guilds/${GUILD_ID}" -o "$TMP_DIR/guild.json"
  OWNER_ID="$(json_field "$TMP_DIR/guild.json" owner_id)"
  if [ -n "$OWNER_ID" ]; then
    printf '%s' "$OWNER_ID" > "$CONFIG_DIR/discord-user-id"
    ok "  Owner:  $OWNER_ID (dono do servidor)"
  else
    warn "Owner sera definido por quem usar /question primeiro."
  fi
fi

# --- 5. Default model for new sessions ---------------------------------------
# Without this, a new session falls back to the server default, which may point
# at a deprecated model (e.g. a retired free model) and fail with no reply.
echo
read -rp "Modelo para sessoes novas [opencode/big-pickle]: " RUN_MODEL
RUN_MODEL="${RUN_MODEL:-opencode/big-pickle}"
printf '%s' "$RUN_MODEL" > "$CONFIG_DIR/discord-run-model"
ok "  Modelo: $RUN_MODEL"

# --- 6. Install the plugin last (so a running OpenCode hot-reloads it) -------
mkdir -p "$PLUGIN_DIR"
cp -f "$SELF_DIR/plugin/discord.js" "$PLUGIN_DIR/discord.js"
chmod 644 "$PLUGIN_DIR/discord.js" 2>/dev/null || true
ok "  Plugin: $PLUGIN_DIR/discord.js"

echo
ok "==> Tudo pronto."
echo "Se o OpenCode ja estava a correr, recarrega o plugin (ou reinicia)."
echo "Usa /question no canal."
