# OpenCode × Discord bridge

Liga o teu **OpenCode** (local, no teu PC) a um canal de **Discord**, para poderes
perguntar e responder a partir do telemóvel como se estivesses no terminal.

- `/question` — faz um pedido ao OpenCode e recebe a resposta no Discord.
- `/sessions` — lista as sessões existentes e dá a cada uma um **nome curto** (ex.: `loja-tcg`).
- Escolhes onde corre: **Current_Session** (a conversa aberta na app), **New_Session**
  (cria uma nova e passa a usá-la) ou uma sessão existente pelo **nome**, `session_id` ou `ID`.
- Perguntas de permissão e formulários do OpenCode aparecem como **botões** no Discord.

## Comandos

| Comando | O que faz |
| --- | --- |
| `/question prompt:<texto>` | Envia o pedido para a **conversa atual** (ou cria uma, se não houver). |
| `/question prompt:<texto> session:New_Session` | Cria uma sessão nova e passa a usá-la. |
| `/question prompt:<texto> session_id:<nome>` | Envia para uma sessão existente, pelo **nome** da lista do `/sessions`. |
| `/sessions` | Lista as sessões e os seus nomes. |

O campo `session_id` tem **autocomplete**: começa a escrever o nome e escolhe da lista.
O nome de cada sessão é derivado do título (ex.: `"Loja TCG – carrinho"` → `loja-tcg-carrinho`)
e guardado em `~/.config/opencode/discord-aliases.json`, por isso mantém-se estável.
Também podes usar o `ID` (`ses_...`) ou parte do título.


## Como funciona

```
Discord (bot) ──gateway──> plugin discord.js ──HTTP local──> servidor do OpenCode
```

O plugin corre **dentro** do OpenCode, fala com o servidor local (`/api/...`) e com
a API do Discord. Não há servidor alojado: tudo fica na tua máquina.

## Instalação (só precisas de colar um token)

### 1. Cria a app/bot no Discord (única parte manual, ~1 minuto)

A API do Discord **não permite** criar aplicações por script, por isso este passo é manual:

1. Vai a <https://discord.com/developers/applications> → **New Application**.
2. Aba **Bot**:
   - **Reset Token** → copia o token;
   - liga **Message Content Intent**.
3. Não precisas de mexer em permissões — o instalador dá-te o link de convite certo.

### 2. Corre o instalador

**macOS / Linux / Git Bash:**

```bash
git clone https://github.com/<teu-user>/opencode-discord-bridge.git
cd opencode-discord-bridge
./install.sh
```

**Windows (PowerShell):**

```powershell
git clone https://github.com/<teu-user>/opencode-discord-bridge.git
cd opencode-discord-bridge
powershell -ExecutionPolicy Bypass -File install.ps1
```

Cola o token. O instalador trata do resto **sozinho**:

1. valida o token e guarda-o em `~/.config/opencode/discord-bot-token`;
2. imprime o **link de convite** (com as permissões certas) e espera que adiciones o bot;
3. **escolhe o canal sozinho** (prefere `#general`) e guarda o `channel ID`;
4. **define o owner** como o dono do servidor e guarda o `user ID`;
5. copia o plugin para `~/.config/opencode/plugins/discord.js`.

### 3. Usa

Reinicia o OpenCode (ou deixa-o recarregar o plugin) e usa `/question` no canal.

Se o bot ainda não estava em nenhum servidor, o plugin **deteta o canal e o owner
automaticamente** na primeira vez — o primeiro a usar `/question` fica como owner.

## Configuração (variáveis de ambiente, todas opcionais)

Por defeito o plugin lê os ficheiros em `~/.config/opencode/`.

| Variável | Para quê |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Token do bot (alternativa ao ficheiro). |
| `DISCORD_USER_ID` | Único utilizador autorizado (alternativa: ficheiro). |
| `DISCORD_CHANNEL_ID` | Canal onde o bot fala (alternativa: ficheiro). |
| `DISCORD_RUN_MODEL` | Modelo para sessões novas, ex. `anthropic/claude-sonnet-4`. |
| `DISCORD_RUN_AGENT` | Agente para sessões novas (por defeito `build`). |
| `DISCORD_RUN_DIRECTORY` | Pasta de trabalho para sessões novas. |
| `DISCORD_RUN_TIMEOUT` | Timeout em ms (por defeito 600000). |

Ficheiros alternativos: `DISCORD_BOT_TOKEN_FILE`, `DISCORD_USER_ID_FILE`,
`DISCORD_CHANNEL_ID_FILE`.

## Segurança

- O instalador aponta o `user ID` para o **dono do servidor**; sem owner definido, o
  **primeiro** a usar `/question` passa a ser o único autorizado.
- O token fica só na tua máquina (`~/.config/opencode/`), nunca no repositório.
- O bot só precisa de *View Channel*, *Send Messages* e *Read Message History*.

## Desinstalar

```bash
./uninstall.sh
```

## Limitações

- O bot tem de correr no mesmo computador que o OpenCode (fala com `127.0.0.1`).
- Sem alojamento central: cada pessoa cria a sua app/bot (é mesmo assim que a API do
  Discord funciona). Uma versão "convida e pronto" exigiria um relay alojado.

## Licença

MIT.
