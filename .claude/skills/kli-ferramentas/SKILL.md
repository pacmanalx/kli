---
name: kli-ferramentas
description: As regras das ferramentas do Kli (Read, Glob, Grep, Write, Edit, Bash, BashOutput, KillBash), da permissão, dos comandos, do !comando, das instruções AGENTS.md/CLAUDE.md e dos CLIs como agentes. Use antes de mexer em tools.ts, shell.ts, jobs.ts, instructions.ts, shell-mode.ts, permission.ts ou nos presets e leitores dos CLIs, e sempre que for liberar, afrouxar ou endurecer uma permissão.
---

# Kli · Ferramentas e permissão

A régua é o Claude Code (skill `kli-produto`). As regras de permissão abaixo só se afrouxam com o Alexandre.

## 1. Quem faz o quê

O modelo só pede; quem executa é o Kli, nesta máquina, na pasta onde o `kli` roda (o `Workspace`). Vale mesmo quando o
modelo está em outra máquina. O laço vai até o modelo responder só com texto, **sem teto de passos nem de tempo**
(decisão do Alexandre, 03/11/2026: "todo modelo deve rodar sem tempos limites, até que termine ou o usuário
interrompa com ESC"). Só o Esc para: os pedidos sem resposta ganham "Not run", e a pergunta sai da conversa. Não
ponha de volta um teto, um aviso de "faltam N" nem um relógio no laço. Cada ferramenta
aparece na tela (`● Write(soma.py)` e `⎿ Wrote 16 lines to soma.py`, com a diferença) e vai para o rastro (`tool`).

## 2. As ferramentas

O nome, os parâmetros e o resumo seguem o Claude Code:

| Ferramenta | Regra |
|---|---|
| **Read** | linhas numeradas (`cat -n`), `offset`/`limit`, 2000 linhas por vez; diz quanto falta |
| **Glob** | arquivos e pastas (pastas com `/` no fim), sem `node_modules` nem `.git`; resumo `Found 2 files and 1 folder` |
| **Grep** | usa o `rg` |
| **Write** | um arquivo que já existe só é gravado depois de lido na sessão |
| **Edit** | o `old_string` aparece uma vez só, ou é preciso `replace_all`; também exige leitura antes |
| **Bash** | `bash -c` na pasta; limite de 120 s, até 600 s se o modelo pedir; saída ao vivo |
| **BashOutput** e **KillBash** | o que é novo de um comando em segundo plano (`b1`), e parar esse comando |

O prompt de sistema diz para usar ferramentas só quando o pedido é sobre os arquivos da pasta ou precisa de um
comando, e para escrever textos direto na resposta. Sem isso, o `qwen2.5-7b` mandou um texto por `echo` 9 vezes
(31/10/2026). Mudou essa frase? Meça de novo com modelos pequenos.

Ferramenta nova entra em `TOOL_SPECS` e no `run`, com resumo, teste em `test/tools.test.ts` e uma linha no
`docs/kli.md`.

## 3. Permissão

- **Livre:** ler, procurar e listar dentro da pasta. Também é livre o comando que só lê (`readsOnly` em `shell.ts`),
  desde que todo caminho (`~`, `/`, `..`) fique dentro da pasta, nada seja gravado com `>`, nada entre com `<` de
  fora e nenhuma palavra seja `$variável`.
- **Pergunta antes:** Write, Edit e Bash, mostrando a diferença ou o comando. As respostas são três:
  - **Yes**;
  - **Yes, allow all edits** (num comando, **don't ask again … for**);
  - **No, and tell Kli what to do differently** (Esc), que para o turno.
- **"Não perguntar de novo" num comando:** a regra é o comando com até duas palavras simples (`npm run build`). Ela
  cobre o que começa igual, nunca outro subcomando. Cada parte da linha (`&&`, `||`, `;`, `|`, `&`) precisa estar
  coberta.
- **Liberado só exatamente como pedido:** comando de uma palavra, os do conjunto `EXACT` (`rm`, `mv`, `cp`, `dd`,
  `chmod`, `sudo`, `kill`, `ssh`, `bash`, `xargs`, `env`, `find`...) e os que começam com `NOME=valor`. Palavra
  com `$` não vira regra.
- **Pergunta sempre e diz por quê** (escopo `once`): o que pode esconder outro comando (`$(…)`, crases, `<(…)`,
  subshell, here-document, `if`/`for`/`while`/`{…}`, aspas abertas) e o que grava fora da pasta com `>`.
- **Fora da pasta:** pergunta sempre, inclusive no accept edits.
- **Modos (Shift+Tab):** default → **acceptEdits** (grava sem perguntar; comandos continuam perguntando) →
  **plan** (só as ferramentas de leitura e o Bash que só lê; o resto é recusado também na execução).
- **`kli -p`:** não tem a quem perguntar, então o que precisa de permissão é recusado.
  `--permission-mode acceptEdits` libera as edições.
- **Nó que grava numa stack:** os comandos que só leem e os do projeto (`core/project.ts`). Do `package.json`, o
  script e o comando que ele roda, se for simples (`"test": "bun test"` libera `npm test` e `bun test`); nunca um
  corpo com `&&`, `$`, aspas ou redirecionamento, um do `EXACT`, um `NOME=valor` nem um runtime sozinho (`node`,
  `bun`, `npx`). A recusa e a nota do nó dizem o que roda e com que comando os testes rodam.
- **Para pôr um comando na lista dos que só leem:** ele precisa de fato só ler. As opções que gravam ou rodam código
  vão em `UNSAFE` (`find -exec`, `sort -o`, `rg --pre`...). O teste entra nos dois sentidos em
  `test/shell.test.ts`.

## 4. Comandos

- **Processo:** cada comando roda num grupo de processos próprio. Parar (Esc, tempo esgotado, KillBash, saída do Kli)
  manda TERM ao grupo e KILL em 2 s.
- **Saída:**
  - stdout e stderr chegam juntos e em ordem;
  - sem cores, e a barra de progresso fica no último estado (`plainText`);
  - o Kli guarda até 2 MB, e o modelo recebe começo e fim (até 30 mil caracteres);
  - a tela mostra as últimas 5 linhas.
- **Segundo plano:**
  - `run_in_background` devolve um id (`b1`), e Ctrl+B manda para lá o comando que está rodando;
  - `/jobs` lista e `/jobs stop` para;
  - quando um termina, o modelo fica sabendo por `<note from="kli">` na mensagem seguinte;
  - tudo para no `/exit`, no fim do `kli -p` e na saída do processo.
- **Sem terminal:** o Bash do modelo não recebe teclas. Senha, `sudo` e login só funcionam pelo **`!comando`**: a
  pessoa roda o comando ela mesma, com o terminal entregue a ele, e o `script` grava a tela para a próxima mensagem.
  No macOS é `script -q arquivo bash -c`; no Linux, `script -q -e -c`.

## 5. Instruções do projeto

- **Arquivos lidos:** `AGENTS.md` e `CLAUDE.md`, os dois, primeiro em `~/.kli`, depois em cada pasta de `/` até a
  pasta do `kli`. O mais perto vem por último.
- **Repetições:** um arquivo só entra uma vez, pelo caminho real ou pelo conteúdo igual. Um `CLAUDE.md` que só tem
  `@AGENTS.md` não acrescenta nada.
- **Imports:** `@caminho` importa outro arquivo, até 5 níveis, fora de bloco de código e só se o arquivo existe.
  Cada arquivo vai até 40 mil caracteres.
- **Subpastas:** o arquivo de uma subpasta entra na primeira vez que o modelo lê algo dela.
- **Onde vai:** tudo vai no prompt de sistema, e o `/status` mostra o que entrou.

## 6. CLIs como agentes

| CLI | Modo normal e accept edits | Modo plan |
|---|---|---|
| Claude Code | `--dangerously-skip-permissions` | `--permission-mode plan` |
| Antigravity | `--dangerously-skip-permissions` | `--mode plan`, com `deny` de comando, MCP e URL |
| OpenCode | `--auto` | `--agent plan` |
| Kimi Code | `-p` já age sozinho (recusa `--auto` e `--yolo` com `-p`) | não há plan com `-p`: roda isolado |

- **Modo isolado:** sem pasta (o `kli check`) ou noutra máquina, o CLI roda isolado em `~/.kli/harness`. O Claude
  Code roda sem ferramentas, sem MCP e sem hooks; o Antigravity, em `--mode plan --sandbox`, sem comandos, MCP nem URL.
- **Antigravity e a recusa** (12/11/2026, decisão do Alexandre): com `-p`, o `agy` recusa o que as regras dele não
  liberam e **encerra a execução**, como sucesso, só com o "Vou ler…". No plan e no isolado, o Kli passa
  `--settings` com `deny` para `command(*)`, `mcp(*)`, `read_url(*)` e `execute_url(*)` (os tipos de regra que
  perguntam; o MCP entrou depois que uma busca no `qdrant-rag` parou a stack): a recusa explícita volta ao modelo,
  que segue lendo. Ela vence as liberações da pessoa no `agy` (até o `ls`), e é de propósito: o plan não roda
  comando nem ferramenta de fora. Um tipo novo de pergunta do `agy` cai no `denied_actions` e aparece como falha:
  acrescente-o à lista. O leitor marca o
  passo como `refused` e transforma `denied_actions` em erro do nó. Liberar algum comando no plan (os `git` que só
  leem, por exemplo) é afrouxar: só com o Alexandre, e a regra do `agy` é por prefixo (`git log --output=` grava).
- **`PWD`:** o CLI recebe o `PWD` da pasta em que roda, porque o OpenCode segue o `PWD` e não a pasta do processo.
  Sem isso, ele trabalhava onde o terminal estava (31/10/2026).
- **Grupo de processos próprio** (`detached`, como os comandos do Bash): no Esc, o Kli para o grupo todo (TERM, e
  KILL depois de 2 s). Parando só o CLI, um comando que ele iniciou segurava a saída aberta, e a resposta esperava
  esse comando acabar (02/11/2026: o CLI parou aos 4 s e o nó só terminou aos 30 s).
- **Sem tempo-limite** (03/11/2026): um CLI roda até terminar ou até o Esc. Os presets não têm `timeoutMs`, e um
  `timeoutMs` que tenha ficado na configuração é ignorado.
- **Args próprios:** um CLI com `args` na configuração roda como eles dizem, sem modos.
- **Passos na tela:** cada passo de um CLI vira um passo do Kli na tela e no rastro (`agent: true`). O nome vem do
  Claude Code (`TOOL_NAMES`: `run_command` vira Bash, `view_file` vira Read...). Os caminhos aparecem relativos à
  pasta.
- **CLI novo:**
  - confira as flags de verdade com `--help` antes de usar, porque o Kimi, por exemplo, recusa `--auto` com `-p`;
  - o preset leva `{prompt}`, `{model}` e `{mode}`;
  - o leitor do formato emite `ToolStep`;
  - entra um caso no `fake-harness.ts` e um teste em `test/harness.test.ts`.

## 7. Tela

- **Tabulação:** ela é expandida antes de desenhar; sem isso, ficam restos da linha anterior.
- **Mensagens longas:** quebram em linhas (`wrap`, em `output.ts`), sem cortar na borda.
- **Relógio:** o "running" não corre enquanto a permissão espera a resposta.
- **A conversa vai para o histórico do terminal:**
  - cada entrada que não muda mais (`settled`) é impressa uma vez;
  - de uma resposta ainda chegando vão as linhas que já não mudam (`stable`). Isso só funciona porque a quebra de linha
    gulosa não mexe nas linhas anteriores;
  - a parte viva tem no máximo a altura da tela menos uma linha, com o topo cortado. Mais alta que isso, o terminal
    rolaria e o redesenho subiria menos do que precisa;
  - inserir uma entrada antes de `committed` quebraria a ordem.
- **Conferir no terminal:** toda mudança de tela é conferida num terminal de verdade (skill `kli-entrega`). O
  `scratchpad/e2e/drive2.py` usa o `pyte.HistoryScreen`, que guarda o histórico de rolagem.
