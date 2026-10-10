# OpenCode × Discord bridge

[![GitHub](https://img.shields.io/badge/GitHub-lorisantos0%2FDiscordXOpenCode-181717?logo=github)](https://github.com/lorisantos0/DiscordXOpenCode)

> Repositório: <https://github.com/lorisantos0/DiscordXOpenCode>

Liga o teu **OpenCode** (local, no teu PC) a um canal de **Discord**, para poderes
perguntar e responder a partir do telemóvel como se estivesses no terminal.

- `/question` — faz um pedido ao OpenCode e recebe a resposta no Discord.
- `/sessions` — lista as sessões existentes e dá a cada uma um **nome curto** (ex.: `loja-tcg`).
- Escolhes onde corre: **Current_Session** (a conversa aberta na app), **New_Session**
  (cria uma nova e passa a usá-la) ou uma sessão existente pelo **nome**, `session_id` ou `ID`.
- Perguntas de permissão e formulários do OpenCode aparecem como **botões** no Discord.

## Como funciona

```
Discord (bot) ──gateway──> plugin discord.js ──HTTP local──> servidor do OpenCode
```

O plugin corre **dentro** do OpenCode, fala com o servidor local (`/api/...`) e com
a API do Discord. Não há servidor alojado: tudo fica na tua máquina.

## Requisitos

- [OpenCode](https://opencode.ai) instalado e a correr.
- `node` no PATH.
- `curl` (para o instalador; já vem no Windows 10+, macOS e na maior parte das distros).
- `git` (para clonar) — ou descarrega o ZIP.
- Uma conta de Discord com permissão para adicionar bots ao servidor (precisas de ser
  **dono do servidor** ou ter o cargo *Manage Server*).

---

## Instalação

São 3 passos: **criar a app/bot**, **adicioná-lo ao servidor** e **correr o instalador**.

### 1. Cria a app/bot no Discord (~1 minuto)

A API do Discord **não permite** criar aplicações por script, por isso este passo é manual:

1. Vai a <https://discord.com/developers/applications> e faz login.
2. Clica em **New Application** → dá um nome (ex.: `OpenCode`) → **Create**.
3. Aba **Bot** (menu lateral):
   - **Reset Token** → **Copy** (é o token que o instalador te vai pedir; **guarda-o bem**,
     só aparece uma vez — se o perderes, faz *Reset Token* outra vez);
   - liga **Message Content Intent** (é preciso para o bot ler as respostas que escreves
     no canal);
   - (opcional) desliga **Public Bot** se quiseres que só tu o possas adicionar.

### 2. Adiciona o bot ao teu servidor (convite)

Não precisas de montar o link: o **instalador (passo 3) gera-o** com as permissões
certas e mostra-o no terminal. Quando ele aparecer:

1. Abre o link no browser;
2. escolhe o **servidor** no dropdown **Add to Server**;
3. **Authorize** → resolve o captcha.

> Também podes adicionar o bot a um canal específico depois: abre o **URL do canal →
> Editar Canal → Permissões** e adiciona o bot, ou usa o cargo do bot.

### 3. Corre o instalador

**macOS / Linux / Git Bash:**

```bash
git clone https://github.com/lorisantos0/DiscordXOpenCode.git
cd DiscordXOpenCode
./install.sh
```

**Windows (PowerShell):**

```powershell
git clone https://github.com/lorisantos0/DiscordXOpenCode.git
cd DiscordXOpenCode
powershell -ExecutionPolicy Bypass -File install.ps1
```

Cola o token. O instalador trata do resto **sozinho**:

1. valida o token e guarda-o em `~/.config/opencode/discord-bot-token`;
2. imprime o **link de convite** (com as permissões certas) e espera que adiciones o bot
   — se já o adicionaste, avança logo;
3. **escolhe o canal sozinho** (prefere `#general`) e guarda o `channel ID`;
4. **define o owner** como o dono do servidor e guarda o `user ID`;
5. pergunta o **modelo** para as sessões novas (pré-preenchido com
   `opencode/big-pickle` — carrega Enter para aceitar) e guarda-o em `discord-run-model`;
6. copia o plugin para `~/.config/opencode/plugins/discord.js`.

### 4. Usa

Reinicia o OpenCode (ou deixa-o recarregar o plugin) e usa `/question` no canal.

Se o bot ainda não estava em nenhum servidor, o plugin **deteta o canal e o owner
automaticamente** na primeira vez — o primeiro a usar `/question` fica como owner.

---

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

**Exemplos:**

```
/question prompt:resume o estado do projeto
/question prompt:começa o carrinho session:New_Session
/question prompt:adiciona o filtro de graded session_id:loja-tcg-carrinho
/sessions
```

---

## Configuração

Tudo é opcional: o instalador já escreve os ficheiros por defeito em `~/.config/opencode/`.

### Ficheiros locais

| Ficheiro | Conteúdo |
| --- | --- |
| `discord-bot-token` | Token do bot. |
| `discord-user-id` | Único utilizador autorizado a dar comandos. |
| `discord-channel-id` | Canal onde o bot fala. |
| `discord-aliases.json` | Nome curto de cada sessão (`{ "ses_...": "loja-tcg" }`). |
| `discord-run-model` | Modelo para sessões novas, ex. `opencode/big-pickle` (opcional). |

Todos ficam **fora** do repositório e no `.gitignore`.

> **Modelo das sessões novas.** Se `discord-run-model` (ou `DISCORD_RUN_MODEL`) não estiver
> definido, a sessão nova **herda o modelo da sessão atual do projeto** — evita cair no
> modelo por defeito do servidor, que pode estar descontinuado.

### Variáveis de ambiente

| Variável | Para quê |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Token do bot (alternativa ao ficheiro). |
| `DISCORD_USER_ID` | Único utilizador autorizado (alternativa: ficheiro). |
| `DISCORD_CHANNEL_ID` | Canal onde o bot fala (alternativa: ficheiro). |
| `DISCORD_RUN_MODEL` | Modelo para sessões novas, ex. `opencode/big-pickle` (alternativa: ficheiro). |
| `DISCORD_RUN_AGENT` | Agente para sessões novas (por defeito `build`). |
| `DISCORD_RUN_DIRECTORY` | Pasta de trabalho para sessões novas. |
| `DISCORD_RUN_TIMEOUT` | Timeout em ms (por defeito 600000). |

Ficheiros alternativos: `DISCORD_BOT_TOKEN_FILE`, `DISCORD_USER_ID_FILE`,
`DISCORD_CHANNEL_ID_FILE`, `DISCORD_ALIASES_FILE`, `DISCORD_RUN_MODEL_FILE`.

### Onde obter os IDs (se precisares de os pôr à mão)

- **User ID** (o teu): Discord → **Definições → Avançadas → Modo de programador** (liga),
  depois clica no teu nome → **Copiar ID**.
- **Channel ID**: com o Modo de programador ligado, clica com o botão direito no canal →
  **Copiar ID**.

---

## Segurança

- O instalador aponta o `user ID` para o **dono do servidor**; sem owner definido, o
  **primeiro** a usar `/question` passa a ser o único autorizado.
- Os comandos (`/question`, `/sessions`) só respondem ao owner; os outros levam
  *"Este comando não é para ti"*.
- O token fica só na tua máquina (`~/.config/opencode/`), nunca no repositório.
- O bot só precisa de *View Channel*, *Send Messages* e *Read Message History*.

---

## Troubleshooting

| Sintoma | O que fazer |
| --- | --- |
| Não vejo `/question` ou `/sessions` no Discord | Os slash commands são registados por servidor. Faz **Ctrl+R** no Discord; se não aparecer, expulsa e reconvida o bot (o registo acontece quando o plugin liga). |
| O bot está online mas não responde | Confirma que ligaste **Message Content Intent** (aba Bot) e reinicia o OpenCode. |
| `Token invalido` no instalador | O token está errado ou foi resetado — faz **Reset Token** e copia de novo. |
| `Nothing configured` nos logs | O plugin não encontrou o token — corre o instalador. |
| O bot responde a mais pessoas | Define o owner (corre o instalador ou escreve o teu ID em `~/.config/opencode/discord-user-id`). |
| Respostas no canal errado | Escreve o channel ID em `~/.config/opencode/discord-channel-id` e reinicia. |

---

## Desinstalar

```bash
./uninstall.sh
```

Remove o plugin e os ficheiros de config (`discord-*`) de `~/.config/opencode/`.

## Limitações

- O bot tem de correr no mesmo computador que o OpenCode (fala com `127.0.0.1`).
- Sem alojamento central: cada pessoa cria a sua app/bot (é mesmo assim que a API do
  Discord funciona). Uma versão "convida e pronto" exigiria um relay alojado.

## Licença

MIT.
