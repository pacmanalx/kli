---
name: kli-stack
description: A stack do Kli, travada (TypeScript no Bun, sem dependência de execução, HTTP direto, laço e tela próprios). Use antes de adicionar dependência, SDK, framework, linguagem ou pacote, de mudar versão, de criar arquivo ou pasta nova, ou de escolher "como fazer" algo que a stack já decide.
---

# Kli · Stack travada

Vale para todos, pessoas e agentes de IA. A stack existe para que o que se aprende no Kli valha fora dele: cada
provedor por HTTP direto, o laço do agente escrito à mão. Mudar a stack é decisão do Alexandre.

## 1. O que a stack é

| Camada | Travado em | Onde está |
|---|---|---|
| Linguagem | TypeScript estrito (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), imports com `.ts` | `tsconfig.json` |
| Runtime e ferramentas | **Bun**: runtime, `bun test` e `bun build --compile`; o `tsc` só confere os tipos | `package.json` |
| Dependências | só as três da página do `/stackbuilder` (`react`, `react-dom`, `@xyflow/react`), empacotadas no binário; o resto do Kli não usa nenhuma; desenvolvimento: `@types/bun`, `@types/react`, `@types/react-dom` e `typescript` | `package.json` |
| Provedores | HTTP direto com `fetch` e o leitor de SSE próprio, **sem SDK** | `src/core/providers/` |
| Laço do agente | próprio (`Session.send`, sem teto de passos nem de tempo: só o Esc para), **sem framework de agente** | `src/core/session.ts` |
| Tela | renderizador próprio, **na tela normal do terminal** (sem a tela alternativa), como o Claude Code: o que terminou vai uma vez para o histórico de rolagem do terminal, e só a parte viva de baixo é redesenhada; **sem Ink, OpenTUI ou blessed** | `src/cli/tui.ts` |
| Login do Google | ADC por HTTP direto (o refresh token do `gcloud` ou o JWT de uma conta de serviço) | `src/core/providers/google-auth.ts` |
| Comandos | `Bun.spawn`; o Bash do modelo roda em `bash -c`, num grupo de processos próprio | `src/core/jobs.ts` |
| Rastro | JSONL por sessão | `src/core/trace.ts` |
| Configuração | JSON em `$KLI_CONFIG`, `./kli.json` ou `~/.kli/config.json`; as chaves em `~/.kli/.env` | `src/core/config.ts`, `src/core/secrets.ts` |
| Entrega | um binário só, o `dist/kli`; no release, um por sistema (macOS e Linux, arm64 e x64) | `bun run build`, `bun run release` |
| Página do `/stackbuilder` | **React** e **React Flow** (`@xyflow/react`, MIT), aprovados pelo Alexandre em 31/10/2026 só para essa página. O Bun embute a página no binário (`Bun.serve` com import de `.html`). O build define `process.env.NODE_ENV="production"`, senão o React de desenvolvimento vai no binário, e por isso o `tsconfig.json` raiz tem `"jsx": "react-jsx"`: sem ele, o `bun build --compile` gera `jsxDEV`, que não existe no React de produção, e a página abre em branco (31/10/2026; o `test/stackbuilder.test.ts` compila o binário e confere). A página tem o próprio `tsconfig` (DOM e JSX); o `src/core` e o resto do CLI não importam React | `src/cli/stackbuilder/` (`server.ts`, `graph.ts`, `page/`) |

**O núcleo fica separado do terminal.** O `src/core` não desenha nada e não importa nada de `src/cli`. O que é de tela
fica em `src/cli`. O CLI usa o núcleo de preferência pelo `src/core/index.ts`. Assim, o que der certo pode ir para
outro lugar sem arrastar o terminal junto.

## 2. O que não entra sem o Alexandre

- **Dependência de execução**, mesmo "só para testar", e **SDK** de provedor (OpenAI, Anthropic, Google...).
- **Framework de agente** (LangChain, AI SDK...), **de tela** (Ink, OpenTUI, blessed) ou **de CLI** (commander,
  yargs). Os argumentos são lidos em `src/cli/args.ts`.
- **Outra linguagem no produto.** Python e shell só em experimentos (fora deste repositório) ou em ferramenta de teste.
- **Segredo em arquivo do repositório.** Chave vai para `~/.kli/.env`; a configuração guarda só o nome da variável
  (skill `kli-fontes`).
- **Algo que dependa das máquinas do Alexandre** (skill `kli-produto`).

Para pedir uma dependência: diga o problema, por que a stack não resolve, e a licença. Espere o sim antes de instalar.

## 3. Onde cada coisa mora

| O quê | Onde |
|---|---|
| Protocolo novo | `src/core/providers/<nome>.ts`, registrado em `providers/index.ts`, com teste de servidor falso em `test/<nome>.test.ts` |
| CLI novo | preset em `src/core/presets.ts`, leitor em `providers/harness.ts`, caso no `test/fixtures/fake-harness.ts` |
| Ferramenta do modelo | `src/core/tools.ts`, com as regras de comando em `src/core/shell.ts` (skill `kli-ferramentas`) |
| Subcomando (`kli xyz`) | `src/cli/args.ts` e `src/cli/main.ts` |
| Tela cheia | `src/cli/tui.ts`, mais `picker`, `form`, `overlay`, `permission`, `model-browser`, `output` (`clip` e `wrap`) e `markdown` (a resposta do modelo, na tela e nas colunas da stack) |
| Página no navegador | `src/cli/stackbuilder/`: só em `127.0.0.1`, com token no endereço e conferência do `Host`; a lógica pura fica fora do React (`graph.ts`), testada em `test/` |
| Triagem antes da stack | `src/core/triage.ts` (o texto medido), chamada pelo `StackRunner.triage` (skill `kli-stacks`, 2e) |
| O que o Kli faz | `docs/kli.md`, com as decisões e as medidas que as justificam; a porta de entrada é o `README.md` (e o `README.pt-BR.md`) |
| Configuração inicial (`kli init`) | `src/core/starter.ts` (o que achou → configuração e stacks), testada em `test/starter.test.ts` |
| Configurações prontas | `examples/*.json` e `kli.example.json`, conferidas por `test/examples.test.ts` |
| Binários do release | `scripts/release.ts` (`bun run release`) e `.github/workflows/release.yml` (tag `v<versão>`); os testes de cada PR em `.github/workflows/test.yml` |
| Como instalar numa máquina nova | `docs/instalacao.md`, escrito para a IA da pessoa seguir; mudou o build, o link, a configuração ou um pré-requisito, atualize |

## 4. Código

- **Como o código em volta:** comentários curtos em inglês, que dizem o porquê; nomes que dizem o que a coisa é; sem
  abstração antes da segunda vez.
- **Testes** com `bun:test`, nomeados como frases do comportamento ("a line is split into its parts…"), em
  `test/<área>.test.ts`.
- **Sem rede de verdade nos testes:** servidor falso com `Bun.serve`, `test/fixtures/fake-harness.ts` no lugar dos
  CLIs e `KLI_SSH` no lugar do ssh.

## 5. Comandos que valem como verdade

```
bun test               # todos os testes
bun run typecheck      # tsc --noEmit, no Kli e na página do /stackbuilder
bun run build          # dist/kli (o kli do PATH aponta para ele)
bun run dev "pergunta" # roda direto do código
```

Uma entrega só está pronta com os três primeiros verdes (skill `kli-entrega`).
