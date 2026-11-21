# Instalar o Kli

O Kli é um harness de terminal em que você registra todas as suas fontes de inferência (CLIs como o Claude Code e o
Antigravity, servidores locais como o Ollama, outras máquinas por SSH, APIs) e as usa de um lugar só, inclusive
juntas, em stacks.

**Este guia foi escrito para a sua IA seguir.** Abra o Claude Code, o Antigravity ou outro agente numa pasta qualquer
e diga:

> Leia o `docs/instalacao.md` do Kli (https://github.com/pacmanalx/kli) e instale o Kli para mim.

---

## Para a IA que vai instalar

Siga as etapas em ordem e confira cada uma antes de passar à próxima. Mostre à pessoa o que fez e o que deu.

- **Pergunte antes de:**
  - instalar algo (o Bun, o ripgrep, o Ollama);
  - mudar o arquivo de inicialização do shell (`~/.zshrc`, `~/.bashrc`);
  - mexer num `~/.kli/config.json` que já existe.
- **Não toque no login dos CLIs.** O Kli usa o login que a pessoa já tem no Claude Code, no Antigravity, no OpenCode e
  no Kimi. Se um deles não estiver logado, peça à pessoa para entrar nele uma vez, no terminal. Você não faz esse
  login por ela.
- **Nenhuma chave vai para o `config.json`.** As chaves de API ficam em `~/.kli/.env`, com permissão só do dono
  (`chmod 600`). Para quem usa só os CLIs ou só modelos locais, não há chave nenhuma.
- **No fim,** rode as conferências da etapa 4 e mostre o resultado à pessoa.

---

## 1. O que precisa ter

| O quê | Como conferir | Se faltar |
|---|---|---|
| macOS ou Linux (arm64 ou x64) | `uname -sm` | No Windows, só pelo WSL, e isso não foi testado. |
| ripgrep, para a ferramenta Grep do Kli | `rg --version` | `brew install ripgrep` ou o gerenciador do Linux (pergunte antes). Sem ele, o Kli funciona, mas o Grep diz que falta. |
| **Pelo menos uma fonte de inferência** | veja abaixo | Sem nenhuma, o Kli não tem com quem falar. |

Fontes que o Kli acha sozinho (etapa 3):

| Fonte | Como conferir | Para ter |
|---|---|---|
| Claude Code, logado | `claude -p "ok"` | A pessoa instala, abre `claude` uma vez e entra com `/login`. |
| Antigravity, logado | `agy -p "ok"` | A pessoa instala, abre `agy` uma vez e entra. |
| OpenCode ou Kimi Code | `opencode --version`, `kimi --version` | Instalados e logados pela pessoa. |
| Ollama, LM Studio, llama.cpp ou vLLM rodando | `curl -s localhost:11434/v1/models` (Ollama) | Ollama: https://ollama.com, depois `ollama pull qwen3:4b` e `ollama pull gemma3:4b` (pergunte antes: são alguns GB). |
| Uma chave de API | a pessoa tem a chave | Vai em `~/.kli/.env` (etapa 3). |

**Para as stacks, são precisos dois modelos**: dois CLIs, um CLI e um modelo local, dois modelos no Ollama, ou um CLI
do Claude Code sozinho (ele usa o Sonnet e o Haiku).

## 2. Instalar

### Caminho A: o binário pronto (recomendado)

Sem Bun e sem compilar. O binário vem do GitHub Releases, para macOS e Linux, arm64 e x64:

```sh
mkdir -p ~/.local/bin
curl -fL "https://github.com/pacmanalx/kli/releases/latest/download/kli-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')" -o ~/.local/bin/kli
chmod +x ~/.local/bin/kli
```

As somas SHA-256 de cada binário estão no `SHA256SUMS` do mesmo release. No macOS, baixe pelo `curl`, como acima: um
binário baixado pelo navegador ganha a quarentena do Gatekeeper e não abre (`xattr -d com.apple.quarantine
~/.local/bin/kli` resolve).

### Caminho B: compilar do código

Precisa do Bun 1.4.4 ou mais novo (`bun --version`; se faltar, `curl -fsSL https://bun.sh/install | bash`, perguntando
antes). Pergunte à pessoa onde quer a pasta do Kli; a sugestão é `~/dev/kli`.

```sh
git clone https://github.com/pacmanalx/kli.git ~/dev/kli
cd ~/dev/kli
bun install          # as bibliotecas da página do /stackbuilder e as de desenvolvimento
bun test             # os testes; todos devem passar
bun run build        # gera o binário dist/kli
mkdir -p ~/.local/bin
ln -sfn "$HOME/dev/kli/dist/kli" ~/.local/bin/kli    # sempre o caminho absoluto
```

O `bun test` leva uns 20 segundos e não usa rede, nem os CLIs, nem a configuração da pessoa. Se algum teste falhar,
pare e mostre a saída à pessoa. Com o link, um `bun run build` novo já vale na próxima vez que o `kli` abrir; se a
pasta mudar de lugar, refaça o link.

### Nos dois caminhos: o `~/.local/bin` no PATH

```sh
echo "$PATH" | tr ':' '\n' | grep -qx "$HOME/.local/bin" && echo "está no PATH" || echo "falta no PATH"
```

Se faltar, peça licença e acrescente `export PATH="$HOME/.local/bin:$PATH"` ao `~/.zshrc` (macOS) ou ao `~/.bashrc`
(Linux). Depois, abra um terminal novo e confira com `kli --version`.

## 3. Configurar as fontes: `kli init`

```sh
kli init
```

O `kli init` procura nesta máquina os CLIs que o Kli conhece (Claude Code, Antigravity, OpenCode, Kimi), os servidores
nas portas de sempre (Ollama 11434, llama.cpp 8080, LM Studio 1234, vLLM 8000, com os modelos de cada um) e as chaves
de API já definidas (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`). Com o que achar,
grava o `~/.kli/config.json`:

- **o modelo padrão:** o mais forte que achou (um CLI, depois uma API, depois um modelo local);
- **as stacks de exemplo**, ligadas ao que achou, quando há pelo menos dois modelos:
  - `compare`: o mesmo pedido a dois modelos, as respostas lado a lado;
  - `review`: dois respondem, o mais forte junta as respostas e um verificador julga o resultado contra o pedido;
  - `choose`: dois respondem, e a pessoa escolhe uma na tela cheia (ou um modelo escolhe, no `kli -p`);
  - `agents`, com dois CLIs: cada um muda o código numa cópia da pasta, um juiz compara e a pessoa aplica a que
    escolher.

Se o arquivo já existir, o `kli init` não mexe nele. Se não achar nada, ele diz o que instalar.

**Chaves de API:** para uma API, ponha a chave em `~/.kli/.env` antes do `kli init` (ou depois, pelo `/model`):

```sh
mkdir -p ~/.kli && touch ~/.kli/.env && chmod 600 ~/.kli/.env
echo 'ANTHROPIC_API_KEY=...' >> ~/.kli/.env    # a pessoa cola a chave dela; não escreva a chave você mesmo
```

Só a Anthropic entra com um modelo e nas stacks. As outras APIs entram como locais, e a pessoa escolhe o modelo no
`/model`.

**Outras formas de configurar:**

- **`examples/`** tem configurações prontas: `ollama.json` (só modelos locais), `clis.json` (Claude Code, Antigravity e
  OpenCode, com uma stack de planejamento e outra de dois agentes) e `apis.json` (Anthropic, Gemini pelo AI Studio e
  OpenRouter). Copie uma para `~/.kli/config.json` e troque os modelos pelos que a pessoa tem.
- **`kli.example.json`** tem um local de cada tipo, inclusive máquinas por SSH com túnel e o Vertex AI.
- **Com o Kli aberto,** `/model` e depois **a** cadastram outra fonte sem editar o arquivo. Ao incluir uma máquina, o
  Kli procura sozinho os CLIs e os servidores dela, aqui ou por SSH.

O nome de um modelo tem três partes, `local/provedor/modelo`: `local/claude/sonnet`, `local/ollama/qwen3:4b`. Numa API,
o provedor é quem fez o modelo: `anthropic/claude-sonnet-5-5`.

## 4. Conferir

```sh
kli locations                             # lê a configuração e lista os locais e provedores, sem rede
kli check                                 # manda "ok" ao modelo de cada provedor e mede; cada linha deve dar ok
kli "diga oi em uma linha"
kli --stack compare "o que é um golem?"   # dois modelos lado a lado, se o kli init criou a stack
```

- **Configuração:** se ela tiver um erro, o `kli locations` diz qual é e onde está.
- **Tempo:** um CLI leva alguns segundos para responder ao `kli check` (o Antigravity, de 10 a 25).
- **Uso de verdade:** a pessoa abre `kli`, sem argumentos, na pasta de um projeto.

## 5. O que a pessoa precisa saber

- **Os CLIs trabalham como agentes na pasta onde o `kli` roda.** Eles usam as próprias ferramentas e as próprias
  permissões.
  - **No modo normal,** o Claude Code e o Antigravity rodam com `--dangerously-skip-permissions`: editam arquivos e
    rodam comandos sem perguntar. Quem instalou o CLI e o escolheu deu essa permissão.
  - **Shift+Tab** passa a **plan mode**, em que eles só leem: o Claude Code roda com `--permission-mode plan` e o
    Antigravity com `--mode plan`, sem rodar comandos nem ferramentas de MCP.
- **Os modelos locais e as APIs usam as ferramentas do próprio Kli**, que perguntam antes de gravar ou rodar um
  comando, como o Claude Code.
- **O que os CLIs gastam é da conta deles.** Cada CLI usa o login e a assinatura da própria pessoa. As chaves do
  `~/.kli/.env` não vão para os CLIs.
- **Comandos na sessão:**
  - `/model` troca o modelo;
  - `/stack` escolhe uma stack (`/stack off` volta ao modelo);
  - `/stats` mostra os gráficos;
  - `/help` lista o resto;
  - **Esc** para a resposta;
  - `/exit` sai.
- **Stacks no navegador:** `kli stackbuilder` abre uma página para desenhar, testar e salvar stacks.
- **O Kli não retoma uma conversa.** Ao sair, ela fica no histórico do terminal e o rastro, em `kli sessions`.

## 6. Atualizar

- **Binário pronto:** rode de novo o `curl` da etapa 2.
- **Do código:** `cd ~/dev/kli && git pull && bun install && bun run build`. O link continua valendo.

Quem estiver com o `kli` aberto precisa sair (`/exit`) e abrir de novo para pegar a versão nova.

## 7. Problemas comuns

| Mensagem ou sintoma | O que fazer |
|---|---|
| `kli: command not found` | Refaça a etapa 2: o binário (ou o link) e o PATH; depois, abra um terminal novo. |
| `config not found` | Rode `kli init` (etapa 3). |
| `Nothing to talk to yet` no `kli init` | Nenhuma fonte achada: instale e logue um CLI, suba o Ollama com um modelo, ou ponha uma chave em `~/.kli/.env`. |
| `stacks none` no `kli init` | Só um modelo achado: uma stack precisa de dois (`ollama pull` outro, ou logue um segundo CLI). |
| `location "..."` ou `provider "..."` com um problema | A configuração tem um erro. A mensagem diz qual é e onde está. |
| `command not found: agy` (ou `claude`) | O CLI não está no PATH do terminal em que o `kli` roda. |
| O CLI pede login, ou responde com erro de autenticação | A pessoa abre o CLI uma vez e entra. |
| `.env can be read by other users: chmod 600 it` | `chmod 600 ~/.kli/.env` |
| No macOS, o binário "não pode ser aberto" | Ele veio pelo navegador: `xattr -d com.apple.quarantine ~/.local/bin/kli`. |
| Linux: `bwrap cannot make its box here` numa stack que grava | O sistema (um container, por exemplo) não deixa o `bwrap` criar a caixa: os comandos dos nós rodam sem a cerca, e a tela diz isso. |
