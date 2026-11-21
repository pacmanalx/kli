---
name: kli-stacks
description: As regras das model stacks do Kli, grafos de modelos que respondem como um só (bifurcações, junção, várias saídas para comparar, agregador, verificador, escolha). Use antes de mexer em stack.ts, stack-run.ts, no /stack, no /stackbuilder ou nos papéis dos nós, e ao decidir como uma stack mede, mostra ou grava o que fez.
---

# Kli · Model stacks

O conceito é do Alexandre (31/10/2026). Uma pergunta entra para um, dois ou mais modelos; as respostas e as medidas
de cada um são coletadas; um agregador junta; um último modelo cruza o pedido inicial com o resultado. No fim se
mede cada etapa e o todo, e se mostra o quanto o resultado adere ao pedido. Uma stack também pode dividir o trabalho
em dois e dar **duas saídas**, para comparar modelos e as ferramentas que o Kli chama. O plano em fatias está no
`docs/kli.md`, seção "Model stacks".

## 1. Decisões do Alexandre

- **Escolha da stack:** o `/stack` escolhe a stack, e a escolha fica no `"stack"` da configuração. **Sem stack
  escolhida, responde o `model` configurado.**
- **Fora do `/model`:** as stacks não entram lá, e não existe nome `stack/<nome>`.
- **Triagem (03/11/2026):** "ok para push por exemplo deveria ser entendido como algo simples e não chamar o
  pipeline da stack"; "deixe a escolha desse modelo configurável". Antes da stack, um modelo pequeno decide se a
  mensagem é o trabalho dela ou vai para o `model` sozinho (seção 2e). O modelo é da pessoa (`/triage`), e um modelo
  de decisão só entra treinado. Na configuração dele, a triagem ficou num modelo local pequeno, e a finalidade só nas
  stacks de um tipo de trabalho (código, personagens, texto). As stacks de comparação ficam sem finalidade e recebem
  tudo: comparar em qualquer mensagem é o trabalho delas.
- **Montar o grafo:** pelo `/stackbuilder`, uma página web em React com React Flow (skill `kli-stack`), "como
  quisermos". A configuração continua sendo a verdade, e a página só desenha o que está nela.
- **Escolha numa etapa:** uma etapa pode escolher entre respostas de três jeitos: por um modelo, pela pessoa, ou por
  um modelo de decisão, quando houver um treinado.
- **O verificador só julga.** Ele não reescreve a resposta.
- **O agregador** recebe só as respostas, marcadas com letras, sem o nome do modelo nem as medidas. As medidas vão
  para o relatório.
- **Ferramentas:** por padrão, os ramos só leem. Um nó que responde pode gravar (`"tools": "write"`), na sua cópia da
  pasta (fatia 6, 01/11/2026). As decisões dele:
  - **as regras da cópia** (02/11/2026, as palavras dele: "worktree só quando comparamos modelos, se eu estou na
    pasta principal quero editar o código principal, sem invencionices"; "só quero novas worktrees se eu pedir… a
    worktree foi um subterfúgio para compararmos modelos e depois escolher… quando aplicamos, mantemos somente a
    escolhida sobre o local onde estamos trabalhando, master, branch, etc… as outras são jogadas fora, simples
    assim"; "pode ser que estejamos num projeto que não esteja no git"):
    1. por padrão o nó grava na pasta da pessoa (`writesInFolder`: um nó só que grava), seja `master`, branch ou
       pasta fora do Git; sem cópia e sem aplicar;
    2. cópia só numa comparação, e o pedido é a stack: dois ou mais nós que gravam. Cada pergunta é uma **rodada**;
    3. a cópia é uma **cópia comum da pasta** (clonada no APFS), nunca um `git worktree`: funciona fora do Git, leva
       as dependências (sem setup) e não registra nada no repositório da pessoa;
    4. aplicar leva os arquivos da escolhida para a pasta e apaga **todas** as cópias; Esc também apaga todas;
    5. nada passa de uma rodada para a outra além da conversa dos nós.

    Não invente um terceiro modo, uma opção para manter cópias nem cópias que sobrevivem à rodada;
  - **comandos:** os que só leem, mais a lista que a stack declara (`write.run`); o resto é recusado;
  - **aplicar:** na tela cheia o Kli pergunta qual aplicar; no `kli -p` nunca aplica, só mostra os diffs;
  - **checagem:** roda onde o nó trabalhou, e conta no veredito;
  - **transparente:** "bun é uma ferramenta do kli e não do projeto" (01/11/2026). A checagem e os comandos
    liberados vêm do projeto (`src/core/project.ts`): o `.kli/write.json` dele, senão o `write` da stack, senão os
    arquivos (lockfile, `go.mod`, `Cargo.toml`, `uv.lock`, `requirements.txt`). Nunca ponha `bun` numa stack geral.
- **Sem limite** (03/11/2026, as palavras dele: "todo modelo deve rodar sem tempos limites, até que termine ou o
  usuário interrompa com ESC"): nenhum nó tem tempo-limite nem teto de passos, pelo laço do Kli ou por um CLI. O Esc
  para todos. Não existe mais "go on": ele servia ao nó que estourava, e nada estoura. Não ponha de volta um
  relógio, um teto, um aviso de "faltam N" nem uma opção de retomar.
- **Balizamento (`ground`), 01/11/2026, ainda só desenho** (`docs/kli.md`, seção "Balizamento (`ground`): desenho"):
  um nó que traz contexto de fontes de dados e entrega a etapa seguinte balizada, **em qualquer ponto do grafo**,
  em quantos ramos for, com fontes diferentes em momentos diferentes; modos `enrich` (enriquecer) e `restrict`
  (limitar). As fontes de dados são **plugáveis e todas iguais** (`files`, `sql`, `qdrant`, `weaviate`, `ragnarock`,
  `gdrive`): "o GDrive é só mais uma opção de fonte de dados, nada mais". Não reorganize o desenho em volta de uma
  fonte.

## 2. Regras do motor (`src/core/stack.ts` e `stack-run.ts`)

- **A forma do grafo e o motor ficam em arquivos separados.** O `stack.ts` só tem funções puras (problemas, ordem,
  saídas, o texto da junção) e é o que o `config.ts` importa. O `stack-run.ts` roda a stack. Juntar os dois cria um
  ciclo de imports.
- **Validação:**
  - na carga da configuração, só a forma: nós que existem, sem ciclo, alguém recebe o prompt, `min` e `tools`
    válidos;
  - o modelo de um nó é conferido **quando a stack roda**, para que tirar um local não quebre a configuração. O nó
    falha, e a stack segue;
  - renomear um local ou provedor renomeia os nós junto.
- **Paralelo:** cada nó começa quando suas entradas terminam, e os nós sem entrada começam juntos.
- **A stack não para** (12/11/2026, as palavras dele: "a stack não pode parar e se parar tem que evidenciar o motivo,
  hoje não está claro pois o processo morre em silêncio"). Um Gemini que parou numa recusa do agy derrubava o Sonnet
  e o juiz atrás dele (`0 of 1 inputs answered`), e a tela cortava o motivo no fim da linha. Agora:
  - `answer` e `aggregate` rodam sempre que as entradas terminam, respondam elas ou não. O nó que falhou entrega o que
    disse (`said`, guardado no `NodeResult.text` da falha) como `<answer … unfinished="its step failed before it
    ended">`, e o que não disse nada vem pela letra em `silent` ("Step A did not answer: do yourself what it was to
    do."; `missingNote` em `stack.ts`). Sem nenhuma resposta, o agregador cai no `joinPrompt` e responde sozinho;
  - um `ground` que falhou passa pelo `through` com `Grounding.unreachable` (o motivo); o `contextLines` diz "(the
    data sources could not be searched: …)" e o modo segue valendo (em `restrict`, nada de fora das fontes);
  - só `verify` e `choose` são `skipped`, sem nada para julgar ou escolher, e o motivo diz quais faltaram. O `min`
    só vale para eles; num `answer` ou `aggregate`, ele passa na validação e é ignorado, e o builder só mostra o
    campo para esses dois papéis.
- **Reserva:** a reserva global **nunca vale** num nó, porque outro modelo no lugar dele faria a comparação mentir.
  Só vale o `fallback` do próprio nó, e o resultado mostra quem respondeu (`answeredBy`).
- **Conversas:** cada nó tem a sua própria `Session` e segue dela na próxima pergunta.
- **Ferramentas do nó:** cada nó tem o seu `Workspace` em modo `plan` e sem `ask`. Assim, nós em paralelo nunca
  perguntam nada à pessoa. Com `"tools": "none"` ou sem pasta, o nó roda sem ferramentas.
- **Medidas de cada nó:**
  - tempo e tempo até o primeiro texto (contado do começo do nó, inclusive os passos de ferramenta);
  - tokens e tokens por segundo (os tokens de saída sobre o tempo depois do primeiro texto);
  - custo, passos e ferramentas (nome, rótulo, ok).

  **Medidas da stack:** o tempo de parede, `nodeMs` (a soma dos nós) e as somas de tokens e de custo.
- **Rastro:**
  - um `prompt` sem marca e `stack` no começo e no fim (`ok`, `interrupted`);
  - os eventos dos nós passam por `trace.tagged({ stack, node })`;
  - cada nó fecha com um evento `node`.
- **Estatísticas:** a pergunta e o desfecho vêm só dos eventos sem marca e do fim da `stack`. As respostas dos nós
  contam para o tempo e os tokens de cada modelo. Uma pergunta com ferramentas conta como respondida uma vez.

## 2b. Papéis (`role`)

- **`answer`** (padrão), **`aggregate`**, **`verify`**, **`choose`** e **`ground`** (seção 2d). Agregar e verificar exigem `from`, e por padrão rodam sem
  ferramentas (`tools` é `none`, a não ser que diga `read`).
- **O que cada nó vê:** as respostas que recebe vêm com letras pela posição no `from`, nunca com o nome do modelo ou
  as medidas. Os textos de cada papel estão em `stack.ts` (`joinPrompt`, `aggregatePrompt`, `verifyPrompt`).
  - **De um CLI, só a mensagem final** (06/11/2026): `NodeResult.text` é tudo o que ele disse (a tela e o rastro);
    `NodeResult.answer` é o que vem depois da última ferramenta (`ChatResponse.final`, skill `kli-fontes`), e o
    `handed(r)` (`answer ?? text`) é o que segue para a junção, o agregador, o juiz, a escolha, a busca do `ground` e o
    `rewriteLastAnswer` do aplicar. O evento `node` do rastro leva `answerChars`. Os modelos do laço do Kli já
    entregavam só o último passo (`Session.send` devolve o texto da última volta).
  - **Quem julga ou escolhe vê as ferramentas** (`Answer.tools`, `judgedBody`): depois da mensagem, `<tools
    used="N">Bash(ls), Read(x.py) (failed)…</tools>`, até 30. Sem isso, o juiz marcou "usou uma ferramenta" como
    faltando em respostas que tinham usado. A junção e o agregador não recebem a lista: escrevem uma resposta.
- **Agregador:** termina com `<contributions>{"A": …}</contributions>`. O `TagCut` segura esse bloco enquanto o texto
  chega, mesmo quando a tag vem partida entre dois pedaços. O `readContributions` normaliza as parcelas para 100 e
  as troca para os nomes dos nós. O exemplo do texto não tem números, porque o modelo tende a copiá-los.
- **Verificador:** responde só JSON (requisitos e marcas por letra). O `readVerdict` aceita palavras ou um bloco de
  código em volta, e conta como faltando o requisito que não tem marca. A aderência é calculada pelo Kli
  (`adherence`: cumprido 1, parcial ½, faltando 0). Se o JSON não vier, há uma nova tentativa no mesmo nó. Se falhar
  duas vezes, o nó falha com "adherence not measured".
- **O juiz não espera o mais lento (`StackRunner.judge`, 06/11/2026):** o `verify` não passa pelo `Promise.all` das
  entradas do `node()`. Assim que `min` responderam, julga as que vieram; depois, em rodadas, cada uma que chega
  (as que terminaram enquanto ele julgava vão juntas). A segunda rodada em diante usa `verifyPrompt(…, more: true)`
  com os requisitos da primeira como lista fixa, e `readVerdict(…, only: true)` ignora requisito novo que o modelo
  liste; os vereditos se somam (`judged` na ordem das rodadas). A conversa do juiz segue entre as rodadas (ele ainda
  tem as respostas anteriores). A `withCheck` roda uma vez, no fim, sobre todas as julgadas. O tempo do nó é a soma
  das rodadas, sem a espera; `NodeResult.rounds` (e no rastro) quando passa de uma; a tela recebe `doing` com
  `judged a · waits for b`. Esc ou falha numa rodada depois da primeira: o nó fica `interrupted` ou `failed` **com**
  o veredito que já tinha, e a `nodeLine` mostra a aderência mesmo assim. **Sem relógio:** a ideia de 02/11 ("julgar
  quando o lento passar de três vezes os outros") caiu com a decisão de 03/11. A agregação, a escolha e a junção
  continuam esperando todas as entradas: o que elas fazem depende de ter todas.
- **Escolha (`choose`):**
  - `by` é uma lista na ordem de tentar: `model`, `person`, `decision` (padrão `["model"]`, e só vale com
    `role: "choose"`);
  - cada um que não escolhe vai para `choice.passed`, com o motivo: "no one to ask here" no `kli -p`, "did not
    choose" no Esc, e "no decision model yet" para `decision`;
  - **`decision` fica pulado até existir um modelo de decisão treinado.** Sem treino, o modelo testado preferia uma
    posição: manteve a escolha ao trocar A e B em 1 de 6 pares (31/10/2026);
  - o modelo responde `{"choice": "B", "why": …}` (`readChoice`), com uma nova tentativa;
  - a pessoa escolhe pelo `StackOptions.ask`. A tela cheia mostra as respostas lado a lado (o evento `asking`) e um
    seletor;
  - a escolhida vira o texto do nó (é a saída da stack) e é emitida inteira como um delta. Os nós de onde veio têm a
    última resposta trocada por ela (`Session.rewriteLastAnswer`), e a conversa segue da escolhida.
- **Juiz e escolha sem as `instructions` da configuração** (`StackRunner.session`): elas são para responder à
  pessoa, e o juiz as tomava por requisitos ("Ser direto e conciso (persona Kli)", teste de 01/11/2026). As
  instruções do próprio nó continuam valendo. O `verifyPrompt` e o `choosePrompt` pedem os textos na língua do pedido.
- **Requisitos fixos (`requirements`, só em `verify`):** o `verifyPrompt` os lista como dados, e o modelo marca esses
  primeiro e põe em `requirements` só os do pedido; o `readVerdict(raw, labels, given)` junta `given` na frente.
- **Verificador como saída:** ele não manda texto para a tela e nunca é uma saída (`stackOutputs` o ignora como
  consumidor). O que ele mede vai no `NodeResult.verdict` e no evento `node` do rastro, junto com as
  `contributions` do agregador.

## 2c. Ramos que gravam (`src/core/copies.ts`)

- **Um nó só grava na pasta (`Here`):** o `StackRunner.copy` devolve um `Here` em vez de uma `Copy` quando
  `writesInFolder(stack)`. Mesma forma (`root`, `path` para o `.patch`, `changes`, `savePatch`, `gitDir`, `remove`
  que não faz nada), então o resto do motor não muda:
  - **medida por resposta:** `mark()` antes de cada resposta tira a árvore da pasta no Git do Kli (`Snapshots`,
    abaixo), e o `changes()` é o `git diff` entre as duas árvores, com `inFolder: true`;
  - **sem setup** (a pasta já é a da pessoa) e a checagem na pasta, se mudou arquivos; a cerca grava no topo do
    repositório (`describe("the folder")`);
  - **nada a aplicar:** o `apply` recusa, a lista de aplicar não mostra o nó e o `kli -p` não diz "nothing was
    applied";
  - **fora de um repositório** a medida é a mesma; uma pasta com mais de `MAX_LOOSE_FILES` (20 mil, sem contar
    `NOT_THE_PROJECT`) não é medida (a pasta de casa);
  - o aviso do nó diz "you work in the person's own folder".
- **A cópia de uma rodada** é a pasta inteira copiada para `<rastro>.copies/<nó>`, ao lado do `.jsonl` da sessão,
  com o `.git`, o `node_modules` e o resto: no macOS por clonagem (`cp -c`, APFS: um repositório de 41.376 arquivos e
  879 MB, em 4,3 s, sem espaço a mais); no Linux por `reflink` onde houver, senão uma cópia de verdade. Nunca
  `git worktree`: ele exige Git, registra a cópia no repositório da pessoa (um `fetch` na cópia mudava as referências
  dela, 02/11/2026) e não leva as dependências. Num repositório, a cópia é do **topo** (`Repo.top`), e o nó trabalha
  na subpasta dentro dela (`Copy.root`). Pasta que é worktree de outro repositório ou submódulo (`.git` é um
  arquivo): `ownRepository` troca o ponteiro por um clone do `git-common-dir`, com o `HEAD` e o `index` do worktree e
  sem `core.worktree`; sem isso, um commit na cópia movia a branch da pessoa. Em toda cópia, o `.git/worktrees` sai.
  Fora do Git, uma pasta acima de `MAX_LOOSE_FILES` não é copiada (o nó falha dizendo por quê); a cópia também
  recusa ir para dentro da pasta que copia (sessões dentro dela).
- **A medida (`Snapshots`, `<rastro>.copies/.snapshots`):** um Git só do Kli, `init --bare` e depois
  `core.bare=false`, `core.checkStat=minimal` e `core.trustCtime=false` (o clone tem inode e ctime novos, e o
  `cp -p` mantém o mtime: nada é relido à toa). `tree(work)`: `GIT_DIR` dele, `GIT_WORK_TREE` a pasta ou a cópia,
  `GIT_INDEX_FILE` numa cópia do índice da pessoa (com `preserveTimestamps`, por causa do racy-git; índice que ele
  não lê, como um split, cai para um índice vazio), `add -A`, `write-tree`. Os objetos da pessoa entram por
  `objects/info/alternates`; a lista de exclusão é a `info/exclude` dela mais `NOT_THE_PROJECT` (arquivo novo de
  `node_modules`, `__pycache__`, `.venv`, `target`, `obj`… nunca é mudança; o `__pycache__` de um `unittest` ia
  para o diff, 06/11/2026). **Nada é gravado no repositório da pessoa** (os testes conferem com
  `git count-objects -v`). A `Copy` tira a árvore do começo logo depois de clonar; o `Here`, a cada resposta. O
  `.snapshots` é da rodada (some com as cópias) ou, no `Here`, da sessão (some no `close()`).
- **Permissão no nó que grava:** `Workspace` em `acceptEdits` onde ele trabalha (a pasta ou a cópia), sem `ask`, com as regras de
  `write.run` (prefixo: `{ words, exact: false }`) e o `alone`, que explica a recusa ("no one is asked in a stack's
  step…"). O CLI roda como agente com `cwd` onde o nó trabalha; o CLI remoto roda isolado.
- **De onde vêm os comandos:** `projectCommands` campo a campo (`.kli/write.json` na pasta ou no topo do repositório,
  o `write` da stack, `detectCommands`); o `run` soma os três. Sem nada, o nó grava sem checagem, e a tela diz
  isso. Não há setup: a cópia leva as dependências da pasta; o `setup` saiu da detecção e do `ProjectCommands`, e um
  antigo na configuração passa na validação e é ignorado (o builder não mostra mais o campo). A ferramenta que falta
  (`Bun.which`) faz a detecção não rodar nada e dizer por quê. A busca por arquivos de teste nunca entra em
  `node_modules` nem em pastas ocultas, e para em 20 mil entradas.
- **Detecção (`detectIn`):** a raiz primeiro; sem nada nela, cada pasta logo abaixo (não oculta, fora de
  `node_modules`/`vendor`/`dist`…) soma o seu projeto: o check com `cd <pasta> && …` (vários entre parênteses,
  ligados por `&&`), e o `run` com os comandos da ferramenta sem pasta (o nó roda `cd frontend && npm test`, e
  `cd <pasta>` só lê). O .NET: a solução (`.sln`/`.slnx`), senão o projeto, com o nome quando há mais de um; `dotnet
  test` só com um `*test*.csproj`, senão `dotnet build`.
- **Python sem lockfile (`PY_TESTS`):** `test_*.py` vira `python3 -m unittest discover -s <pasta>` **do topo**,
  sem `cd` (de dentro da pasta, um `csv.py` dela toma o lugar da biblioteca: o RAGnaRock avisa isso no teste), até
  quatro pastas; `pytest` só com `conftest.py`/`pytest.ini`/`pyproject.toml` e o `pytest` instalado. Na raiz,
  testes soltos só valem com um `PY_MARKERS` (senão os testes de uma subpasta escondiam as crates ao lado); sem
  projeto nenhum, valem.
- **Tempo do nó:** não conta a cópia nem a `check`. O evento `doing` mostra cada uma enquanto acontece.
- **O que segue adiante:** quem recebe um nó que grava recebe `withChanges` (a mensagem final, `<changes>` com o diff
  cortado no meio a 30 mil caracteres, e `<check>`), e `changesNote` explica isso no prompt. A escolha devolve a
  mensagem final pura, sem o diff.
- **Sem limite num nó:** o `Session.send` não tem `limits`, e o nó não tem `NODE_MS` nem `NODE_STEPS`: ele roda até o
  modelo responder ou até o Esc. Antes (até 03/11/2026) eram 15 minutos ou 150 passos, e o Antigravity foi cortado
  com onze arquivos mudados numa fatia que o Opus terminou em 13 minutos.
- **O ritmo (`pace`):** o aviso do nó que grava termina com a régua, igual para todos: nada corta o nó, mas a pessoa
  espera; buscar antes de ler, não reler, pedir juntas as leituras e edições independentes, editar cedo, só o que foi
  pedido, checar uma vez. Sem tempo nem "mire em um terço". Um CLI só recebe o prompt no começo: o que o Kli quer dele
  tem de ir ali.
- **Checagem só com mudança:** o nó roda a `check` só se `changes.files.length`. O juiz que julga um nó que mudou e
  outro que não mudou roda a `check` uma vez, na cópia de um dos que não mudaram ("checking the folder as it was"),
  e dá esse resultado a eles.
- **A checagem no veredito:** `withCheck` acrescenta o requisito, marcado pelo Kli, só quando todas as respostas
  julgadas têm resultado (próprio ou o da pasta).
- **Nó que falha guarda o que mudou:** no `catch` do nó, o que ele mudou é medido e o `.patch` salvo. A lista de aplicar
  (`offerChanges`) mostra esses nós no fim, e o `changesRows` também. A checagem roda no que ele deixou ("checking
  what it left"), menos depois do Esc. **O juiz julga esse trabalho inacabado** (`judgeable`: `ok`, ou `failed` com
  arquivos mudados; conta para o `min`): a resposta vai com `unfinished="its step failed: …"` e o `unfinishedNote`,
  e a tela diz `failed, unfinished` com a aderência. O nó parado pelo Esc não é julgado (o Esc para o juiz):
  `interrupted, not judged`. Agregar e escolher continuam só com quem respondeu. Na lista de aplicar, a aderência
  vem antes do tamanho (o fim da linha é o que se corta).
- **Tamanhos lado a lado** (`sizesLines`, `Answer.size`): com duas ou mais respostas que gravam, o `verifyPrompt` e o
  `choosePrompt` listam o tamanho de cada mudança por letra (arquivos, linhas, total) e a regra "a menor que faz o
  pedido cumpre". Numa rodada seguinte do juiz, o `sized` leva todas as respostas já vistas (`seen`), não só as
  novas. O juiz ainda é quem marca: o Kli não transforma o tamanho num requisito.
- **Esc no meio da rodada:** o `send` rejeita com o resultado parcial (`AbortError` com `result`), e o `showStack` da
  tela cheia chama `offerChanges` com ele: os nós que terminaram vêm primeiro, os parados no fim. Sem resultado,
  ou num erro, `discard()`.
- **Rodada:** as `copies` do `StackRunner` valem de uma pergunta até a rodada acabar. Ela acaba em:
  - `apply(nó)`: para os comandos que ficaram rodando nas cópias, e o `Copy.apply` confere que a pessoa não mexeu
    nos arquivos da escolhida (árvore da pasta agora contra a árvore do começo da cópia, `Snapshots.changed`); se
    mexeu, diz quais, não aplica nada e a rodada acaba do mesmo jeito (`discard`). Senão, copia arquivo a arquivo
    (apagados primeiro, com as pastas que ficaram vazias; link simbólico como link; modo preservado; um submódulo é
    pulado), sem índice nem commit. Depois apaga **todas** as cópias e o `.snapshots`, e os nós que gravam trocam a
    última resposta pela do nó aplicado;
  - `discard()`: Esc ou "none" no seletor, nada a aplicar, um erro, ou a pergunta seguinte (o `send` chama antes de
    tudo). Apaga tudo e, se algum nó mudou arquivos (`changed`), cada nó que grava recebe `NOTHING_APPLIED` como
    nota na próxima pergunta;
  - `close()` (o `/new`, a saída, o fim do `kli -p` e do teste do builder).

  Os `.patch` sempre ficam. A remoção é `fs.promises.rm` (não trava a tela). No `Here` não há rodada: `discard`
  não faz nada.
- **A cerca (`src/core/fence.ts`):** `write.run` sozinho não cerca, porque um comando liberado que roda código do
  projeto roda o que o nó escrever (o Gemini rodou o `bun install` recusado por um preload do `bun test`, 01/11/2026).
  Então os comandos do `Workspace` do nó (`Workspace.fence` → `Job`) e a checagem (`runIn(..., fence)`) rodam no
  `sandbox-exec` (macOS) ou no `bwrap` (Linux):
  - grava só onde o nó trabalha (a cópia, ou o topo do repositório da pasta), nas temporárias e nos caches
    (`CACHES`, `CACHE_FILES`); não lê `HIDDEN`; sem rede, menos a da máquina;
  - **regras de rede testadas:** `(allow network* (local ip "localhost:*"))` deixa a internet passar numa conexão de
    saída; o certo é `network-bind`/`network-inbound` com `local` e `network-outbound` com `remote`. O .NET conecta
    em `::ffff:127.0.0.1`, que o `localhost` da caixa não cobre: por isso `DOTNET_SYSTEM_NET_DISABLEIPV6=1`;
  - o macOS não aceita caixa dentro de caixa: dentro da cerca vai `KLI_FENCE=1`, e o Kli de dentro não cerca;
  - o CLI usa as permissões dele e não entra;
  - `fence` em `.kli/write.json` ou no `write` da stack: `false`, `network`, `write`. A tela diz a cerca ou por que
    não houve (`project.fence` / `project.unfenced`);
  - não prometa um cofre: um cache ainda pode ser gravado.
- **Recusas:** `ToolResult.denied` (pedia permissão e não havia a quem pedir) vira `refused` na ferramenta do nó, na
  `nodeLine` (`(2 failed, 1 refused)`) e no evento `node` do rastro.
- **Cópias que ficaram:** `claimCopies` grava `.owner` (o pid) na pasta das cópias da sessão; antes da primeira cópia,
  `removeLeftovers` apaga do disco as de sessões com o processo morto, o `.snapshots` também (as `git worktree` de
  versões antigas saem também do repositório, pelo `gitdir:` do `.git` da cópia). Sem `.owner`, só se o rastro tiver mais de um dia. Os
  `.patch` ficam.
- **Aplicar no rastro:** o `apply` grava o evento `apply` (com as marcas do nó): arquivos, linhas e o diff.
- **O `stack.ts` vai para a página do builder:** não pode importar nada de Node (`shell.ts`, `jobs.ts`). Por isso a
  validação de `write.run` é uma regex de palavras, e o `parseCommand` só roda no motor.

## 2d. Balizamento (`role: "ground"`, `src/core/ground.ts` e `src/core/sources/`)

- **Sem modelo:** o nó só busca. `model` é proibido nele (`groundProblems`), e o `StackNode.model` é opcional por
  isso: na tela e no `NodeResult.model` vai o `nodeModel` ("grounding · docs"). O `stackModelProblems` e o `/stack`
  conferem as fontes que ele cita em vez de um modelo.
- **Fontes de dados** (`sources` na configuração, `sourceProblems`): cada tipo é um arquivo em `src/core/sources/`
  com a mesma forma (`Source.search(query, top)` → `Excerpt`: título, `ref`, link, texto, `score` para ordenar,
  `relevance` 0–1 para mostrar, data). A `files` recorta (`textPieces`, `csvPieces`, `jsonPieces`) e ordena por BM25
  (`rank`, `words` sem acento e sem palavras vazias); guarda o recorte por arquivo até o `mtime` mudar. Um trecho
  quebra no título, numa linha em branco depois de ~1200 caracteres, ou em qualquer linha depois do dobro.
- **O caminho é sempre o mesmo (`ground`):** busca em cada fonte em paralelo → os anexos (`attach`) inteiros primeiro
  → os trechos por `relevance` e `score` enquanto cabem no `budget` (tokens ≈ caracteres/4) → `mask`. Toda fonte com
  erro faz o nó falhar; uma só, não.
- **Transparente (`StackRunner.through`):** quem recebe de um `ground` recebe as respostas que chegaram a ele, e as
  letras seguem a posição no `from` através dele (`places`), como sem ele. Os `Grounding` do caminho somam, sem
  repetir, e o `contextLines` numera tudo de um a um; o modo mais estrito vence. O verificador e a escolha recebem o
  contexto com outra frase (julgar se concorda), não as `<rules>`.
- **Saídas:** um `ground` nunca é saída, e quem só é recebido por um `ground` que alimenta um juiz continua saída
  (`stackOutputs` olha através do `ground`). Um `ground` sem ninguém que receba dele é problema de forma.
- **Rastro:** o evento `ground` (com as marcas do nó): fontes (tempo, achados, mantidos, erro), trechos (fonte,
  `ref`, nota), tokens, cortados; a consulta vai em `content`, que some com `sessions.content: false`.
- **Builder:** `addGround`, `cleanNode` tira do `ground` o que é de modelo e os padrões (`enrich`, `request`), e tira
  dos outros nós os campos de `ground`. O servidor tem `PUT/DELETE /api/sources/:name` (o `putSource` renomeia nos
  nós; o `removeSource` recusa a fonte em uso) e `POST /api/source-test`.
- **A página entra na checagem de tipos:** o `tsconfig` da página herdava o `exclude` da raiz e não conferia o
  `main.tsx`. Agora confere (com `css.d.ts` para o import do CSS do React Flow).

## 2e. Triagem (`triage` e `purpose`, `src/core/triage.ts`)

- **A pergunta é relativa à stack, nunca "é simples?".** A stack declara `purpose` (o trabalho para o qual existe), e
  a triagem pergunta se a mensagem pede esse trabalho: numa stack de personagens, "quem é brás cubas" é o trabalho
  dela. Sem `purpose`, ou sem `triage.model` na configuração, a stack recebe tudo (`StackRunner.triages`).
- **Duas rotas, `one` e `stack`.** Separar "ferramenta" de "pergunta" não é da triagem: quem responde sozinho (o
  `model`, com o `Workspace` e a permissão da tela, na pasta da pessoa) decide se usa ferramenta, como o Claude Code.
  Com três rotas, os modelos pequenos chamaram "implemente a fatia 2" de ação curta.
- **Na dúvida, a stack.** Falha do modelo, ou resposta sem a palavra (`readTriage`): `route: "stack"` com `error`, e
  a tela diz por quê. Só o Esc lança (`signal.throwIfAborted()` também depois da resposta). Sem reserva (outro
  modelo decidiria diferente), temperatura 0 (`ChatOptions.temperature`), sem ferramentas; um CLI roda isolado.
- **O modelo é lido a cada mensagem** (`options.triage` é uma função): trocar com `/triage` não recomeça a stack nem
  apaga a conversa dos nós.
- **Uma conversa só.** O que o modelo respondeu fora da stack vai para os nós com `StackRunner.note` (`heardNote`):
  às sessões que existem, e às que nascerem depois (`heard`). A tela guarda o que a stack respondeu (`missed`, as
  últimas cinco) e entrega ao `session` do modelo com `Session.note` antes da próxima mensagem dele.
- **Forçar a stack:** `/stack again` roda na stack inteira a última mensagem que a triagem deu ao modelo; no
  `kli -p`, `--stack <nome>` pula a triagem (só a stack da configuração passa por ela).
- **Rastro e estatísticas:** o evento `triage` (marca `stack`; `model`, `route`, `ms`, `why`, `error`, e a mensagem em
  `content`). O pedido e a resposta do modelo de triagem levam `{ stack, node: "triage" }`: contam para o modelo nas
  estatísticas, não como pergunta.
- **O texto (`triageMessages`) foi medido; não mude sem medir de novo** (03/11/2026, com 78 mensagens rotuladas em
  três conjuntos: A, B e P). Em inglês, porque é texto do programa. É feito de regras sobre o que é o trabalho da stack,
  exemplos para outra finalidade ("marketing copy"), seis turnos de exemplo (o de `stack` pede, com a primeira oração
  do `purpose`, o trabalho dela) e a última troca, com o fim da resposta, onde costuma estar o que foi proposto.
  - Pelo próprio Kli: qwen2.5-7b 74/78 em 0,3 s (61 com um sim/não simples); Gemini 3.5 Flash Lite
    75 em 1 s; lfm3 62 (12 de 28 trabalhos de stack para um modelo só); Haiku pelo Claude Code 71, e em duas tentou
    usar ferramenta em vez de responder (o CLI isolado ainda é o Claude Code).
  - Os turnos de exemplo foram o que mais ajudou o lfm3; as regras, o qwen.
  - **Vale a primeira palavra, e a resposta é cortada em 32 tokens** (`ChatRequest.maxTokens`): sem corte, o lfm3
    respondia "one" e seguia "pensando" até 2.000 tokens (52 s), e a última palavra já era outra.
  - Um modelo de decisão sem treino decide pela posição das opções e diz "stack" a quase tudo (0,99 para "ok para push").
- **Aquecer (`warmTriage`):** o Alexandre viu o Aron falhar nas primeiras chamadas depois de parado (03/11; não
  reproduzido, e as falhas nos rastros eram do túnel). A tela cheia chama o modelo de triagem em segundo plano ao
  abrir, ao trocar de stack e ao trocar o modelo (6,6 s → 1,7 s na primeira mensagem). Essa chamada fica **fora do
  rastro**: com ela lá, cada Kli que abre deixaria uma sessão vazia. A triagem que falha cai para a stack e diz por
  quê.

## 3. Na tela

- **`kli -p`:** cada nó aparece no stderr quando termina (`nodeLine`). As respostas vão para o stdout:
  - **uma saída:** chega enquanto é escrita;
  - **várias:** saem uma embaixo da outra, com `── nó · modelo ──`.

  O rodapé é o `stackFooter`, e o `--json` traz os nós e as saídas.
- **Tela cheia:** o desenho é feito por `src/cli/stack-view.ts` (`stackView`, `applyStackEvent`, `stackRows`,
  `comparisonRows`), que são funções puras e testadas em `test/stack-view.test.ts`.
  - **A árvore:** esperando (`waits for a, b`), com o modelo, numa ferramenta, respondendo, e no fim a `nodeLine`.
    **O motivo de `failed` e `skipped` vem inteiro embaixo do nó** (`reasonRows`, `nodeLine(r, color, false)` na
    linha), quebrado com `wrap` em vez de cortado pelo `clip`: no fim da linha, a tela cortava "agy ends the run th…"
    (12/11/2026). Sem nenhuma resposta, o rodapé diz `no answer came · <nó>: <motivo>`.
    Rodando, o nó mostra a contagem de ferramentas e a última (`31 tools · last Edit(x)`), não "waiting for the
    model" depois de cada uma: o `agy` avisa começo e fim juntos, e o Gemini parecia parado (03/11/2026).
  - **Os sinais de risco** (`signals`, 06/11/2026, item 3 da fila de 02/11): antes da última ferramenta, `read N
    lines` (soma dos `Read` que deram certo: o número do `summary`, "Read 50 lines of 4006" ou o "17 lines" de um CLI,
    senão as linhas do `output`), `no edit yet`/`first edit at` (só `role: answer` com `tools: "write"`; `EDITS` =
    Edit, Write, MultiEdit, NotebookEdit, pelo nome do `call`, que já vem nas palavras do Claude Code) e `quiet for`
    em amarelo (só `answer`, nenhuma ferramenta rodando, nenhum `around`, e `QUIET_MS` = 60 s desde o último passo:
    início, ferramenta ou texto). `around` é o Kli trabalhando em volta do modelo (o `doing` da cópia e da checagem);
    o motor manda `doing` = `WAITING` quando a cópia fica pronta, e aí o tempo do modelo volta a contar. Só na tela:
    não vai ao modelo, ao rastro nem corta nada (a regra de 03/11 continua: nenhum relógio no nó).
  - **A árvore nunca sai da tela:** o `frame` corta pelo topo o que não cabe, e o topo é a árvore. Por isso a tela
    passa a sua altura (`room`) ao `stackRows`, e enquanto a stack roda cada resposta mostra só o próprio fim
    (`tail`, com `↑ N lines above`); ao terminar, sem `room`, a stack vai inteira para o histórico.
  - **Uma saída** aparece como a resposta de um modelo.
  - **Várias saídas** ficam lado a lado se cada coluna tiver pelo menos 28 colunas; senão, uma embaixo da outra.
  - **As respostas do caminho** (`steps`, 08/11/2026; o Alexandre: "quando os modelos respondem não aparece na tela o
    que cada modelo enviou"): os nós fora de `view.outputs` com papel `answer` ou `aggregate` que já começaram (nem
    `waiting`, nem `skipped`) vêm lado a lado acima das saídas, pelo `answerColumns`. Com um nó `asking`, eles somem,
    porque o seletor já mostra os textos. Uma saída única sob eles ganha título (`answerColumns` com um item só cai no
    modo empilhado, `── nó · modelo ──`), e sem eles fica como antes. Uma saída única esperando ou rodando sem texto não
    ocupa linha. Com as duas faixas à vista e um `room`, os `steps` ficam com `STEPS_SHARE` (um terço) do corpo, entre
    o mínimo deles e o que sobra depois do mínimo da saída (`fewestRows`: lado a lado, título e `MIN_BODY` linhas;
    empilhado, cada um com o seu título e `MIN_BODY` linhas, mais as linhas em branco). Sem `room`, tudo inteiro.
  - **O texto de cada nó vem com o markdown desenhado** (10/11/2026), pelo `markdown` (`src/cli/markdown.ts`), na
    largura da coluna: uma tabela que não cabe nela vira um registro por linha. O `tail` conta as linhas já
    desenhadas.
  - **A tabela de comparação** entra quando a stack termina.
  - **Resposta cortada** (Esc ou falha) mantém o texto que já chegou, com a marca embaixo.
  - **Veredito:** o `verdictRows` põe os requisitos nas linhas e as respostas julgadas nas colunas (✓ ~ ✕). Embaixo
    vêm a aderência, quanto a saída ficou acima ou abaixo do melhor dos outros, e as notas. A linha "adherence"
    entra na tabela de comparação. No `kli -p`, o veredito vai para o stderr.
- **`/stack`:**
  - **Seletor:** lista as stacks com nós, respostas, descrição e problema (o modelo de um nó que não existe), mais a
    opção `none`.
  - **A escolha** fica gravada por `core.setStack`. `/stack <nome>` e `/stack off` trocam direto.
  - **`-m` ao abrir a tela cheia** faz o modelo responder.
  - **`/model` com uma stack ligada** avisa que a stack continua respondendo.
- **Rastro único:** a sessão e a stack usam o mesmo rastro (`core.trace()`). O `/stats` e o `/new` valem para as
  duas, e o `/new` também recomeça as conversas dos nós.
- **Nós só de leitura são avisados:** "In this step your tools only read…". Modelos pequenos tomam "escreva um texto"
  por "grave um arquivo" (31/10/2026).
- **Tokens por segundo:** só o texto (`outputTokens − thinkingTokens`), de um nó que respondeu num passo, sem
  ferramenta nenhuma (nem as que um CLI conta) e escrevendo por pelo menos 300 ms. Fora disso, a medida mentiria:
  apareceram 971 tok/s no Gemini (raciocínio contado), 281 no Claude Code (passos dele) e 14.875 no OpenCode (texto
  de uma vez só).
- **CLIs num nó:** para ler, rodam em modo plan; para gravar, como agentes na cópia (testados em 01/11/2026: Claude
  Code, OpenCode, Kimi e Antigravity). Em 01/11 o Antigravity em modo plan terminava sem texto; em 06/11, num nó que
  lê, ele respondeu nas quatro rodadas de teste. Resposta vazia aparece como "(it answered with no text)".

## 3b. A página do `/stackbuilder` (`src/cli/stackbuilder/`)

- **A configuração é a verdade.** A página desenha e edita o que está nela e grava pelo núcleo (`core.saveStack`,
  `core.deleteStack`, `core.setStack`, que passam pela validação e deixam o `.bak`). Nada da forma do grafo mora só
  na página. As posições dos nós são a exceção: ficam no `localStorage` do navegador, porque a configuração não guarda
  desenho.
- **Edições puras em `graph.ts`:** `connect` (recusa ligar um nó a ele mesmo e fechar círculo, com o motivo),
  `disconnect`, `removeNode`, `renameNode` (as entradas dos outros seguem), `addNode`, `updateNode` e `cleanStack`.
  O que se salva sai limpo: sem o papel padrão, sem listas vazias, sem `by` fora de `choose`, sem `min` acima das
  entradas. Na página, uma edição que lança erro é calculada **antes** de mexer no estado do React (erro dentro do
  atualizador quebraria a página).
- **Problemas:** a forma é conferida na página com o mesmo `stackProblems` do núcleo; os modelos, pelo servidor
  (`core.stackModelProblems`). Com problema, nem salva nem testa.
- **Testar:** roda a stack **como está na tela**, salva ou não (`core.draftStack`), num `StackRunner` novo a cada
  teste, e manda os eventos em NDJSON, com um `tick` a cada 5 s para a conexão não cair. A escolha pela pessoa sai
  como `choose` e volta por `POST /api/choose` com o id da execução. O teste deixa rastro com `surface: "builder"`.
- **Segurança:** só `127.0.0.1`, porta livre, token aleatório no endereço exigido em toda chamada da API
  (`x-kli-token`) e `Host` conferido (um site rebatizado para 127.0.0.1 não passa).
- **A sessão acompanha:** `onChange` avisa a tela cheia do que a página salvou, renomeou, apagou ou escolheu; a stack
  que responde segue o nome novo, e o `StackRunner` dela recomeça. O servidor para quando a sessão termina.
- **Texto da página em inglês**, como o resto do Kli.

## 4. Testes

- **Automáticos:** `test/stack.test.ts` usa modelos falsos pelo nome (`slow-`, `fail-`, `tool-ls`,
  `tool-touch`). Toda regra nova entra com um teste ali. Os ramos que gravam ficam em `test/stack-write.test.ts`, com
  repositórios git de rascunho e os modelos falsos `write-X` (grava X no `out.txt`), `writehang-X` (grava e só
  responde no Esc), `bash-…` e `judge-w`; `copiesOf(trace)` lista as cópias da sessão e `objects(repo)` confere que
  nada foi gravado no repositório da pessoa. O juiz julga na ordem em que as respostas chegam: compare vereditos
  sem depender da ordem.
- **Com modelos de verdade:** numa cópia da configuração, com `sessions.dir` no rascunho (skill `kli-entrega`). As
  stacks de exemplo são a `compare` e a `review` do `kli.example.json`, e as que o `kli init` grava
  (`src/core/starter.ts`, `test/starter.test.ts`).
- **A página:** `test/stackbuilder.test.ts` cobre o `graph.ts`, o `putStack`/`removeStack` e a API (token, estado,
  conferir, salvar, renomear, apagar, ligar, testar em NDJSON e a escolha da pessoa) com modelos falsos (`Core` aceita
  uma fábrica de provedores). Na tela, use o Chrome sem janela **pelo protocolo de depuração** (WebSocket do
  `--remote-debugging-port`): abrir, clicar, digitar (o valor dos campos do React muda pelo setter nativo mais o evento
  `input`/`change`), rodar um teste de verdade e fotografar; o celular com `Emulation.setDeviceMetricsOverride` 390 px
  (confira `scrollWidth`). Para o `kli stackbuilder` não abrir o navegador de verdade, ponha um `open` falso no PATH.
