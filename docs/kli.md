# Kli — o harness de estudo (v0.1, 30/10/2026)

**Kli** (כלי) quer dizer "instrumento", "ferramenta", "vaso". Na Cabala, os *kelim* são os vasos que recebem e
conduzem a luz.

## Papel

- **O que é:** um harness de terminal em que qualquer pessoa registra todas as suas fontes de inferência (servidores
  locais, outras máquinas por SSH, APIs e outros CLIs) e as usa de um lugar só: escolher e trocar de modelo, reserva,
  rastro, estatísticas, ferramentas e stacks, que juntam vários modelos numa resposta.
- **Também é um laboratório:** o Kli mede como cada modelo e cada harness se comporta, e o que se aprende muda o
  próprio Kli. As decisões ficam registradas aqui, com a data.
- **O núcleo fica numa biblioteca separada do comando de terminal.** Assim, o que der certo pode ser levado a outro
  lugar sem arrastar o CLI junto.

## Escopo atual

- **Só texto.** O multimodal entra depois.
- **Comando:** `kli`, binário único compilado com o Bun.
- **Idioma:** o harness é todo em inglês (comandos, opções, status, mensagens, configuração, rastro e código), como
  os harnesses de mercado. Quem decide a língua da conversa é o modelo: as instruções pedem para responder na
  língua de quem escreve. Estes documentos da equipe seguem em português.
- **Stack:** TypeScript no Bun. O acesso aos provedores é HTTP direto (sem SDK) e o laço é nosso (sem framework de
  agente), para que o que se aprende valha fora dele, em qualquer linguagem.

## Mascote

O golem de barro: o *kli* é o vaso de barro e o golem é feito do mesmo barro. Os olhos e a inscrição *emet*
(אמת, "verdade") na testa acendem quando ele está ativo. Na lenda, apagar o aleph deixa *met* (מת, "morto") e o
golem para: é o que aparece ao sair (`met · bye`).

Na tela cheia ele acompanha o que o Kli está fazendo (`src/cli/animation.ts`):

| Momento | O golem |
|---|---|
| Abriu o Kli | dá oi (acena por 1,2 s) |
| Parado | pisca a cada 3 s e dá tchau a cada 30 s sem ninguém digitar (cada tecla zera a contagem) |
| Esperando o modelo | anda sem sair do lugar |
| Recebendo a resposta | anda mais rápido, e a inscrição se escreve letra por letra, da direita para a esquerda |
| A reserva entrou | balança a cabeça e volta a andar |
| Erro | desaba e fica sentado sem o aleph (*met*) até a próxima pergunta |
| 5 min sem tecla | dorme: olhos fechados e inscrição apagada; qualquer tecla acorda |

A tela só redesenha quando a pose muda, e dormindo não roda nada. `KLI_ANIMATION=off` deixa o golem parado (menos
movimento na tela, ou terminal lento por SSH). `kli golem` mostra todas as poses.

```
  ▟████▙
  █▄██▄█
  ▜████▛
 ▐▌████▐▌
 ▝▘█▌▐█▝▘
```

## Rodar, testar, compilar

Para instalar numa máquina nova, inclusive a de outra pessoa, siga o `docs/instalacao.md`. Ele foi escrito para a IA
da pessoa (Claude Code, Antigravity) seguir: pré-requisitos, build, link no PATH, a configuração com os CLIs e as
conferências.

```
bun install                 # só as dependências de desenvolvimento (tipos e tsc)
bun run dev "pergunta"      # roda direto do código
bun test                    # testes
bun run typecheck           # confere os tipos
bun run build               # gera dist/kli
bun run dev init            # grava ~/.kli/config.json com as fontes desta máquina
```

Os túneis até as outras máquinas não precisam ser abertos à mão: o Kli abre os dele quando precisa.

Códigos de saída: `0` ok, `1` falha do provedor, `2` erro de uso ou de configuração, `130` interrompido.

## Como se usa

```
kli "quanto é 25% de 80?"          # responde e sai (o mesmo que kli -p "...")
kli                                # sessão interativa
git diff | kli "revise"            # o que vem pela entrada padrão vira contexto
kli -m mac/ollama/lfm3 "..."       # escolhe o modelo: local/provedor/modelo
kli --stack compare "..."          # uma stack responde, desta vez (ver Model stacks)
kli init                           # acha as fontes desta máquina e grava a configuração, com stacks de exemplo
kli locations                      # locais e provedores: onde ficam, modelo padrão, credenciais (sem rede)
kli models [onde]                  # os modelos que um local ou provedor oferece (kli models gibbor/ollama)
kli check [onde]                   # manda "ok" para o modelo padrão de cada provedor (ou de um) e mede
kli sessions [id]                  # as últimas sessões, ou o rastro de uma
kli stats [--days N]               # gráficos do rastro: desfechos, latência e tokens por modelo, respostas por dia
kli golem                          # o mascote e as poses
```

**Começar: `kli init`** (21/11/2026). Sem configuração, o Kli manda rodar o `kli init`. Ele procura nesta máquina os
CLIs que conhece (no `PATH`), os servidores nas portas de sempre, com os modelos que servem (os de embedding ficam de
fora), e as chaves de API já definidas (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`,
`OPENAI_API_KEY`, no ambiente ou no `~/.kli/.env`). Grava em `$KLI_CONFIG` ou `~/.kli/config.json`, e nunca por cima
de um arquivo que já existe. A máquina vira o local `local`; o modelo padrão é o mais forte que achou (um CLI, depois
uma API com modelo, depois um modelo local). Com dois modelos ou mais, entram as stacks `compare`, `review` e
`choose`, com dois modelos de servidores ou CLIs diferentes quando há, e o mais forte juntando, escolhendo e julgando;
com dois CLIs, também a `agents` (cada um grava numa cópia, um juiz compara). O Claude Code sozinho já faz par: o
Sonnet e o Haiku. Só a Anthropic entra com modelo: as outras APIs ficam como locais, para escolher o modelo no
`/model`. Sem nada achado, o `kli init` não grava e diz o que instalar. O `examples/` tem configurações prontas (só
Ollama, só CLIs, só APIs).

Na sessão (tela cheia): `/model` abre os locais, e `/model mac/ollama/lfm3` troca direto (detalhes abaixo); `/stack`
escolhe uma stack para responder no lugar do modelo (`/stack off` volta ao modelo); `/stats` mostra os gráficos da sessão, `/jobs` os comandos em segundo plano, `/new` (ou `/clear`), `/status`, `/help`, `/exit` (ou `/quit`, ou só `exit` ou `quit`, como no Claude Code); `!comando` roda um comando
você mesmo; Esc ou Ctrl+C interrompe só a resposta; Ctrl+B manda para o segundo plano o comando que está rodando;
↑/↓ trazem os prompts anteriores.

**A conversa fica no terminal**, como no Claude Code: cada pergunta, resposta, ferramenta e stack que termina vai para
o histórico de rolagem do próprio terminal, então rolar para cima (a roda do mouse, o trackpad, Shift+PgUp) chega até
o começo da sessão, e uma resposta maior que a tela vai para lá linha a linha, enquanto chega. Só a parte de baixo é
redesenhada no lugar: o que ainda está mudando (a resposta chegando, a ferramenta rodando, a stack trabalhando), o
golem com o status, a linha de digitação e as dicas. Ao mudar o tamanho da janela, a conversa é impressa de novo na
largura nova (Ctrl+L faz o mesmo), e `/new` limpa a tela. O `!comando` roda logo abaixo da conversa, e o que ele
imprime fica ali. Ao sair, a conversa continua no terminal.

**A resposta aparece com o markdown desenhado** (10/11), como no Claude Code, em todo modelo (servidor, API ou CLI) e
nas colunas de uma stack (`src/cli/markdown.ts`). Os modelos respondem em markdown; antes a tela só quebrava o texto
em linhas, e as marcas ficavam no meio da leitura (`**`, crases, as `|` de uma tabela cortadas entre linhas):
- **título** sem os `#`, em negrito (o de nível 1 também sublinhado); **negrito**, *itálico* e ~~riscado~~ sem as
  marcas; `código` na cor ciano do próprio terminal, que se lê no fundo claro e no escuro;
- **listas** com a marca (`-` ou o número) e a continuação alinhada sob o texto; **citação** com `▎` à esquerda;
  **linha horizontal** de ponta a ponta; **link** com o endereço ao lado, entre parênteses;
- **bloco de código** sem as cercas, recuado, linha por linha (cortada, não quebrada por palavra), e nada dentro dele
  é lido como markdown;
- **tabela** com bordas. As colunas encolhem até caber na largura, a mais larga primeiro, e o texto quebra dentro da
  célula; com células de várias linhas, uma linha separa as linhas da tabela. Uma coluna não fica mais estreita que a
  sua palavra mais longa (de 8 a 20 colunas); se nem assim couber, cada linha da tabela vira um registro, com cada
  célula sob o nome da coluna. Um `|` dentro de código ou escapado (`\|`) é da célula, e um `<br>` quebra a linha
  dentro dela;
- o que não forma par fica como foi escrito: `snake_case`, `2 * 3`, uma crase sozinha;
- **enquanto a resposta chega**, cada linha que terminou fica como está e vai para o histórico de rolagem; só a linha
  que está sendo escrita e uma tabela que ainda pode crescer (as colunas dependem de todas as linhas) esperam;
- o `kli -p` continua imprimindo o texto como o modelo mandou, como o `claude -p`: ele vai para outro programa ou
  arquivo.

### Locais, provedores e modelos (`/model`)

Todo modelo que a pessoa tem fica ao alcance de uma configuração simples, em três níveis:

| Local (onde) | Provedor (quem serve) | Modelo |
|---|---|---|
| esta máquina (`mac`) | servidor: `ollama`, `llama.cpp`, LM Studio, vLLM | o que o servidor lista |
| outra máquina (`aron`, `gibbor`) | servidor, ou CLI: `claude`, `agy`, `opencode`, `kimi` ou outro | o que o servidor ou o CLI lista |
| API (`vertex`, `anthropic`, OpenRouter...) | quem fez o modelo: `google`, `deepseek-ai`, `zai-org`... | o que a API oferece |

O modelo tem um nome só, com os três níveis: `mac/ollama/lfm3`, `aron/claude/haiku`,
`vertex/deepseek-ai/deepseek-v4.1-flash-maas`. Numa API o provedor faz parte do id (`anthropic/claude-sonnet-5-5`), e
o que ficar de fora vem do padrão: `vertex` é o modelo padrão dele, `mac/agy` é o Antigravity no modelo dele. Vale em
`/model <nome>`, em `kli -m <nome>`, no `model` e no `fallback` da configuração.

No `/model`, Enter desce um nível e, no modelo, passa a usá-lo; Esc volta. No nível dos modelos, digitar filtra a
lista, e um nome que a lista não tem pode ser digitado. **a**, **e** e **d** incluem, editam e excluem locais e
provedores:

- **Local:** esta máquina, outra máquina (endereço; SSH `usuário@host` ou um apelido do `~/.ssh/config`; e, se
  precisar, uma máquina para passar no caminho, `ssh -J`) ou uma API (Google, Anthropic, ou qualquer serviço
  compatível com OpenAI). Ao incluir uma máquina, o Kli procura o que tem nela: as portas do Ollama (11434), do
  llama.cpp (8080), do LM Studio (1234) e do vLLM (8000), e os CLIs que ele conhece. Numa máquina remota isso vai
  por uma conexão SSH só. **f** procura de novo e inclui o que for novo.
- **Provedor numa outra máquina:** um servidor que só escuta em `localhost` lá é alcançado
  por um túnel SSH que o próprio Kli abre e fecha, e que ele abre de novo sozinho se cair (o Mac dormiu, a rede
  caiu); um CLI roda lá via SSH, com o login daquela máquina, numa pasta
  neutra (`~/.kli/harness`). O SSH do Kli só usa chaves e nunca pergunta nada; por isso a primeira conexão com uma
  máquina nova é feita uma vez à mão, para conferir e aceitar a chave dela (no Kli, `!ssh -J aron usuário@host true`).
  Quando falta a chave, ou quando ela mudou, o erro diz isso e mostra o comando.
- **Sem tempo-limite.** Nenhum modelo tem tempo-limite: um servidor, uma API ou um CLI responde pelo tempo que
  precisar, até terminar ou até você apertar Esc (decisão de 03/11/2026, depois de o Antigravity ser cortado aos 15
  minutos com onze arquivos mudados). Um `timeoutMs` que tenha ficado numa configuração é ignorado; pode apagar.
  Continuam com limite só as coisas que não são a resposta de um modelo: a descoberta, as listas de modelos, o
  `kli check` e os comandos que o modelo pede (o Bash, como no Claude Code, e a checagem do projeto num nó).
- **CLIs que o Kli conhece** (Claude Code, Antigravity, OpenCode, Kimi Code) trabalham como agentes, na pasta onde o
  `kli` roda, com as ferramentas e as permissões deles: quem instalou o CLI e o escolheu deu a permissão. Cada passo
  aparece na conversa como os do Kli (detalhes em Ferramentas). Qualquer outro CLI entra com os argumentos que a
  pessoa der (`{prompt}`, `{model}` e `{mode}` são trocados), e a resposta é lida como texto.
- **Instruções de um servidor:** `"instructions"` num provedor `server` vai no fim da mensagem de sistema só para os
  modelos dele. Serve para o que o modelo só aceita ali: o Nemotron do cluster exo (local `rosh`, provedor `exo`, porta
  52415) só para de pensar em voz alta com `"instructions": "/no_think"`, porque o exo ignora `enable_thinking` e
  `reasoning_effort` (31/10/2026).
- **Enter no campo Modelo** lista o que o local ou provedor oferece: `/v1/models` (com tamanho e quantização no Ollama
  e no llama.cpp; num cluster exo, só os modelos carregados, com as máquinas em que cada um roda, porque o
  `/v1/models` do exo traz o catálogo inteiro), os Gemini e os modelos de parceiros prontos para chamar (os `-maas`: DeepSeek, GLM, gpt-oss,
  Llama) na API do Google, `/v1/models` da Anthropic, `agy models`, `opencode models` e os apelidos do Claude Code.
- **Test** manda "ok" antes de salvar; numa máquina, mostra o que a busca acharia. **Save** grava o arquivo da
  configuração (o anterior fica em `.bak`) e a sessão segue com ele. **d** pede confirmação; o `model` e o `fallback`
  deixam de apontar para o que saiu.

**Chaves.** As APIs que pedem chave aparecem trancadas (`locked: needs ANTHROPIC_API_KEY`), e Enter abre o editor
no campo **Key**. A chave vai para `~/.kli/.env` (ou `$KLI_ENV`), com permissão só do dono; a configuração guarda só o
nome da variável. Na tela ela aparece como `••••1234`, nunca no rastro. Uma variável de ambiente já definida vale
mais que o arquivo. As chaves do arquivo não vão para os CLIs que o Kli roda: o Claude Code, por exemplo, trocaria o
login da pessoa pela API paga. O Google aceita também o login do `gcloud`, sem chave.

O modelo escolhido no `/model` (ou com `/model <nome>`) passa a ser o padrão: vai para o `model` da configuração
(o arquivo anterior fica em `.bak`), e a próxima sessão começa nele, inclusive o `kli "pergunta"`. Para usar outro
modelo uma vez só, sem mudar o padrão: `kli -m <nome>`.

### Ferramentas: ler, criar e mudar arquivos, rodar comandos

Funciona como no Claude Code. O modelo trabalha na pasta onde o `kli` roda, com as mesmas ferramentas:
**Read** (lê com as linhas numeradas, em partes se for longo), **Glob** (acha arquivos e pastas por padrão; `*` lista
uma pasta, e as pastas vêm com `/` no fim), **Grep** (procura
no conteúdo, com o `rg`), **Write** (cria ou substitui um arquivo), **Edit** (troca um trecho exato), **Bash** (roda
um comando e devolve a saída e o código de saída), **BashOutput** e **KillBash** (acompanham e param um comando em
segundo plano). O modelo só pede; quem executa é o Kli, nesta máquina, mesmo quando o modelo está em outra. O laço: o Kli manda a conversa e a lista de ferramentas, o modelo
pede uma ou mais, o Kli executa e devolve os resultados, e isso se repete até o modelo responder só com texto, sem
teto de passos nem de tempo: só o Esc para. Ao parar, cada pedido de ferramenta ainda sem resposta recebe um "not
run", e a pergunta sai da conversa, para a próxima começar limpa em qualquer provedor. Um modelo local que escreve o
pedido como texto em vez de pedir (`{"name": "Bash", "arguments": {…}}` como a resposta inteira, ou cada pedido entre
`<tool_call>` e `</tool_call>`) tem o pedido atendido como se tivesse pedido, e a tela avisa uma vez
(`the model wrote its tool calls as text`). Só vale com o nome de uma ferramenta oferecida e nada além do nome e dos
argumentos; qualquer outro texto é resposta. (23/11/2026: o qwen2.5-coder 14B no Ollama respondia assim, e o nó acabava
no primeiro passo, sem ter rodado nada.) O modelo é orientado a usar ferramentas só quando o pedido é sobre os arquivos da pasta ou
precisa de um comando, e a escrever textos (um resumo, uma carta) direto na resposta. Cada ferramenta aparece na conversa (`● Write(soma.py)` e `⎿ Wrote 16 lines to soma.py`, com a
diferença) e vai para o rastro.

**Permissão**, como no Claude Code:

- Ler, procurar e listar dentro da pasta é livre, também por comando: o que só lê (`ls`, `cat`, `head`, `wc`, `find`
  sem `-exec`/`-delete`, `grep`, `rg`, `tree`, `git status`, `git diff`, `git log`, `git branch -a`...) roda sem
  perguntar, como no Claude Code, desde que todo caminho fique dentro da pasta e nada seja gravado com `>`.
- Gravar, editar e rodar perguntam antes, mostrando a diferença ou o comando: **Yes**; **Yes, allow all edits during
  this session** (ou, num comando, **don't ask again this session for …**, explicado abaixo); **No, and tell Kli what
  to do differently** (Esc), que para o turno para a pessoa dizer o que quer.
- O "não perguntar de novo" de um comando vale para o comando e seus subcomandos, e cada parte de uma linha ligada por
  `&&`, `||`, `;` ou `|` precisa estar liberada. Aprovar `npm run build` libera `npm run build --watch`, mas não
  `npm publish`; aprovar `cat a.txt` não leva junto o `rm` de `cat a.txt && rm a.txt`. Comandos em que os
  argumentos são o perigo ou que rodam outro código (`rm`, `mv`, `sudo`, `kill`, `ssh`, `bash`, `xargs`, `find`...) e
  os de uma palavra só (`make`, `npm --version`) ficam liberados só exatamente como foram pedidos. O que pode
  esconder outro comando (`$(…)`, crases, `<(…)`, subshell, here-document, laços) e o que grava fora da pasta com
  `>` perguntam sempre, e a tela diz por quê.
- Fora da pasta, sempre pergunta.
- Um arquivo que já existe só é gravado ou editado depois de lido na sessão.
- **Shift+Tab** troca o modo: perguntar antes de editar → **accept edits** (grava sem perguntar; comandos continuam
  perguntando) → **plan** (só lê: as ferramentas de leitura e os comandos que só leem). `kli -p` não tem a quem perguntar: o que precisa de permissão é recusado, a não
  ser que `--permission-mode acceptEdits` libere as edições; as ferramentas usadas saem no stderr.

**Comandos.** A saída aparece enquanto o comando roda (as últimas linhas, embaixo do `● Bash(...)`), sem cores e com
barras de progresso no último estado; stdout e stderr vêm juntos, na ordem em que saíram. O modelo recebe tudo; uma
saída longa chega com o começo e o fim. O limite é de 2 minutos, até 10 se o modelo pedir. Cada comando roda num
grupo de processos próprio: parar (Esc, tempo esgotado, KillBash, saída do Kli) para também o que ele abriu.

- **Segundo plano:** para o que não termina (servidor de desenvolvimento, watcher, deploy longo), o modelo usa
  `run_in_background` e recebe um id (`b1`); lê o que é novo com **BashOutput** e para com **KillBash**. **Ctrl+B**
  manda para lá o comando que está rodando, e o modelo segue. `/jobs` lista o que roda, com as últimas linhas, e
  `/jobs stop b1` (ou `all`) para. Quando um termina, a tela avisa e o modelo fica sabendo na mensagem seguinte. Tudo
  para quando o Kli sai.
- **Sem terminal:** o Bash do modelo não recebe teclas, então o que pede senha, `sudo` ou login falha (o modelo é
  orientado a usar opções não interativas, como `--yes`).
- **`!comando`:** a pessoa roda o comando ela mesma. O Kli sai da tela cheia, entrega o terminal ao comando (senha,
  `sudo`, `gcloud auth login`, até `vim` funcionam) e volta quando ele termina. O `script` grava o que apareceu: fica
  na conversa (`! git push`, as últimas linhas e o código de saída) e vai para o modelo junto com a próxima mensagem.
  Ctrl+C vai para o comando, não para o Kli. Sem permissão: quem pede é a pessoa.

**Instruções do projeto.** O Kli lê os arquivos que os outros agentes já leem: `AGENTS.md` (OpenCode, Codex,
Antigravity) e `CLAUDE.md` (Claude Code), mais o `CLAUDE.local.md`, as instruções pessoais que ficam fora do Git e
que o Claude Code lê logo depois do `CLAUDE.md` (21/11/2026). Os três nomes, em `~/.kli`, depois em cada pasta do topo do disco até a
pasta onde o `kli` roda; o mais perto vem por último e vale mais. Um `CLAUDE.md` que só traz `@AGENTS.md`, um link
simbólico e uma cópia igual entram uma vez só. `@caminho` traz outro arquivo, como no Claude Code (até 5 níveis, fora
de blocos de código). O `AGENTS.md` de uma subpasta entra na primeira vez que o modelo lê um arquivo dela. Tudo vai
no prompt de sistema, relido a cada sessão nova, e o `/status` mostra quais arquivos entraram.

Cada provedor pede ferramentas do seu jeito (`tool_calls` nos compatíveis com OpenAI, `tool_use` na Anthropic,
`functionCall` no Gemini, que exige a assinatura de pensamento de volta), e o núcleo traduz. Um servidor que recusa
ferramentas responde sem elas, e o Kli avisa.

**CLIs como agentes.** Com um CLI escolhido como modelo, quem usa as ferramentas é o próprio CLI, na pasta onde o
`kli` roda, com as regras dele: quem instalou e chamou deu a permissão. O Kli lê o que ele conta e mostra cada passo
como os seus, com os nomes do Claude Code (`● Bash(ls -la)`, `● Write(oi.txt)`, `⎿ exit 0 · 4 lines`), e grava no
rastro. Como roda cada um:

| CLI | Agente (modo normal e accept edits) | Modo plan |
|---|---|---|
| Claude Code | `--dangerously-skip-permissions` | `--permission-mode plan` |
| Antigravity | `--dangerously-skip-permissions` | `--mode plan`, sem comandos, MCP nem URL |
| OpenCode | `--auto` | `--agent plan` |
| Kimi Code | `-p` já age sozinho (não aceita `--auto` nem `--yolo` junto) | não tem plan com `-p`: roda isolado, longe da pasta |

Sem pasta (o `kli check`) ou noutra máquina (onde a pasta não existe), o CLI roda isolado na pasta neutra
`~/.kli/harness`: Claude Code sem ferramentas, sem MCP e sem os hooks; Antigravity em `plan` e `sandbox`, sem
comandos, MCP nem URL. Um CLI com argumentos próprios na configuração roda como eles dizem (o `claude-agent` do exemplo continua
só lendo).

**Antigravity sem comandos, MCP nem URL no plan.** Com `-p`, o `agy` recusa o que as regras dele não liberam (um
comando, uma ferramenta de MCP, uma URL) e **encerra a execução ali**, como sucesso, só com a frase do que ia fazer.
Em 12/11/2026, a stack de planejamento entregava ao Sonnet "Vou ler o docs/…" no lugar do plano, porque todo
`git log` parava o Gemini; corrigidos os comandos, uma busca no `qdrant-rag` pelo MCP parou de novo. Por isso, no
modo plan e no isolado, o Kli passa ao `agy` uma regra que recusa tudo o que perguntaria (`--settings` com `deny`
para `command(*)`, `mcp(*)`, `read_url(*)` e `execute_url(*)`, só para aquela execução; a configuração do `agy` não
muda). Com a regra, a recusa volta ao modelo como erro e ele continua lendo com as ferramentas dele (ler, listar,
procurar, buscar na web). O passo aparece como `⎿ refused`; uma ferramenta de MCP, com o servidor e o nome, como no
Claude Code (`qdrant-rag - search_rag (MCP)(stackbuilder)`). Se mesmo assim o `agy`
parar numa recusa (o campo `denied_actions`), o Kli dá a resposta como falha (`stopped at a refused permission`), e
não como resposta pronta.

### Model stacks

Uma **stack** é um grafo de modelos que responde como se fosse um só. O prompt vai para os nós que não recebem de
ninguém, e eles rodam ao mesmo tempo. Um nó com `from` espera esses e recebe as respostas deles. O que a stack
responde são os nós de que ninguém recebe (ou os marcados com `output`), então uma stack pode dar **duas respostas
lado a lado**, para comparar modelos e as ferramentas que eles chamam.

```json
"stacks": {
  "compara": { "nodes": {
    "gibbor": { "model": "gibbor/ollama/lfm3" },
    "aron":   { "model": "aron/llama.cpp/qwen2.5-7b" } } },
  "revisao": { "nodes": {
    "a": { "model": "gibbor/ollama/lfm3" },
    "b": { "model": "aron/llama.cpp/qwen2.5-7b" },
    "junta": { "model": "vertex/google/gemini-3.5-flash", "role": "aggregate", "from": ["a", "b"] },
    "verificador": { "model": "vertex/google/gemini-3.5-flash", "role": "verify", "from": ["junta", "a", "b"] } } }
},
"stack": "compara"
```

- **Quem responde.** Com uma `stack` escolhida, é ela; sem stack escolhida, responde o `model`, como sempre.
  `/stack` abre as stacks da configuração (com o número de nós e de respostas, e o problema de uma que não roda,
  como um modelo que saiu) e a opção **none**, que devolve a resposta ao modelo; a escolha fica gravada, como no
  `/model`. `/stack <nome>` e `/stack off` trocam direto. `kli --stack <nome>` usa uma stack uma vez só, e `-m` usa
  um modelo uma vez só (também ao abrir a tela cheia). O `/stackbuilder` abre uma página para montar o grafo (abaixo).
- **A triagem (`triage` e `purpose`).** Um "ok para push" não precisa de dois agentes e um juiz. Quando a stack diz
  para que serve (`"purpose"`) e a configuração tem um modelo de triagem (`"triage": { "model": … }`), esse modelo,
  pequeno e rápido, lê a mensagem nova (com a última troca, cortada) antes de a stack rodar e responde uma palavra:
  `stack`, quando a mensagem pede o trabalho para o qual a stack existe, ou `one`, quando pede outra coisa (uma
  pergunta fora desse trabalho, um obrigado, um comando rápido como um push). Com `one`, responde o `model`, na
  pasta e com a permissão da tela, como sem stack: ele mesmo decide se usa ferramenta (como no Claude Code).

  ```json
  "triage": { "model": "aron/llama.cpp/qwen2.5-7b" },
  "stacks": { "opus-kimi": { "purpose": "implementing, fixing, refactoring, testing or reviewing the project's code", "nodes": { … } } }
  ```

  - **"Simples" depende da stack.** Numa stack de personagens, "quem é brás cubas" é o trabalho dela; numa de código,
    não. Por isso a pergunta é relativa à finalidade de cada stack, e não "é simples?". Stack sem `purpose` recebe
    tudo, como antes. A pergunta também não separa "ferramenta" de "pergunta": quem responde sozinho já decide isso.
  - **Erra para o lado caro.** Falha do modelo, resposta sem a palavra ou dúvida: a stack roda, e a tela diz por quê.
    Um `stack` errado custa tempo; um `one` errado custaria a comparação. Para esse caso, `/stack again` roda na
    stack inteira a última mensagem que a triagem deu ao modelo.
  - **Uma conversa só.** O modelo que responde sozinho ouve, com a mensagem, o que a stack respondeu desde a última
    vez que ele falou (as últimas cinco respostas); cada nó da stack ouve, com a próxima pergunta, o que o modelo
    respondeu fora dela, inclusive um nó que ainda não tinha rodado.
  - **O modelo é escolha da pessoa.** `/triage` abre os modelos, como o `/model`; `/triage <nome>` troca, `/triage
    off` desliga, e a escolha fica gravada. A finalidade de cada stack se escreve no `/stackbuilder` (campo
    **Purpose**) ou na configuração. A triagem roda sem ferramentas, com temperatura 0 e sem reserva (outro modelo
    no lugar decidiria diferente); um CLI roda isolado, fora da pasta.
  - **Aquecida ao abrir.** A tela cheia faz uma chamada curta ao modelo de triagem em segundo plano quando abre, ao
    trocar de stack e ao trocar o modelo: o túnel abre e o modelo carrega antes da primeira mensagem (no teste de
    03/11, a primeira triagem levou 6,6 s sem isso e 1,7 s com isso; as seguintes, 1 a 1,3 s). Essa chamada não vai
    para o rastro: não é uma pergunta, e cada Kli que abre deixaria uma sessão vazia.
  - **O texto da triagem** (`src/core/triage.ts`) foi medido em 03/11 com 78 mensagens, 48 delas fora do ajuste e 18
    para uma stack de personagens: regras sobre o que é o trabalho da stack, exemplos para
    outra finalidade e seis exemplos em forma de conversa. A resposta é uma palavra: vale a primeira, e o Kli corta
    em 32 tokens (o lfm3, sem corte, seguia "pensando" até 52 s). Pelo próprio Kli: o qwen2.5-7b do Aron acertou 74
    (antes, com um sim/não simples, 61), em 0,3 s; o Gemini 3.5 Flash Lite, 75, em 1 s; o lfm3, 62, e manda 12 de
    28 trabalhos de stack para um modelo só; o Haiku pelo Claude Code, 71, e em duas tentou usar ferramenta em vez
    de responder. Um modelo de decisão pequeno e sem treino não serve aqui (decide pela posição das opções). Um erro visto depois, no `kli
    -p`: "escreva uma função soma(a, b) em Python, só o código" foi para o modelo (com "com um teste", foi para a
    stack).
  - **Na tela e no rastro.** Uma linha diz o que a triagem decidiu, com o modelo e o tempo. O rastro ganha o evento
    `triage` (modelo, rota, tempo, o porquê de não decidir), e a chamada do modelo de triagem conta nas estatísticas
    dele (com as marcas da stack e do nó `triage`), não como pergunta. No `kli -p`, a mesma triagem, quando a stack
    vem da configuração; `--stack <nome>` manda a mensagem direto para a stack.
- **Na tela cheia.** O cabeçalho diz qual stack responde. Cada pergunta mostra a árvore dos nós, que se preenche
  enquanto eles trabalham (esperando as entradas, com o modelo, numa ferramenta, respondendo, e no fim as medidas),
  e embaixo as respostas: uma só aparece como a de um modelo; duas ou mais ficam **lado a lado**, cada uma sob o nome
  do nó e do modelo, chegando enquanto são escritas (uma embaixo da outra quando a tela é estreita). Quando terminam,
  uma tabela compara as respostas: tempo, primeiro texto, tokens, tokens por segundo, custo, ferramentas e passos.
  Esc para todos os nós; o que já tinha chegado fica, com a marca de interrompido.
  - **As respostas do caminho também aparecem** (08/11). Os nós que respondem ou agregam e entregam a outro nó (os
    três que alimentam um agregador, por exemplo) ficam lado a lado, acima da resposta da stack, chegando enquanto são
    escritas. A resposta da stack vem embaixo, sob `── nó · modelo ──`. Enquanto ela chega, os de cima ficam com um
    terço do espaço e ela com o resto. No fim, todas vão inteiras para o histórico. Antes, numa stack como a
    `personagem` (três modelos e um agregador), só o texto do agregador aparecia, e as três respostas que ele juntou
    não apareciam em lugar nenhum. O juiz e o balizamento não entram nessa faixa, porque não escrevem uma resposta
    deles. Enquanto um nó pede que você escolha, as respostas aparecem só no seletor.
  - **A árvore fica sempre à vista.** Enquanto a stack roda, cada resposta mostra só as últimas linhas que cabem
    embaixo da árvore (`↑ 48 lines above`), cada coluna com o próprio fim; quando termina, as respostas inteiras vão
    para o histórico do terminal. Antes (03/11), uma coluna longa (o Opus narrando) empurrava a árvore para fora da
    tela, e o Gemini, que quase só escreve no fim, parecia parado.
  - **Cada nó diz quantas ferramentas usou e a última** (`6m40s · 31 tools · last Edit(DeckBaseContracts.cs)`): o
    `agy` avisa o começo e o fim de um `Read` ou `Edit` juntos, e o nó voltava na hora para "waiting for the model",
    enquanto o modelo pensava entre um passo e outro.
  - **E como ele vai** (06/11), para você decidir cedo se vale apertar Esc:
    `8m 16s · 5 tools · read 4.1k lines · first edit at 3m 52s · quiet for 4m 24s · last Edit(csv.py)`.
    - `read …` soma as linhas que as leituras trouxeram (o `Read` do Kli ou de qualquer CLI);
    - num nó que grava, `no edit yet` até a primeira edição, e depois `first edit at …`, contado do começo do nó;
    - `quiet for …`, em amarelo, aparece depois de um minuto sem ferramenta e sem texto. Um comando longo rodando (os
      testes) não conta, nem o tempo do Kli em volta do modelo (a cópia, a checagem).

    Veio da revisão de 02/11: o Antigravity leu `docx`, `pptx`, `xlsx`, `pdf`, o `main.rs` de 4.006 linhas e um
    `git log -p`, só editou aos 232 s e depois ficou 4,4 minutos sem ferramenta, e nada disso aparecia na linha
    dele. É só um aviso: nada corta o nó, e o modelo não fica sabendo. Com o Esc oferecendo aplicar o que os nós
    rápidos fizeram, ele ajuda a decidir quando parar o lento.
- **A junção e os papéis.** Um nó com `from` recebe o pedido e as respostas, cada uma com uma letra (A, B…), sem o
  nome do modelo nem as medidas, para julgar pelo conteúdo. De um CLI, ele recebe **só a mensagem final**, o que o CLI escreveu depois da última ferramenta, sem a
  narração de cada passo ("Vou ler…", "Vamos testar…"), que continua na tela e no rastro (seção "CLIs num nó"). O
  `role` diz o que ele faz:
  - **A stack não para** (decisão de 12/11/2026: "a stack não pode parar e se parar tem que evidenciar o motivo").
    Quem responde (`answer`) e quem agrega (`aggregate`) rodam mesmo quando uma entrada falhou ou foi pulada:
    - **o que ela disse antes de falhar** vai marcado como inacabado (`unfinished`), para usar o que estiver certo e
      fazer o resto;
    - **a que não disse nada** é citada pela letra ("Step A did not answer"), e o nó faz sozinho o que ela faria;
    - **sem nenhuma resposta,** o nó responde ao pedido sozinho;
    - **um balizamento cujas fontes falharam todas** segue dizendo isso ("the data sources could not be searched…"),
      e o modo dele continua valendo: em `restrict`, o nó diz que não achou nas fontes, em vez de responder do que
      sabe.

    Só o juiz (`verify`) e a escolha (`choose`) são pulados, quando não há nada para julgar ou escolher, e o `min`
    só vale para eles. Antes, um Gemini que parava numa recusa do agy derrubava o Sonnet e o juiz atrás dele, e a
    tela cortava o motivo no fim da linha.
  - **O motivo à vista:** na árvore da stack, o nó que falhou ou foi pulado diz `failed` ou `skipped` na linha dele,
    e o motivo vem inteiro nas linhas de baixo, quebrado na largura da tela em vez de cortado. Sem nenhuma resposta,
    o rodapé diz qual nó falhou e por quê. No `kli -p`, a linha de cada nó, no stderr, já leva o motivo inteiro.
  - **`answer`** (o padrão): responde ao pedido usando o que há de certo nas respostas.
  - **`aggregate`**: junta as respostas numa só e diz, num bloco que o Kli tira do texto (não aparece nem enquanto
    chega), quanto veio de cada uma: a **contribuição** de cada ramo (`used gibbor 40% · aron 60%`).
  - **`verify`**: **só julga**. Lista os requisitos do pedido (o que ele pede, inclusive formato, tamanho e língua) e
    marca cada um como cumprido, parcial ou faltando para cada resposta que recebe. A **aderência** sai dessas marcas
    (cumprido 1, parcial ½, faltando 0), não de uma nota do modelo. O veredito vem em JSON; se não vier, o Kli pede
    de novo uma vez, e na segunda falha diz que a aderência não foi medida. O verificador nunca é uma resposta da
    stack: ele mede as outras. Ligado à resposta agregada e aos ramos, mostra se a stack ganhou do melhor ramo.
    - **Não espera o mais lento.** Assim que `min` respostas chegaram (1, por padrão), o juiz julga as que vieram, e
      depois, em rodadas, cada uma que chega enquanto ele julga ou mais tarde. A primeira rodada lê os requisitos no
      pedido; as seguintes marcam esses mesmos, e só eles, e a conversa do juiz segue de uma rodada para a outra, então
      ele ainda tem à vista as respostas anteriores. Enquanto espera, a linha dele diz `judged opus, kimi · waits for
      agy`; no fim, `8.0s in 2 rounds` (o tempo dele é o das rodadas, sem a espera). Se você aperta Esc com o mais lento
      ainda trabalhando, o veredito do que já foi julgado fica (`interrupted · adherence opus 100 · kimi 92`). Em
      02/11, o juiz ficou 10 minutos parado esperando o Antigravity, com o Kimi e o Opus prontos desde os 2 e 3
      minutos. Não há relógio nisso: nada para o nó lento, e nada decide que ele "demorou demais".
    - **O que ele vê de cada resposta:** a mensagem final, o diff e a checagem de quem gravou, e a lista das
      ferramentas que o passo usou (`<tools used="3">Glob(*), Read(csv.py), Bash(pytest) (failed)</tools>`), sem a
      narração. Sem a lista, num teste de 06/11, o juiz marcou "usou uma ferramenta" como faltando em duas respostas
      que tinham usado. Quem escolhe vê o mesmo.
    - **O tamanho de cada mudança, lado a lado** (06/11), quando duas ou mais respostas gravam:
      `- A: 2 files, 10 lines added, 3 removed (13 lines in all)`, uma linha por resposta, com a regra de que,
      entre as mudanças que fazem o que o pedido pede, a menor cumpre "só o necessário". Dentro de cada diff, lidos
      um por um, os tamanhos não davam medida: em 02/11 o Flash deu "a menor mudança" como cumprida a um diff duas
      vezes maior que o outro. Numa rodada seguinte do juiz, a lista leva também as respostas já julgadas. Quem
      escolhe vê a mesma lista.
    - **Trabalho inacabado** (06/11). Um nó que falhou depois de mudar arquivos (um CLI que caiu, uma conexão que
      caiu) também é julgado, marcado (`<answer id="B" unfinished="its step failed: …">`), com a checagem rodada no
      que ele deixou: o juiz julga o que existe, e o que ele não chegou a fazer conta como faltando. Ele conta para o
      `min`, então um juiz cujo único nó falhou depois de editar ainda julga. Um nó parado pelo Esc não é julgado,
      porque o Esc para o juiz também.
    - **Requisitos fixos (`requirements`).** Uma lista de textos no nó que verifica, julgados em toda pergunta, antes
      dos que ele lê no pedido: `"requirements": ["roda os testes do backend e diz quantos passaram"]`. Servem para
      as regras da casa, que o pedido não repete.
    - **Só o pedido e esses requisitos.** O verificador e quem escolhe **não recebem as `instructions` da
      configuração**: elas dizem como responder à pessoa (quem o Kli é, o tom), e um juiz não responde à pessoa. No
      teste de 01/11, o juiz as recebia e virou "Be direct and concise" em requisito ("Ser direto e conciso (persona
      Kli)"), tirando pontos das respostas mais longas. Os requisitos e as notas vêm na língua do pedido.

  - **`choose`**: escolhe uma das respostas que recebe; a escolhida vira a resposta da stack, e na pergunta seguinte
    os ramos que concorreram seguem a partir dela (a resposta de cada um é trocada pela escolhida). Quem escolhe vem
    em `by`, na ordem de tentar (`["model"]` por padrão):
    - **`model`**: o modelo do nó lê o pedido e as respostas por letra e devolve a escolha e o porquê, em JSON (fora
      do formato, uma nova tentativa);
    - **`person`**: na tela cheia, as respostas aparecem lado a lado, com a letra, e um seletor pergunta qual; Esc
      passa a escolha ao próximo de `by`. No `kli -p` não há a quem perguntar, então vale o próximo;
    - **`decision`**: um modelo treinado só para decidir. O que se testou sem treino não escolhe bem (31/10/2026:
      preferia uma posição), então por ora é pulado, dizendo por quê.

    A linha do nó diz quem escolheu (`chose aron (B) by person`), e embaixo vêm o porquê e por que os anteriores de
    `by` não escolheram. Sem ninguém que escolha, o nó falha dizendo isso.

  - **`ground`** (balizamento): traz contexto de **fontes de dados** para a etapa seguinte, sem modelo (só busca).
    Detalhes logo abaixo, em "Balizamento".

  Quem agrega, verifica ou escolhe trabalha só com as respostas: sem ferramentas, a não ser com `"tools": "read"`.
- **Balizamento (`"role": "ground"`).** Um nó que **busca** e entrega a etapa seguinte com contexto: um RAG dentro do
  grafo, em qualquer ponto (antes de um ramo, depois de um rascunho, antes do agregador ou do juiz). As **fontes de
  dados** ficam declaradas uma vez, em `sources` na configuração, e servem a qualquer stack:

  ```json
  "sources": { "docs": { "type": "files", "paths": ["~/docs", "~/notas/**/*.md"] } },
  "stacks": { "balizada": { "nodes": {
    "contexto": { "role": "ground", "sources": ["docs"], "mode": "restrict", "budget": 1500 },
    "gemini":   { "model": "vertex/google/gemini-3.5-flash", "from": ["contexto"] } } } }
  ```

  - **A fonte `files`:** pastas, arquivos ou globs. O Kli recorta cada arquivo em trechos (o Markdown por seção, o
    CSV em grupos de 20 linhas com o cabeçalho, o JSON por item) e os ordena pelas palavras da consulta (BM25), sem
    modelo e sem índice em disco: um arquivo só é recortado de novo quando muda. Ficam fora `node_modules`, `.git`,
    binários e arquivos acima de 5 MB. As outras fontes do desenho (Drive, Qdrant, SQL…) vêm uma por fatia.
  - **`mode`:** `enrich` (o padrão) acrescenta, e o modelo usa o contexto quando ajuda, junto com o que sabe, citando
    `[n]`; `restrict` limita: só o contexto, citado, dizendo quando a informação não está lá.
  - **`query`:** com o que buscar: `request` (o pedido, o padrão), `answers` (o que chegou dos nós anteriores, como os
    fatos de um rascunho) ou `both`.
  - **`rules`** vai por cima das regras do modo; **`attach`** são arquivos que vão sempre inteiros (um glossário,
    uma política); **`budget`** é o limite de tokens de contexto (2000 por padrão: fica o mais relevante, e o que foi
    cortado é dito); **`top`** é quantos trechos cada fonte devolve (8); **`mask`** troca `email`, `cpf` e `phone`
    nos trechos antes de irem a um modelo.
  - **Transparente na cadeia:** quem recebe de um `ground` recebe as respostas que chegaram a ele (por letra, como
    antes) e o contexto numerado, com as regras. Vários `ground` no caminho somam o contexto, numerado de um a um. O
    verificador recebe o contexto para julgar se as respostas concordam com ele, e um `ground` antes do juiz não tira
    das respostas o papel de saída da stack.
  - **Na tela:** a linha do nó (`2 excerpts · 1429 tokens (6 left out)`) e, no fim, de onde veio cada trecho, com a
    nota (a parte das palavras da consulta que ele tem). O rastro ganha o evento `ground`: cada fonte, cada trecho, os
    tokens e o que foi cortado; a consulta só se o rastro guarda conteúdo.
  - **No `/stackbuilder`:** "+ Add grounding" põe um card próprio, com o painel das fontes, do modo, da consulta, das
    regras, dos anexos, do orçamento e do que esconder; o painel "Data sources" cadastra, muda e testa uma fonte
    (**Test source** mostra os trechos que ela acharia); e no teste cada `ground` mostra o que injetou.
- **Cada nó tem a sua conversa.** Na pergunta seguinte, cada um segue do que disse.
- **Ferramentas.** Por padrão os nós só leem (as ferramentas de leitura do Kli, ou o CLI em modo plan), então nós
  rodando ao mesmo tempo nunca perguntam nada à pessoa, e cada nó é avisado disso. `"tools": "none"` tira as
  ferramentas de um nó: modelos pequenos às vezes tomam "escreva um texto" por "grave um arquivo" e gastam passos
  tentando, e sem ferramentas a comparação de um texto fica mais justa. Um nó que
  responde também pode gravar: na sua pasta, quando é o único, ou numa cópia só dele, quando há outros para comparar
  (abaixo).
- **Ramos que gravam (`"tools": "write"`).** Para programar com vários modelos ao mesmo tempo e escolher o melhor
  resultado:

  ```json
  "programa": {
    "nodes": {
      "opus":   { "model": "ClaudeLocal/claude/opus", "tools": "write" },
      "gemini": { "model": "vertex/google/gemini-3.5-flash", "tools": "write" },
      "agy":    { "model": "mac/agy", "tools": "write" },
      "juiz":   { "model": "vertex/google/gemini-3.5-flash", "role": "verify", "from": ["opus", "gemini", "agy"] } } }
  ```

  A stack não diz como testar: isso é do projeto, e o Kli descobre (abaixo).

  As regras são do Alexandre (02/11/2026): "só quero novas worktrees se eu pedir… a worktree foi um subterfúgio para
  compararmos modelos e depois escolher… quando aplicamos, mantemos somente a escolhida sobre o local onde estamos
  trabalhando, master, branch, etc… as outras são jogadas fora, simples assim", e "pode ser que estejamos num projeto
  que não esteja no git".

  - **Por padrão, o nó grava na sua pasta.** Numa stack com um nó só que grava, como a `opus-kimi` (o Opus programa
    e o Kimi confere), ele edita a pasta onde você abriu o Kli, como numa conversa: a `master`, uma branch, ou uma
    pasta fora do Git. Não há cópia nem nada a aplicar, e a linha diz `2 files +10 −3 in your folder`.
  - **Cópia só para comparar, e o pedido é a stack.** Uma stack com dois ou mais nós que gravam, como a `programa`,
    compara: cada pergunta a ela é uma **rodada**, em que cada nó grava na sua cópia da pasta, e no fim você escolhe.
    Não há outro jeito de ganhar uma cópia.
  - **A cópia é uma cópia comum da pasta, não um `git worktree`.** Ela leva tudo, inclusive o `.git`, o
    `node_modules`, o `bin` e o `obj`, então funciona com ou sem Git, não precisa de preparo, e nada fica
    registrado no seu repositório (um `git fetch` ou um `checkout` feito na cópia fica na cópia). Num repositório, a
    cópia é do repositório inteiro, mesmo quando o Kli roda numa subpasta; o nó trabalha na subpasta dentro dela. No
    macOS, o sistema de arquivos (APFS) clona a pasta sem ocupar espaço a mais: um repositório inteiro, com 41.376
    arquivos e 879 MB, levou 4,3 s. No Linux, o mesmo vale no btrfs e no XFS; no ext4 a cópia é de verdade e ocupa o
    tamanho da pasta por nó enquanto a rodada dura. As cópias ficam ao lado do rastro da sessão
    (`~/.kli/sessions/<sessão>.copies/`). Se a sua pasta é um worktree de outro repositório (ou um submódulo), o `.git`
    dela só aponta para o seu repositório, e um commit feito na cópia moveria uma branch sua: por isso a cópia ganha
    um repositório próprio, clonado do seu, no mesmo commit e com o mesmo índice. Fora do Git, uma pasta com mais de
    20 mil arquivos (sem contar `node_modules` e afins) não é um projeto (a pasta de casa, por exemplo): ela não é
    copiada, e o nó falha dizendo por quê.
  - **O que cada um mudou** é medido contra a pasta (ou a cópia) como estava quando a resposta começou, com um Git só
    do Kli, ao lado das cópias da sessão: uma foto da pasta no começo, outra no fim, como o Git a veria (o que o
    `.gitignore` ignora fica de fora). Do seu repositório ele só lê os objetos, o índice (para não reler o que não
    mudou) e a lista de exclusão: nada é gravado lá, e o seu índice fica como estava. Fora do Git é o mesmo. Arquivo
    novo do que as ferramentas geram (`node_modules`, `__pycache__`, `.venv`, `target`, `obj`, `.DS_Store`…) nunca
    conta como mudança, mesmo num projeto que não o ignora: no teste de 06/11, o `__pycache__` de um `unittest` ia
    para o diff, e o juiz reparou. Um arquivo desses que o repositório já tem é medido como os outros. É esse diff
    que o juiz recebe.
  - **Aplicar.** No fim da rodada, na tela cheia, o Kli pergunta: "Apply which changes to your folder?". Vem primeiro
    o escolhido por um nó `choose`, ou o de maior aderência. Um nó que falhou depois de mudar arquivos (um CLI que
    caiu, uma conexão que caiu) também aparece, no fim e marcado (`failed, unfinished`, com a aderência que o juiz deu ao que ele deixou; `failed, not judged` sem juiz), e um parado pelo Esc aparece como `interrupted, not judged`. A aderência vem antes do tamanho, para não ser cortada numa tela estreita. Ao aplicar, os arquivos que o escolhido
    criou, mudou ou apagou vão para a sua pasta, onde ela estiver (a `master`, uma branch), sem commit e sem mexer no
    índice do Git, e **todas** as cópias são apagadas, a escolhida também. Se você mexeu num desses arquivos
    enquanto os nós trabalhavam, o Kli diz quais e não aplica nada: é tudo ou nada. A rodada termina do mesmo jeito,
    com as cópias apagadas, e o diff fica guardado.
  - **Esc no meio da rodada** para todos os nós, e a lista de aplicar aparece com o que já existe: primeiro os que
    terminaram (com a aderência, se o juiz já os julgou), depois os que foram parados, marcados
    (`interrupted, not judged`). Assim, parar o nó lento não faz perder o trabalho do rápido. Um segundo Esc é o
    "none".
  - **Sem escolha (Esc ou "none"),** todas as cópias são apagadas e a pasta fica como estava. No `kli -p` não há a
    quem perguntar: nada é aplicado, e as cópias são apagadas no fim.
  - **Na pergunta seguinte** começa outra rodada, com cópias novas da pasta como ela está. Da rodada anterior só fica
    a conversa de cada nó: depois de aplicar, a resposta aplicada passa a ser a de todos; sem escolha, cada um é
    avisado de que nada foi aplicado.
  - **O diff de cada nó fica guardado** ao lado do rastro (`<sessão>.copies/<nó>.patch`), para ver depois o que cada
    modelo fez, e o rastro registra o que foi aplicado (um evento `apply`, com o nó, os arquivos e o diff). É um
    arquivo, não uma cópia.
  - **O que o nó pode fazer.** Editar e criar arquivos onde trabalha (a sua pasta ou a cópia dele), sem perguntar
    (os nós rodam juntos e não há a quem perguntar). Comandos: os que só leem, e os comandos do projeto (os testes,
    o typecheck; cada um libera os que começam como ele: `bun run test` libera `bun run test x`); qualquer outro é
    recusado, o nó é avisado, e a linha dele conta as recusas (`9 tools (2 failed, 1 refused)`): uma resposta sem os
    testes pode ser uma recusa, não preguiça do modelo. A recusa repete o que roda ali e diz com que comando os
    testes rodam (`the project's tests run with npm test`), e a nota do nó diz o mesmo desde o começo. Do
    `package.json` vale também o comando que o script roda, se for um comando simples: com `"test": "bun test"`, o
    `bun test test/a.test.ts` passa como o `npm test` passaria. Não vale um script com `&&`, `;`, `|`, `$`, aspas ou
    redirecionamento, nem um que remove ou roda outros programas (`rm`, `sh`, `NOME=valor`…), nem um runtime sozinho
    (`node`, `bun`, `npx`): esses ficam atrás do nome do script. (23/11/2026: um modelo de 7B pediu `bun test` quatro
    vezes onde só o `npm test` rodava, os mesmos testes, e desistiu pedindo que a pessoa rodasse.) Um CLI (Claude Code, OpenCode) roda como agente onde o nó
    trabalha, com as permissões dele. Um CLI de outra máquina roda isolado e não grava.
  - **Sem limite num nó.** Nenhum nó tem tempo-limite nem teto de passos, pelo laço do Kli (o Gemini, um modelo
    local) ou por um CLI: ele trabalha até o modelo responder, ou até você apertar Esc, que para todos os nós
    (03/11/2026). Antes, um nó parava aos 15 minutos ou aos 150 passos, e o que mudou ficava inacabado; o
    Antigravity foi cortado assim com onze arquivos mudados, enquanto o Opus terminava a mesma fatia em 13 minutos.
  - **O ritmo.** Todo nó que grava recebe, junto do aviso de onde trabalha (a sua pasta ou a cópia dele), como
    trabalhar: nada corta o nó, mas você está esperando; buscar antes de ler, ler só o trecho que precisa de um arquivo longo, não reler; editar assim que
    souber, só o que o pedido pede, e deixar à pessoa as decisões que ele não pede; checar uma vez, no fim. É o
    mesmo texto para todos, então a comparação segue justa. Quando as leituras ou edições não dependem uma da outra,
    o modelo é orientado a pedi-las juntas, num passo só. No teste de 02/11, o Antigravity, que estourava os 15
    minutos lendo o `main.rs` inteiro várias vezes, passou a editar na metade do tempo e terminou aos 876 s; o Opus
    caiu de 213 s para 89 s.
  - **A cerca.** A lista não basta: um comando liberado que roda código do projeto (os testes, um build) roda qualquer
    código que o nó escrever. No teste de 01/11, o Gemini teve o `bun install` recusado e o rodou assim mesmo: escreveu
    um `preload.ts` e um `bunfig.toml` que o `bun test` carrega e depois apagou os dois. Por isso os comandos do nó e
    a checagem rodam numa **caixa do sistema** (o `sandbox-exec` no macOS, o `bwrap` no Linux):
    - **gravam só** onde o nó trabalha (a sua pasta ou a cópia dele), nas pastas temporárias e nos caches das
      ferramentas (`~/Library/Caches`, `~/.cache`, `~/.npm/_cacache`, `~/.nuget/packages`…); o resto da sua casa e os
      outros repositórios ficam fora;
    - **não leem** as chaves e logins (`~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.kli/.env`…);
    - **sem rede**, a não ser a da própria máquina (o servidor de um teste). O .NET fala com o `localhost` por um
      endereço IPv6 que a caixa do macOS não reconhece, então dentro da cerca o IPv6 dele fica desligado
      (`DOTNET_SYSTEM_NET_DISABLEIPV6`); assim o `dotnet test` roda.

    A linha embaixo do nó diz a cerca (`fenced by sandbox-exec: writes only in its copy, no network`, ou `in the
    folder`) ou por que não houve (`not fenced: bwrap is not installed`). Um `bwrap` instalado que o sistema não deixa
    criar a caixa (um container sem namespaces de usuário) conta como ausente: o Kli tenta uma vez por processo e,
    se falhar, os comandos rodam sem cerca e a linha diz o motivo (`bwrap cannot make its box here: …`), em vez de
    todo comando do nó falhar (21/11/2026, visto nos testes num container Linux). O projeto ajusta em `fence`, no
    `.kli/write.json` ou no `write` da stack: `{ "network": true }` libera a rede, `{ "write": ["~/pasta"] }` libera
    mais pastas, e `false` desliga. Um CLI usa as próprias permissões e não entra na cerca. Um Kli que roda dentro de
    uma cerca (uma stack programando o próprio Kli) não cerca de novo: o macOS não aceita uma caixa dentro de outra, e
    a de fora continua valendo. É uma cerca, não um cofre: um cache ainda pode ser gravado.
  - **Como testar vem do projeto, não da stack.** Como o nó trabalha na pasta ou numa cópia inteira dela, não há
    preparo: as dependências já estão lá, como você as deixou. No fim o Kli roda a **checagem** (os testes). Quem usa
    não diz nada: o Kli procura, campo a campo, nesta ordem:
    1. **`.kli/write.json` do projeto** (na pasta onde o `kli` roda ou no topo do repositório), com
       `{ "run": [...], "check": …, "fence": … }`: para um projeto que não se descobre sozinho;
    2. **o bloco `write` da stack**, para uma stack feita para um projeto só;
    3. **os arquivos do projeto**, na pasta onde o `kli` roda:

       | Arquivo | Checagem (e comandos liberados) |
       |---|---|
       | `bun.lock` | o script `test` (`bun run test`), ou `bun test` se houver arquivos de teste; mais `typecheck` e `lint`; de cada script, também o comando que ele roda, se for simples |
       | `pnpm-lock.yaml`, `yarn.lock` | o script `test`; mais `typecheck` e `lint`; de cada script, também o comando que ele roda, se for simples |
       | `package-lock.json` (ou só `package.json`) | `npm test`, se o script não for o vazio do `npm init`; mais `typecheck` e `lint`; de cada script, também o comando que ele roda, se for simples |
       | `go.mod` | `go test ./...` (`go vet`, `go build`) |
       | `Cargo.toml` | `cargo test` (`cargo check`, `cargo build`) |
       | `*.sln`, `*.slnx`, `*.csproj` | `dotnet test`, se houver um projeto de testes, senão `dotnet build` (`dotnet test`, `dotnet build`) |
       | `uv.lock` | `uv run pytest`, se houver `test_*.py` |
       | `requirements.txt` | o `pytest` do `.venv` da pasta, se houver `test_*.py` |
       | `test_*.py` sem lockfile | `python3 -m unittest discover -s <pasta dos testes>`, do topo (de dentro da pasta, um `csv.py` dela tomaria o lugar da biblioteca); `python3 -m pytest` se o projeto usa pytest (`conftest.py`, `pytest.ini`, `pyproject.toml`) e ele está instalado |

       Testes Python soltos só fazem da raiz um projeto Python se ela tiver um marcador (`pyproject.toml`,
       `setup.py`, `conftest.py`…); senão contam na pasta onde estão. Sem nada na raiz, o Kli olha as pastas logo
       abaixo: um repositório com `backend/` (.NET) e `frontend/` (npm) fica com a checagem `cd backend && dotnet
       test` e os comandos das duas ferramentas liberados.

    Se a ferramenta não está instalada (um `pnpm-lock.yaml` sem `pnpm`), nada roda e a tela diz por quê. Sem nada
    declarado nem encontrado, os nós gravam sem checagem, e a tela diz isso. Embaixo de cada nó aparece de onde veio o
    que rodou (`checked with bun run test · from bun.lock`). Um `setup` antigo no `.kli/write.json` ou na stack é
    ignorado: não há mais o que preparar.
  - **A checagem** roda onde o nó trabalhou, quando ele termina, **se ele mudou arquivos** (sem mudança, é a pasta
    como estava, e os testes podem levar um bom tempo): passou ou falhou vai para a linha do nó, para a tabela e
    para quem recebe o nó. Numa pergunta em que ninguém mudou nada, não roda checagem nenhuma. Quem julga, agrega ou escolhe recebe, além do texto, **o diff** de cada um e
    **como a checagem terminou**. Num verificador, a checagem entra como mais um requisito ("the project's check
    passes"), marcado pelo Kli a partir do resultado, e não pelo modelo. Se uma resposta mudou arquivos e outra não,
    a que não mudou fica com o resultado da pasta como estava, rodado uma vez só, pelo juiz.
  - **Cópias que ficaram.** Se o Kli morre no meio de uma rodada (um `kill -9`, a máquina que caiu), as cópias
    ficariam no disco. Cada sessão marca as suas com o processo do Kli, e o próximo Kli que começa uma rodada apaga
    as de sessões cujo processo já não existe. Os diffs ficam.
  - **Na tela:** a linha do nó mostra `1 file +1 −1 · check passed`; a tabela ganha `changes` e `check`; embaixo,
    cada nó lista os arquivos que mudou, o fim da checagem quando falhou e o caminho do diff.
- **Reserva.** O `fallback` da configuração **não vale** numa stack: se outro modelo respondesse no lugar de um nó, a
  comparação mentiria. Cada nó pode ter o seu `fallback`, e aí a tela mostra quem respondeu de fato.
- **Medidas.** Cada nó: tempo, tempo até o primeiro texto, tokens de entrada e saída, tokens por segundo, custo,
  passos e ferramentas (quantas, quais falharam); os tokens de raciocínio aparecem à parte ("510 thinking"). Tokens
  por segundo só quando dá para medir de verdade: o texto, sem o raciocínio, de um nó que respondeu num passo, sem
  ferramenta nenhuma (nem as do CLI) e escrevendo por pelo menos 0,3 s. A stack: o tempo de parede, a soma dos nós
  e quanto rodar lado a lado economizou. No `kli -p`, cada nó aparece no stderr quando termina; as respostas vão para o stdout (uma
  resposta chega enquanto é escrita; várias saem uma embaixo da outra, cada uma com o nome do nó). `--json` traz tudo.
- **Rastro.** Um `prompt` para a stack, `stack` no começo e no fim, e cada evento de um nó leva `stack` e `node`
  (`kli sessions <id>` mostra `[nó]` em cada linha), com um evento `node` com as medidas no fim. No `kli stats`, a
  pergunta da stack conta uma vez, e as respostas de cada nó contam para o modelo que respondeu.
- **CLIs num nó.** Para ler, rodam em modo plan, na pasta (com o `PWD` dela, que o OpenCode segue); para gravar,
  como agentes, dentro da cópia do nó (testado em 01/11 com o Claude Code, o OpenCode, o Kimi e o Antigravity). Em
  01/11, o Antigravity em modo plan montava um plano em vez de responder e terminava sem texto; em 06/11, num nó que
  lê, ele usou a ferramenta e respondeu nas quatro rodadas de teste (uma pergunta sobre os arquivos da pasta). Os
  links que ele põe na resposta apontam para a pasta onde trabalhou (uma cópia some depois). Como agente, o Gemini
  3.8 Flash pode passar a rodada inteira sem escrever: em 08/11 foram 40 ferramentas e nenhum texto antes dos 247 s de
  252. A coluna dele fica em "…", e a linha da árvore (ferramentas, a última, o que leu) mostra que ele trabalha. O
  raciocínio dele não vem no `stream-json` do `agy`, que traz só o texto visível, as ferramentas e os tokens.
  - **A mensagem final.** Um CLI narra o que faz entre uma ferramenta e outra, e tudo isso aparece na coluna dele.
    Quem recebe o nó (a junção, o agregador, o juiz, quem escolhe, a busca de um `ground`) recebe só o que ele
    escreveu depois da última ferramenta; se ele terminou numa ferramenta, o trecho de antes dela. Os CLIs não
    concordam num campo para isso: o `result` do Claude Code é a mensagem final, o `response` do Antigravity é o
    texto inteiro, e o Kimi e o OpenCode não têm nenhum (medido em 06/11). Por isso o Kli usa os passos, igual para
    todos. Em 02/11, a resposta do Antigravity que foi ao juiz numa revisão tinha 104 mil caracteres de narração. O
    rastro guarda o texto inteiro e, no evento `node`, quanto seguiu adiante (`answerChars`).
- **Modelos que saem.** Um nó cujo modelo saiu da configuração falha quando a stack roda, sem quebrar a
  configuração; renomear um local ou provedor renomeia os nós junto.
- **Montar no navegador: `/stackbuilder`.** Na tela cheia, `/stackbuilder` abre no navegador uma página que desenha
  as stacks da configuração como grafos (React Flow), servida pelo próprio `kli`; `kli stackbuilder` faz o mesmo
  direto do terminal, até o Ctrl+C. A configuração continua sendo a verdade: a página só desenha e edita o que está
  nela, e grava lá quando você salva (a versão anterior fica em `.bak`, como no `/model`). O que dá para fazer:
  - **Grafo:** o prompt à esquerda e uma coluna por etapa; ligue um nó a outro puxando do ponto da direita (o de
    destino passa a receber a resposta), e selecione um nó ou uma ligação e aperte Delete para tirar. Uma ligação que
    fecharia um círculo é recusada com o motivo. As posições que você arrasta ficam só neste navegador; **Arrange**
    volta às colunas.
  - **Painel do nó:** nome, modelo (com a lista dos modelos que o local tem, pedida ao provedor), papel, quem escolhe
    (`by`), de quem recebe, `min`, ferramentas (`write` só para quem responde; o nó ganha o selo **writes**), se é
    uma resposta da stack, `fallback` e instruções. Com algum nó que grava, o painel da stack mostra **Nodes that
    write**: Setup, Commands allowed (`write.run`) e Check.
  - **Problemas ao vivo:** a forma (nós que não existem, círculos, papéis sem `from`) é conferida enquanto você edita,
    e os modelos que a configuração não tem, pelo `kli`. Com problema, não salva nem testa.
  - **Testar:** um prompt roda a stack como está na tela, salva ou não. Os nós acendem no grafo enquanto trabalham, as
    respostas chegam embaixo, e no fim vêm a tabela de medidas, as contribuições, o veredito do verificador e a
    escolha. Um nó com `by: ["person", …]` pede a escolha na própria página. As ferramentas dos nós leem na pasta
    onde o `kli` abriu (o topo da página mostra qual), como no `/stack`. O teste fica no rastro como qualquer
    sessão (`surface: builder`). Nós que gravam trabalham nas suas cópias, e a tabela mostra o que mudaram e a
    checagem; a página não aplica nada (as cópias somem no fim do teste, e os diffs ficam ao lado do rastro). Uma
    stack com um nó só que grava edita a pasta também no teste da página, como no `/stack`.
  - **Salvar, renomear, apagar e "Answer with it":** este último faz a stack responder no Kli, como o `/stack`.
    A sessão aberta na tela cheia acompanha: avisa o que a página fez e recomeça a stack que responde.

  A página escuta só em `127.0.0.1`, numa porta livre, e cada chamada leva o token que vai no endereço aberto; outra
  página do navegador não alcança a sua configuração. Ela fica de pé enquanto a sessão estiver aberta.

Os nomes seguem Claude Code, Codex, OpenCode e Gemini CLI: *location* = local, *provider* = provedor,
*fallback* = reserva, *session* = conversa, *trace* = rastro.

Depois, com as ferramentas, entram `kli tools` (o que está liberado) e `kli whoami` (identidade e permissões).

**Escrita sempre pede confirmação.** O Kli mostra o que vai fazer e espera `s`. Sem terminal interativo (em script
ou pipe), a escrita é **recusada**, com código de saída próprio, e nunca aprovada por padrão.

## Peças

- **Motor:** cada provedor fala o próprio protocolo por HTTP direto, sem SDK. O roteador acha o modelo na
  configuração (o `model`, ou o escolhido pelo `--model`/`/model`), abre o túnel se precisar e cai no `fallback`
  quando ele falha antes de entregar texto. Por baixo dos locais, quatro formas de falar com um modelo:
  - **`openai`**: qualquer API compatível com OpenAI. Atende os modelos locais (Ollama, llama.cpp, vLLM, LM Studio)
    e serviços como OpenAI, OpenRouter, Groq e DeepSeek. Chave opcional por `apiKeyEnv`.
  - **`vertex`**: Vertex AI (hoje Gemini Enterprise Agent Platform):
    modelo `publisher/modelo`; `google/*` vai pela API nativa do Gemini (`streamGenerateContent`) e os outros
    publishers (DeepSeek, Qwen, gpt-oss) pelo endpoint compatível com OpenAI do Vertex. Autenticação pelo ADC do
    Google, também por HTTP direto: o refresh token do `gcloud` ou o JWT assinado de uma conta de serviço.
  - **`anthropic`**: a Messages API do Claude, com a chave em `ANTHROPIC_API_KEY` (no `~/.kli/.env`).
  - **`harness`**: outro harness de agente rodando sem interação (Claude Code, Antigravity, OpenCode). O Kli entrega
    a conversa num prompt só (instruções, turnos anteriores e a mensagem nova), pelo argumento (`{prompt}`) ou pela
    entrada padrão, e lê a resposta em tempo real: `format` `claude` (stream-json do Claude Code), `antigravity`
    (stream-json do `agy`), `opencode`, `kimi` ou `text`. Numa máquina remota, roda via SSH. Cada harness usa o próprio login, e os argumentos decidem o quanto dele fica
    ligado. Os padrões do exemplo são de segurança: `claude-code` sem ferramentas, sem MCP e sem os hooks e
    configurações do usuário (`--tools "" --strict-mcp-config --setting-sources project --no-session-persistence`);
    `claude-agent` só com ferramentas de leitura (Read, Grep, Glob) no diretório onde o `kli` roda; `agy` em
    `--mode plan --sandbox`, sem comandos. Isso vale para o modo isolado; como agente, o CLI roda na pasta da pessoa (ver CLIs como
    agentes).

  Locais do `kli.example.json`: `laptop` (Ollama; Claude Code, `claude-agent`, Antigravity, OpenCode e Kimi),
  `gpubox` (Qwen2.5-7B num `llama-server` e o Claude Code de lá, por SSH), `lab` (Ollama numa terceira máquina, pelo
  túnel via `gpubox`), `vertex` (um projeto do Google Cloud: Gemini e os parceiros), `anthropic` e `openrouter`
  (esperam a chave). Para começar sem editar nada, `kli init` acha as fontes desta máquina; o `examples/` tem
  configurações prontas só com Ollama, só com CLIs e só com APIs. Bedrock fica para depois (exige assinatura SigV4 da AWS).
- **Laço:** planejar, chamar ferramenta, observar e responder, sem teto de passos nem de tempo: só a pessoa para.
- **Ferramentas:** servidores MCP declarados numa lista. Um servidor fora da lista não conecta, e uma ferramenta sem
  recurso declarado não é oferecida ao modelo.
- **Conhecimento:** busca antes da inferência, no Qdrant local com `bge-m3`.
- **Rastro:** JSONL em `~/.kli/sessions/<id>.jsonl`.
- **Página do `/stackbuilder`:** `src/cli/stackbuilder/`. O `server.ts` sobe o `Bun.serve` com a página (import de
  `.html`, que o Bun empacota e o `bun build --compile` embute no binário) e a API (estado, conferir, salvar, apagar,
  ligar a stack, listar modelos, testar em NDJSON e devolver a escolha da pessoa). O `graph.ts` tem as edições do
  grafo, puras e testadas. A página (`page/main.tsx`, React e React Flow) tem o próprio `tsconfig` (DOM e JSX), e o
  `bun run typecheck` confere os dois. O build define `process.env.NODE_ENV="production"`: sem isso, o binário
  serviria o React de desenvolvimento (1,5 MB em vez de 1 MB, e mais lento). Junto, o `tsconfig.json` raiz diz
  `"jsx": "react-jsx"`: sem ele, o `bun build --compile` gera o JSX de desenvolvimento (`jsxDEV`), que o React de
  produção não tem, e a página abre em branco; um teste compila o binário e confere o JavaScript que ele serve. React, React DOM e `@xyflow/react` são
  as únicas dependências do Kli, e só servem a essa página.

**Reserva:** o `fallback` da configuração é uma lista de modelos, tentada em ordem quando o modelo falha antes de
responder; cada falha aparece no rodapé e no rastro. A cascata vai ser redesenhada depois dos modelos.

## Configuração

Em `~/.kli/config.json`; o `kli init` grava uma com o que esta máquina tem (exemplo completo em `kli.example.json`,
e configurações prontas em `examples/`). Um local de cada tipo:

```json
"model": "laptop/claude/sonnet",
"fallback": ["laptop/ollama/qwen3:4b"],
"locations": {
  "laptop": { "type": "machine", "providers": {
              "ollama": { "type": "server", "port": 11434, "model": "qwen3:4b" },
              "claude": { "type": "cli", "command": "claude", "model": "sonnet" } } },
  "lab":    { "type": "machine", "ssh": "admin@192.168.10.231", "jump": "gpubox", "providers": {
              "ollama": { "type": "server", "port": 11434, "tunnel": true, "model": "gemma3:12b" } } },
  "vertex": { "type": "google", "project": "my-gcp-project", "model": "gemini-3.5-flash-lite" },
  "anthropic": { "type": "anthropic", "model": "claude-sonnet-5-5" },
  "openrouter": { "type": "api", "url": "https://openrouter.ai/api/v1", "apiKeyEnv": "OPENROUTER_API_KEY" }
}
```

As chaves ficam fora, em `~/.kli/.env`. A configuração de antes (perfis e provedores, até 30/10/2026) é recusada com
uma mensagem.

## Fatias, em ordem

1. **Conversa básica** ✅ (30/10): pergunta única, sessão interativa, entrada padrão como contexto, `--json`, perfis
   com fallback e destinations, rastro, `kli profiles` e `kli sessions`. Provedor: Aron, com fallback local.
2. **Tela cheia** ✅ (30/10), como OpenCode e Claude Code: o golem fixo no topo dando status (perfil, provedor,
   estado, última resposta, totais da sessão; pisca esperando o modelo e fica "met" quando o provedor falha), a
   conversa rolando no meio (PgUp/PgDn) e a entrada embaixo, com histórico (↑/↓). Esc ou Ctrl+C interrompe a
   resposta; Ctrl+C na linha vazia ou Ctrl+D sai. Renderizador próprio (sem Ink nem OpenTUI): cada quadro é uma
   lista de linhas e só as que mudaram são reescritas.
3. **Vários provedores** ✅ (30/10): `openai`, `vertex` (Gemini nativo e modelos abertos pelo endpoint compatível)
   e `anthropic`; `kli providers [check]`, `--provider` e `/model`. Testado de verdade: Aron, `lfm3`, `qwen3:14b`,
   `gemini-3.5-flash-lite` e `gemini-3.5-flash`; o Claude está pronto e espera a chave.
4. **Gráficos e harnesses em cascata** ✅ (30/10): `kli stats` e `/stats` desenham, com caracteres de bloco, o que o
   rastro diz (desfechos com ícone e rótulo; mediana de latência e tokens por provedor em barras finas de meio
   bloco; respostas por dia em colunas), na paleta do skill de dataviz validada para fundo claro e escuro (o Kli
   pergunta a cor de fundo ao terminal). Novo tipo de provedor `harness` e `fallback` em lista.
5. **Ferramentas** ✅ (30/10), como no Claude Code: Read, Glob, Grep, Write, Edit e Bash na pasta onde o `kli` roda,
   com permissão antes de gravar e rodar e os modos do Shift+Tab. Depois (30/10): `AGENTS.md` e `CLAUDE.md`, regras de
   comando por parte da linha, saída ao vivo, segundo plano (BashOutput, KillBash, Ctrl+B, `/jobs`) e `!comando`.
   Depois: os CLIs como agentes na pasta, com os passos deles na tela. Falta: MCP.
6. **Confirmação de escrita:** uma ferramenta de escrita inofensiva (gravar nota em arquivo) para provar a regra 4.
7. **Conhecimento:** RAG primeiro. O caminho desenhado é o balizamento das stacks (seção "Balizamento (`ground`):
   desenho").
8. **Escada de modelos:** degrau barato primeiro, sobe quando a chamada vem inválida; taxa de subida medida no rastro.

Feito fora da ordem: **locais → provedores → modelos** ✅ (30/10). Os perfis saíram; o `/model` navega e edita os
três níveis; o Kli acha o que uma máquina tem, abre os túneis e roda CLIs remotos por SSH; as chaves vão para
`~/.kli/.env`. Testado de verdade: os seis provedores do Mac, o `llama-server` e o Claude Code do Aron, o Ollama da
Gibbor, o Gemini e o DeepSeek pela API do Google.

**Model stacks** (31/10), em fatias:

1. **Motor** ✅ (31/10): o grafo na configuração (`stacks`, `stack`), os nós em paralelo pelas dependências, a
   junção, várias saídas, as medidas de cada nó, o rastro e o `kli --stack`. Testado com a `compara` (Gibbor × Aron,
   lado a lado) e a `revisao` (os dois juntados pelo Gemini).
2. **`/stack` na tela cheia** ✅ (31/10): escolher a stack, a árvore ao vivo, as saídas lado a lado e a tabela de
   comparação. Testado com a `compara` e a `revisao`, com Esc no meio e com uma stack quebrada.
3. **Papéis `aggregate` e `verify`** ✅ (31/10): o agregador junta e diz de onde veio cada parte; o verificador só
   julga, listando os requisitos do prompt e dando a aderência ao resultado final e a cada ramo. Na tela, um bloco
   com os requisitos e as marcas, e a aderência na tabela de comparação. Testado com a `verificada` e a
   `compara-verificada`. Falta: a aderência ao longo do tempo no `kli stats`.
4. **Etapa de escolha** ✅ (31/10): o papel `choose`, com `by` = `model`, `person` ou `decision` (este fica pulado até
   haver um modelo de decisão treinado: o que se testou sem treino prefere uma posição). Testado com a
   `escolhe`: no `kli -p` o Gemini escolheu; na tela cheia, a pessoa escolheu pelo seletor.
5. **`/stackbuilder`** ✅ (31/10): uma página em React (com React Flow), servida pelo próprio `kli` e embutida no
   binário, para montar o grafo, testar com um prompt (inclusive a escolha pela pessoa) e salvar na configuração;
   também `kli stackbuilder`. Testado no Chrome sem janela com as stacks reais: a `verificada` (Gibbor, Aron, Gemini
   agregando e verificando) em 42 s, a `escolhe` com a escolha feita na página, e criar, ligar, salvar, renomear,
   pôr para responder e apagar uma stack, conferindo o arquivo a cada passo.
6. **Ramos que gravam** ✅ (01/11): `"tools": "write"`, cada nó numa cópia da pasta (um `git worktree` que parte da
   pasta como ela está, com o que não foi comitado), comandos de leitura mais os de `write.run`, `write.setup` e
   `write.check`, o diff e a checagem para quem julga, e a pergunta de qual aplicar na tela cheia (no `kli -p`, só os
   diffs). Decisões do Alexandre: comandos de leitura + lista da stack, o Kli pergunta qual aplicar, a cópia parte
   do estado atual e a checagem entra já. Testado com a stack `conserta` (Gemini 3.5 Flash com as ferramentas do Kli
   e Claude Code com o Haiku, numa função com bug): os dois corrigiram, o `bun test` passou nas duas cópias, o juiz
   deu 100 e 88 (o Haiku começou em inglês), e aplicar levou o diff do Gemini à pasta. Num projeto com dependência
   (`node_modules` ignorado), `write.setup` = `bun install` deixou cada cópia pronta, e o OpenCode, o Kimi e o
   Antigravity, como nós que gravam, corrigiram o mesmo bug com a checagem passando nas três cópias. Depois, a pedido
   do Alexandre ("tem que ser transparente para o usuário, bun é uma ferramenta do kli e não do projeto"), o setup e
   a checagem passaram a vir do projeto: `.kli/write.json`, a stack, ou os arquivos dele. Em 02/11, depois do teste do
   Alexandre num repositório com o backend em .NET e o frontend em npm: o juiz deixou de receber as instruções da
   configuração e ganhou os requisitos fixos (`requirements`); a detecção passou a olhar as pastas logo abaixo e a
   conhecer o .NET; as recusas aparecem na linha do nó; os comandos e a checagem rodam numa cerca do sistema; o que o
   setup cria fica fora do diff; o rastro registra o que foi aplicado; e as cópias de um Kli que morreu são removidas
   pelo próximo. Mais tarde, no mesmo dia, depois do uso do Alexandre num repositório com crates Rust, um frontend
   npm e testes Python sem lockfile: o nó que estourou o tempo (o Antigravity, aos 15 min, com quatro arquivos
   mudados) passou a guardar o que fez e a aparecer na lista de aplicar; os testes Python soltos passaram a ser
   reconhecidos (`python3 -m unittest`, do topo); a checagem só roda num nó que mudou arquivos; e um CLI que estoura
   o tempo para junto com o que ele iniciou (antes, um comando filho segurava a resposta até acabar). Testado no clone
   dele com o Gemini: uma pergunta sem mudança terminou em 13,8 s sem checagem, e uma correção de uma frase rodou
   os 39 testes Python e os Rust dentro da cerca. Antes, no clone do primeiro repositório, com o Gemini 3.5 Flash: `dotnet test` (933 testes) e o `lint` do
   frontend dentro da cerca, a checagem passando, aplicar pela tela cheia e o `kill -9` no meio de uma rodada. Ainda
   em 02/11, a pedido do Alexandre, depois de a `opus-kimi` (um nó que grava e o Kimi conferindo) não conseguir dar
   um `git pull` na `master` de um repositório: o nó que grava sozinho edita a pasta, sem cópia e sem aplicar, com o diff
   de cada resposta para o juiz e a checagem na própria pasta; cópia só numa comparação (dois ou mais nós que
   gravam), uma cópia comum da pasta em vez do `git worktree` (funciona fora do Git e dispensa o setup), e cada
   rodada termina com todas as cópias apagadas, depois de aplicar a escolhida ou de nenhuma (o código só chegou em
   06/11, abaixo). Em 03/11, a pedido do
   Alexandre ("todo modelo deve rodar sem tempos limites, até que termine ou o usuário interrompa com ESC"): saíram
   o tempo-limite dos pedidos HTTP (2 min), dos CLIs (15 min) e dos nós (15 min), o teto de passos do laço (30 numa
   conversa, 150 num nó) e, com eles, o "go on" do nó que estourava, que ficou sem quando aparecer. Ainda em 03/11, a pedido do
   Alexandre ("ok para push por exemplo deveria ser entendido como algo simples e não chamar o pipeline da stack"):
   a triagem antes da stack, com o modelo escolhido pela pessoa (`/triage`) e a finalidade de cada stack
   (`purpose`), medida com um modelo de decisão sem treino, o lfm3, o qwen2.5-7b, o Haiku e o Gemini 3.5 Flash Lite. Ligada na configuração
   do Alexandre com o qwen2.5-7b do Aron e finalidade nas stacks de um tipo de trabalho (código, personagens,
   texto); as de comparação seguem recebendo tudo. Conferida com a configuração dele: 9 de 9 mensagens nas três
   stacks, em 0,2 a 0,6 s (uma levou 6,4 s). Em 06/11, a pedido do Alexandre ("pode fazer 1 e 2", da fila de 02/11):
   quem recebe um CLI recebe só a mensagem final dele, com a lista das ferramentas para quem julga ou escolhe, e o
   juiz não espera o mais lento, julgando em rodadas. Testado com o Claude Code (Haiku) e o Antigravity lendo e o
   Gemini 3.5 Flash julgando: duas rodadas, com o juiz começando aos 6 s, quando o Claude Code terminou, e
   julgando o Antigravity aos 17 a 26 s; ao juiz foram 101 de 177 caracteres de um e 326 de 413 do outro. Ainda em
   06/11, a pedido do Alexandre ("aprovado! pode fazer os 4"), o código passou a seguir as regras da cópia de 02/11,
   que até ali estavam só nesta página: a cópia comum clonada no lugar do `git worktree`, medida num Git só do Kli
   (nada é gravado no repositório da pessoa); uma rodada por pergunta, com todas as cópias apagadas ao aplicar, no
   Esc, no "none" e na pergunta seguinte, e cada nó avisado de que nada foi aplicado; tudo isso também fora do Git;
   o setup saiu; e, depois de um Esc no meio, a lista de aplicar aparece com o que os nós já fizeram. Testado na tela
   cheia com o Haiku (Claude Code) e o Gemini 3.5 Flash num projeto Python com um bug: o "none" apagou as cópias e
   deixou a pasta como estava; aplicar levou o `calc.py` e apagou as cópias; e um Esc quando o Gemini terminou
   ofereceu o Gemini (`check passed`) e o Haiku (`interrupted, not judged`), e aplicar o Gemini levou os dois
   arquivos. O `git worktree list` ficou com uma linha só do começo ao fim. Depois, a pedido do Alexandre ("pode
   fazer", item 3 da fila de 02/11), a linha de cada nó passou a dizer como ele vai enquanto roda: o que leu, a
   primeira edição e o tempo quieto. Conferido na tela cheia com o Haiku (Claude Code) e o Gemini 3.5 Flash
   (`read 13 lines · no edit yet`, depois `first edit at 6.3s`); o `quiet for` só nos testes, porque nenhum dos dois
   ficou um minuto parado. Por fim, os itens 4 e 5 da fila ("vamos fazer os dois pontos que restam"): o juiz e quem
   escolhe recebem o tamanho de cada mudança lado a lado, e o juiz julga o trabalho de um nó que falhou depois de
   mudar arquivos. Testado com o Gemini 3.5 Flash gravando e julgando, ao lado de um "CLI" que acrescentava `moda()`
   ao `calc.py` e saía com erro: a checagem rodou no que ele deixou, o juiz o recebeu marcado como inacabado na
   primeira rodada e, na segunda, o Gemini com os dois tamanhos lado a lado (4 linhas contra 10), e deu 50 ao
   inacabado (faltava o teste) e 75 ao Gemini; a lista de aplicar mostrou `failed, unfinished · adherence …`.
7. **Balizamento (`ground`), a base** ✅ (02/11): o papel `ground`, a forma comum das fontes, a fonte `files`
   (texto, Markdown, CSV, JSON), os modos, a consulta, as regras, o orçamento, o que esconder, o rastro, o card, o
   painel das fontes e a prévia no teste do `/stackbuilder`. Decisões tomadas com o "pode fazer" do Alexandre: o nome
   `ground` (na tela, "grounding"), o modo padrão `enrich`, e a consulta de um `ground` não usa o contexto de um
   `ground` anterior (o contexto passa adiante, a consulta vem do pedido e das respostas). Testado com o Gemini 3.5
   Flash sobre os `docs/` do Kli: em `restrict` respondeu só com o contexto e disse que a capital da Austrália não
   estava lá; em `enrich` respondeu as duas coisas, citando o contexto. Próximas: uma fonte por fatia e o modelo
   opcional no card (seção "Balizamento (`ground`): desenho").

Ficam para depois: multimodal e espaço do usuário (Workspace).

## Balizamento (`ground`): desenho

Proposta de 01/11/2026, pedida pelo Alexandre. A base foi feita em 02/11 (o papel, a fonte `files`, os modos, a
consulta, as regras, o orçamento, o rastro, o card, o painel e a prévia: ver "Balizamento" em "Model stacks"); as
outras fontes e o modelo opcional no card continuam desenho.

Um nó que **traz contexto de fora para dentro do grafo** e entrega a etapa seguinte "balizada". Em inglês o termo é
*grounding*, e o papel é `ground`, ao lado de `answer`, `aggregate`, `verify` e `choose`. As **fontes de dados** dele
(um banco, uma pasta, um RAG) não se confundem com as fontes de inferência (locais, provedores e modelos).

- **Em qualquer ponto do grafo.** O `ground` é um nó como os outros: entra antes de um ramo (o RAG clássico), depois
  de um rascunho (busca os fatos que ele citou), antes do agregador ou do verificador (as regras da casa), ou
  encadeado (`ground → ground`: o SQL acha os produtos, e a busca vetorial traz os manuais deles). Cada ramo pode ter
  os seus, com fontes diferentes em momentos diferentes, e as medidas e o verificador dizem qual estratégia de
  contexto rende a melhor resposta. Um `ground` antes de dois ramos dá aos dois o mesmo contexto: a comparação fica
  justa.
- **Dois modos (`mode`).** `enrich` acrescenta: o modelo seguinte usa o contexto quando ajuda, junto com o que sabe,
  e cita o que veio dele. `restrict` limita: só o contexto, com a citação, dizendo quando a informação não está lá.
- **De onde sai a consulta (`query`).** `request` (o pedido), `answers` (o que chegou dos nós anteriores, como os
  termos e fatos de um rascunho) ou `both`. Um modelo no nó é opcional: extrai os termos de busca e resume o que não
  cabe. Sem modelo, o nó só busca, organiza e entrega, sem custo de inferência.
- **Transparente na cadeia.** O nó seguinte recebe o pedido, as respostas que chegaram ao `ground` (por letra, como
  hoje) e o contexto numerado, com as regras de uso. Pôr um `ground` entre dois nós não quebra a cadeia, só
  acrescenta:

```
<request>quanto vendemos de Grace em outubro?</request>
<answer from="A">…</answer>                       (só quando o ground recebeu respostas)
<context>
[1] sql:vendas · 3 linhas
    | produto | mês | qtd | …
[2] gdrive:politicas · Política de Reembolso (Docs) · alterado em 28/10 · https://drive.google.com/…
    "…"
</context>
<rules>Responda só com o contexto e cite [n]. Se não estiver lá, diga.</rules>
```

Por dentro, cada `ground` faz sempre o mesmo caminho:

```
consulta → busca em cada fonte (em paralelo) → regras → orçamento de tokens → pacote
```

- **Regras:** as fontes permitidas, filtros, mascarar dados (CPF, e-mail) e o texto do usuário (`rules`), que vai
  por cima das regras padrão do modo. Um **contexto anexo** fixo (um glossário, uma política) também pode ir sempre.
- **Orçamento (`budget`):** fica o mais relevante até o limite de tokens, e o que foi cortado é dito.

### Fontes de dados: plugáveis, todas iguais

Cada fonte de dados é um **adaptador com a mesma forma**: recebe a consulta e devolve trechos, cada um com título,
referência e link para a citação, o texto, a nota de relevância e a data de alteração. O `ground` não sabe de onde
veio cada trecho. Uma fonte nova é um arquivo em `src/core/sources/`, com o seu teste de servidor falso, como um
provedor. As fontes ficam declaradas uma vez, em `sources` na configuração, e servem a qualquer stack; o que é
segredo (a conexão de um banco, um token) vai para o `~/.kli/.env`, e a configuração guarda só o nome da variável.

| `type` | O que é | Como busca | Observação |
|---|---|---|---|
| `files` | pastas e arquivos locais | o Kli recorta e ordena os trechos | `.md`, `.txt`, `.csv`, `.json`; `.xlsx` por um leitor próprio (o zlib vem no Bun); `.pdf` pelo `pdftotext` ou por uma dependência (decidir) |
| `sql` | PostgreSQL, MySQL, SQLite | consulta fixa com parâmetros, só leitura | `Bun.SQL` vem no Bun (o SQLite foi testado); o SQL Server precisaria de um driver |
| `qdrant`, `weaviate` | bancos vetoriais | HTTP; o embedding da consulta vem de um modelo dos locais (ex.: `bge-m3` no Ollama) | `top` e filtros |
| `ragnarock` (ou `http`) | um RAG com API própria | a rota de busca dele | falta conhecer a API; ou MCP, quando o Kli tiver |
| `gdrive` | uma pasta do Google Drive | a busca do próprio Drive (`fullText contains` na pasta), com o login do usuário | Docs, Sheets, Slides, PDF e xlsx; cache por arquivo e data de alteração |

**Google Drive, como as outras.** O login é o OAuth do próprio usuário, só de leitura: o retorno cai na página do
`/stackbuilder` (que já roda em `127.0.0.1`) ou vem do `kli login google`, e o token vai para o `~/.kli/.env`. O
`drive.readonly` é um escopo restrito do Google: um cliente interno de uma organização Workspace dispensa a
verificação, e um cliente externo em modo de teste perde o login de tempos em tempos (o prazo ainda vai ser
conferido). Uma busca por significado no Drive viria depois, por um índice local (a pasta sincronizada num banco
vetorial) ou pelo RAG Engine do Google.

```json
"sources": {
  "politicas": { "type": "gdrive", "folder": "https://drive.google.com/drive/folders/…" },
  "docs":      { "type": "qdrant", "url": "http://localhost:6333", "collection": "docs",
                 "embed": "laptop/ollama/bge-m3", "top": 8 },
  "vendas":    { "type": "sql", "urlEnv": "VENDAS_DB",
                 "query": "select produto, mes, qtd from vendas where produto ilike :termo limit 50" },
  "manuais":   { "type": "files", "paths": ["~/docs/*.md"] }
},
"stacks": { "balizada": { "nodes": {
  "contexto": { "role": "ground", "sources": ["docs", "manuais"], "mode": "enrich" },
  "local":    { "model": "laptop/ollama/lfm3", "from": ["contexto"] },
  "fatos":    { "role": "ground", "from": ["local"], "sources": ["vendas", "politicas"],
                "mode": "restrict", "query": "answers", "budget": 2000 },
  "revisor":  { "model": "vertex/google/gemini-3.5-flash", "from": ["fatos"] } } } }
```

### No `/stackbuilder`

- **Card próprio**, com cor e ícone, o modo e as fontes; pode ser solto em qualquer ligação.
- **Painel do card:** fontes, modo, consulta, regras, contexto anexo, orçamento, `top` e o modelo opcional.
- **Painel lateral "Sources":** cadastrar as fontes de dados, conectar uma conta (o Google, por exemplo) e **Test
  source**, que roda uma busca e mostra os trechos.
- **No teste**, cada `ground` mostra o que injetou naquele momento: de que fontes, os trechos, as notas, os tokens e
  se cortou.

### Medidas, rastro e segurança

- **Medidas por fonte:** tempo, trechos, notas, tokens injetados e se cortou. Um evento `ground` no rastro diz o que
  entrou (respeitando o `sessions.content`).
- **Só leitura:** o SQL aceita só `SELECT`/`WITH`, com tempo-limite e limite de linhas (o ideal é um usuário de banco
  só de leitura); os arquivos, só nas pastas declaradas; o OAuth, só o escopo de leitura.
- **Para onde vai:** o contexto vai para o modelo do nó seguinte, local ou de API; a prévia do teste mostra
  exatamente o que entrou.

### Fatias

1. **Base:** o papel `ground`, a forma comum das fontes, a fonte `files` (texto, CSV, JSON), os modos, a consulta,
   as regras, o orçamento, o rastro, o card, o painel e a prévia no teste.
2. **Uma fatia por fonte de dados**, na ordem que o Alexandre escolher: `gdrive`, `qdrant` e `weaviate`,
   `ragnarock`, `sql`, e o `.xlsx` e o `.pdf` nos `files`.
3. **O modelo opcional no card:** extrair os termos e resumir.

## Decisões em aberto

- **Identidade no estudo.** Hoje vale o `pessoa` da configuração ou o usuário do sistema; a credencial ADC do
  `gcloud` entra junto com o Vertex.
- **Contexto que cresce.** A conversa manda o histórico inteiro a cada pergunta, e o Aron tem 16k por conversa.
  Falta decidir o que fazer quando estourar (cortar as mais antigas, resumir, avisar).
- **Balizamento, depois da base.** A ordem das fontes de dados; o `.pdf` e o SQL Server (dependência ou ferramenta
  externa); se um modelo pode escrever o SQL ou só consultas fixas com parâmetros; a API do RAGnaRock; o cliente
  OAuth do Google (de cada pessoa ou interno da organização); se a consulta de um `ground` passa a usar o contexto de
  um `ground` anterior (na base, não usa).
