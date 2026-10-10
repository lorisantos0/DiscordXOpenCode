#!/usr/bin/env bash
# OpenCode x Discord bridge - uninstaller
set -euo pipefail

CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

rm -f "$CONFIG_DIR/plugins/discord.js"
rm -f "$CONFIG_DIR/discord-bot-token"
rm -f "$CONFIG_DIR/discord-user-id"
rm -f "$CONFIG_DIR/discord-channel-id"

echo "Removido. Reinicia o OpenCode."
