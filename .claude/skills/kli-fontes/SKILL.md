---
name: kli-fontes
description: As regras das fontes de inferência do Kli, em três níveis (local, provedor, modelo), mais configuração, descoberta, SSH e túneis, chaves, reserva e protocolos (openai, vertex, anthropic, harness). Use antes de mexer em config.ts, locations.ts, discover.ts, tunnels.ts, secrets.ts, router.ts, nos provedores ou no /model, e ao incluir um tipo de local ou um protocolo novo.
---

# Kli · Fontes: locais, provedores e modelos

## 1. Três níveis, um nome

- **O nome do modelo:** os três níveis separados por barra, `local/provedor/modelo`. Exemplos: `mac/ollama/lfm3`,
  `gpubox/claude/haiku`, `vertex/deepseek-ai/deepseek-v4.1-flash-maas`.
- **Numa API:** o provedor é quem fez o modelo e faz parte do id (`anthropic/claude-sonnet-5-5`).
- **Nome incompleto:** o que fica de fora vem do padrão; `mac/agy`, por exemplo, é o Antigravity no modelo dele.
- **Onde o nome vale:** em `/model <nome>`, em `kli -m <nome>`, no `model` e no `fallback` da configuração.
- **Escolher no `/model`** torna o modelo o padrão: ele vai para o `model` da configuração, e o arquivo anterior fica
  em `.bak`. Para usar outro modelo uma vez só: `kli -m`.
- **Configuração antiga** (perfis, `providers`, `destinations`) é recusada com uma mensagem. Os perfis saíram em
  30/10/2026 e não voltam.

## 2. Tipos de local

| Tipo | Campos | Provedores |
|---|---|---|
| `machine` | sem `host`/`ssh` é esta máquina; `ssh` ou `host`, `jump` (`ssh -J`), `sshOptions` | `server` {`port`, `tunnel?`, `model?`, `extra?`} ou `cli` {`command`, `args?`, `model?`} |
| `google` | `project`, `region?` (`global` por padrão), `apiKeyEnv?` (sem chave, vale o login do `gcloud`) | quem fez o modelo (`google`, `deepseek-ai`...) |
| `anthropic` | `apiKeyEnv?` | `anthropic` |
| `api` | `url`, `apiKeyEnv?` (qualquer serviço compatível com OpenAI) | quem fez o modelo |

Por baixo, há quatro protocolos:
- **`openai`:** os servidores locais e as APIs compatíveis.
- **`vertex`:** Gemini nativo (`streamGenerateContent`) para `google/*`, e o endpoint compatível com OpenAI para os
  outros.
- **`anthropic`:** a Messages API.
- **`harness`:** os CLIs (skill `kli-ferramentas`).

## 3. Descoberta (o **f** e o incluir máquina)

- **O que procura:** as portas 11434 (Ollama), 8080 (llama.cpp), 1234 (LM Studio) e 8000 (vLLM), e os CLIs de
  `CLI_PRESETS`.
- **Numa máquina remota:** uma conexão SSH só, com `bash -lc`. O script termina com `true`, para que uma porta
  fechada no fim não pareça falha do ssh.
- **Servidor visto só no localhost de lá:** entra com `tunnel: true`.
- **O que o `OpenAIProvider` conserta de um servidor local** (`providers/openai.ts`, 23/11/2026):
  - **chamada escrita como texto** (`callsInText`): a resposta inteira `{"name", "arguments"}`, cada chamada entre
    `<tool_call>`, ou cada uma num bloco ``` quando todo bloco da resposta é chamada, com o nome de uma ferramenta
    oferecida, vira chamada; qualquer outro texto é resposta;
  - **a janela cheia** (`fullNotice`): uma resposta de 2048 tokens ou mais num servidor sem chave pergunta uma vez ao
    `/api/ps` do Ollama a janela carregada, e avisa uma vez quando a conversa chegou a ela (o Ollama corta o começo
    sem dizer). O Kli não muda a janela: o `/v1` do Ollama ignora `num_ctx`, e o servidor é da pessoa.

## 4. SSH e túneis

- **O comando** (`sshCommand`): `BatchMode=yes` (só chave, nunca senha nem pergunta), `ConnectTimeout=10`, `-J`
  quando há `jump`, e por último as `sshOptions`.
- **Máquina nova:** como o ssh do Kli nunca pergunta, a primeira conexão é feita à mão, uma vez, para conferir e
  aceitar a chave da máquina (`!ssh -J gpubox usuário@host true`). O `sshWhy` transforma "Host key verification failed"
  nessa instrução. Quando a chave mudou, ele sugere o `ssh-keygen -R` e avisa do risco.
- **O código do Kli nunca escreve em `~/.ssh`.**
- **Túnel:** `ssh -N -L 127.0.0.1:<livre>:127.0.0.1:<porta>` com `ExitOnForwardFailure` e
  `ServerAliveInterval=15`/`ServerAliveCountMax=3`. Há um túnel por máquina e porta, aberto quando é preciso e
  fechado na saída do Kli. Uma falha é tentada de novo na próxima vez.
- **Túnel que caiu:** quando o `ssh` de um túnel termina (o Mac dormiu, a rede caiu), ele sai da lista e o próximo uso
  abre outro, numa porta nova. Por isso o `Router.connect` monta a conexão a cada uso e refaz o provedor quando a URL
  mudou: guardar o provedor com a porta velha fazia o Kli bater numa porta morta ("cannot connect to
  http://127.0.0.1:…") até ser reaberto (01/11/2026).
- **CLI remoto:** roda por `ssh … bash -lc` em `~/.kli/harness`, isolado. A pasta da pessoa não existe lá.

## 5. Chaves

- **Onde ficam:** em `~/.kli/.env` (ou `$KLI_ENV`), com permissão só do dono. A configuração guarda só o nome da
  variável (`apiKeyEnv`).
- **Precedência:** uma variável de ambiente já definida vale mais que o arquivo.
- **Fora do `process.env`:** as chaves do arquivo nunca entram nele, então não chegam aos CLIs que o Kli roda (o
  Claude Code trocaria o login da pessoa pela API paga).
- **Na tela** a chave aparece como `••••1234`. Nunca aparece no rastro, numa mensagem de erro ou num teste.
- **Google:** também aceita o login do `gcloud`, sem chave.

## 6. Reserva (fallback)

- **Como funciona:** o `fallback` é uma lista, tentada em ordem quando o modelo falha **antes** de entregar texto.
  Depois que o texto começou, a falha é do turno.
- **Onde aparece:** cada falha vai para o rodapé e para o rastro (`failure` e `fallback`). A falha mostra o motivo
  real, não um "erro" genérico.

## 7. Protocolo novo ou mudança num provedor

- **Sem SDK:** HTTP direto, com `fetch`; o streaming passa pelo `providers/sse.ts`.
- **Ferramentas:** são traduzidas no núcleo:
  - `tool_calls` (os pedaços são juntados por `index`);
  - `tool_use`/`tool_result` agrupados;
  - `functionCall`, que devolve a `thoughtSignature` pela `Message.raw`.

  Um servidor que recusa ferramentas (400 com tool ou jinja) recebe o pedido de novo sem elas, e o Kli avisa.
- **`instructions` de um servidor:** vai no fim da mensagem de sistema (ou vira uma) só para os modelos daquele
  servidor (`openaiMessages`). Use quando o modelo só aceita algo ali. Exemplo: o Nemotron no exo só desliga o
  raciocínio com `/no_think`, e o exo ignora `chat_template_kwargs.enable_thinking` e `reasoning_effort`.
- **Cluster exo:** o `/v1/models` dele traz o catálogo inteiro (uns 120 modelos), sem dizer o que está carregado.
  Quando os itens vêm com `owned_by: "exo"`, o Kli lê o `/state` e lista só os carregados, uma linha por modelo, com
  as máquinas (`exoLoaded`). Sem o `/state`, mostra o catálogo como veio.
- **Sem tempo-limite na resposta** (03/11/2026, decisão do Alexandre): nenhum pedido de chat tem `AbortSignal.timeout`
  nem `timeoutMs`, num servidor, numa API ou num CLI. Só o `signal` do Esc para. Tempo-limite só no que não é a
  resposta de um modelo: descoberta (`discover.ts`), listas de modelos (`getJson`, `models.ts`) e o `kli check`.
  O campo `timeoutMs` saiu dos tipos; numa configuração antiga ele fica e é ignorado.
- **Uma chamada só pode cortar a resposta** (`ChatRequest.maxTokens`, 03/11/2026): `max_tokens` no OpenAI e na
  Anthropic, `maxOutputTokens` no Gemini, acima do `maxTokens` do local. Serve à triagem, que lê uma palavra. Um CLI
  não tem esse corte.
- **A mensagem final de um CLI (`ChatResponse.final`, 06/11/2026):** o `HarnessProvider` guarda onde o texto estava a
  cada ferramenta do CLI (`cuts`) e o `lastMessage` devolve o que veio depois da última (ou o trecho de antes, se ele
  terminou numa ferramenta); sem ferramenta, ou quando isso é o texto todo, fica `undefined`. Não use o campo final
  de cada CLI: o `result` do Claude Code é a última mensagem, mas o `response` do Antigravity é o texto inteiro, e o
  Kimi e o OpenCode não têm nenhum (medido nos quatro, com um pedido que obriga a narrar, usar ferramenta e
  responder). O `text` continua sendo tudo, para a tela. Quem usa o `final` é a stack (skill `kli-stacks`).
- **Lista de modelos:** vem do próprio provedor (`/v1/models`; `agy models`; `opencode models`; os apelidos do
  Claude Code).
- **Teste com servidor falso** (`Bun.serve`) em `test/<nome>.test.ts`. Depois, teste com o provedor real por uma
  cópia da configuração (skill `kli-entrega`).
- **Coisas já descobertas:**
  - no Vertex, os modelos de parceiros só aparecem no host regional (`us-central1`), e só os `-maas` respondem;
  - o `opencode models` às vezes volta vazio quando roda em paralelo: tente uma vez de novo;
  - o Kimi com `-p` não aceita `--plan`, `--auto` nem `--yolo`.
