# OpenCode x Discord bridge - installer (Windows / PowerShell)
# Usage:  powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = "Stop"

$ConfigDir = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $HOME ".config\opencode" }
$PluginDir = Join-Path $ConfigDir "plugins"
$SelfDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$Api       = "https://discord.com/api/v10"
$Permissions = 68608

function Say($m)  { Write-Host $m -ForegroundColor Cyan }
function Ok($m)   { Write-Host $m -ForegroundColor Green }
function Warn($m) { Write-Host $m -ForegroundColor Yellow }
function Err($m)  { Write-Host $m -ForegroundColor Red }

if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
  Err "curl.exe nao encontrado (vem no Windows 10+). A abortar."
  exit 1
}

# GET a Discord API path, returning parsed JSON (or $null).
function DiscordGet($token, $path) {
  $tmp = New-TemporaryFile
  try {
    curl.exe -s -f -H "Authorization: Bot $token" "$Api$path" -o $tmp | Out-Null
    if ($LASTEXITCODE -ne 0) { return $null }
    return (Get-Content -Raw $tmp | ConvertFrom-Json)
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
}

Say "==> OpenCode x Discord - instalacao"
Write-Host ""
Write-Host "Cria a app/bot em https://discord.com/developers/applications (1 min):"
Write-Host "  New Application -> Bot -> Reset Token -> copia o token."
Write-Host "  (aba Bot: liga tambem 'Message Content Intent')"
Write-Host ""
$secure = Read-Host -Prompt "Cola o token do bot" -AsSecureString
$token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if ([string]::IsNullOrWhiteSpace($token)) { Err "Token vazio. A abortar."; exit 1 }

$app = DiscordGet $token "/applications/@me"
if ($null -eq $app) { Err "Token invalido (a API do Discord rejeitou)."; exit 1 }

New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
Set-Content -Path (Join-Path $ConfigDir "discord-bot-token") -Value $token -NoNewline -Encoding ascii
Ok "  Bot:    $($app.name)"
Ok "  Guardei o token em $((Join-Path $ConfigDir 'discord-bot-token'))"

$invite = "https://discord.com/oauth2/authorize?client_id=$($app.id)&scope=bot%20applications.commands&permissions=$Permissions"
Write-Host ""
Warn "Convida o bot para o teu servidor:"
Write-Host "  $invite"
Write-Host ""

$guildId = $null
for ($i = 1; $i -le 5; $i++) {
  $guilds = @(DiscordGet $token "/users/@me/guilds")
  if ($guilds.Count -eq 1) { $guildId = $guilds[0].id; break }
  if ($guilds.Count -gt 1) { break }
  Read-Host "Prime Enter depois de adicionares o bot ao servidor" | Out-Null
}

if (-not $guildId -and $guilds.Count -gt 1) {
  Write-Host "Servidores:"
  for ($i = 0; $i -lt $guilds.Count; $i++) { Write-Host ("  {0}. {1}" -f ($i + 1), $guilds[$i].name) }
  $gn = [int](Read-Host "Numero do servidor")
  $guildId = $guilds[$gn - 1].id
}

if (-not $guildId) {
  Warn "Bot ainda nao esta em nenhum servidor."
  Warn "O plugin vai detetar o canal sozinho quando entrares num servidor."
} else {
  $channels = @(DiscordGet $token "/guilds/$guildId/channels" | Where-Object { $_.type -eq 0 })
  $pref = '^(general|geral|chat|opencode|bot|bots)$'
  $pick = $channels | Where-Object { $_.name -match $pref } | Select-Object -First 1
  if (-not $pick) { $pick = $channels | Select-Object -First 1 }
  if ($pick) {
    Set-Content -Path (Join-Path $ConfigDir "discord-channel-id") -Value $pick.id -NoNewline -Encoding ascii
    Ok "  Canal:  #$($pick.name)"
  } else {
    Warn "Nao encontrei canais de texto; o plugin escolhe sozinho."
  }

  $guild = DiscordGet $token "/guilds/$guildId"
  if ($guild -and $guild.owner_id) {
    Set-Content -Path (Join-Path $ConfigDir "discord-user-id") -Value $guild.owner_id -NoNewline -Encoding ascii
    Ok "  Owner:  $($guild.owner_id) (dono do servidor)"
  } else {
    Warn "Owner sera definido por quem usar /question primeiro."
  }
}

New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
Copy-Item (Join-Path $SelfDir "plugin\discord.js") (Join-Path $PluginDir "discord.js") -Force
Ok "  Plugin: $((Join-Path $PluginDir 'discord.js'))"

Write-Host ""
Ok "==> Tudo pronto."
Write-Host "Se o OpenCode ja estava a correr, recarrega o plugin (ou reinicia)."
Write-Host "Usa /question no canal. Opcional: `$env:DISCORD_RUN_MODEL='provider/model'"
