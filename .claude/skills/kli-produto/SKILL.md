---
name: kli-produto
description: O que o Kli é, o que ele não é e a régua de comportamento (o Claude Code). Use antes de decidir como uma função do Kli se comporta, o que aparece na tela, como algo se chama ou o que entra no escopo.
---

# Kli · Produto

## 1. O que é

Uma ferramenta em que **qualquer pessoa** registra **todas** as suas fontes de inferência:
- servidores locais (Ollama, llama.cpp, LM Studio, vLLM);
- outras máquinas, por SSH;
- APIs (Google, Anthropic, compatíveis com OpenAI);
- outros CLIs (Claude Code, Antigravity, OpenCode, Kimi).

Com elas, a pessoa usa o que o Kli oferece: escolher e trocar de modelo, reserva, rastro, estatísticas e
ferramentas. A definição é do Alexandre, de 30/10/2026.

Pense sempre em quem tem as próprias fontes. As máquinas de quem desenvolve servem para testar, mas não são o
produto. Nenhum código depende de nome, IP ou porta delas. Nos exemplos, nos testes e nas docs, os nomes são genéricos
(`laptop`, `gpubox`, `lab`, `admin@192.168.10.230`, `my-gcp-project`): o repositório é público.

## 2. A régua: o Claude Code

"Temos que funcionar idêntico ao Claude Code" (Alexandre, 30/10/2026). Antes de inventar um comportamento, veja como
o Claude Code faz:
- ferramentas e permissão;
- Shift+Tab, `!comando`, Ctrl+B e os comandos com `/`;
- `AGENTS.md` e `CLAUDE.md`;
- como cada passo aparece na tela (`● Bash(ls -la)` e embaixo `⎿ exit 0 · 7 lines`).

Para ser diferente é preciso um motivo, e o motivo vai para o `docs/kli.md`. Os nomes seguem Claude Code, Codex,
OpenCode e Gemini CLI: *location* = local, *provider* = provedor, *fallback* = reserva, *session* = conversa,
*trace* = rastro.

## 3. Começar sem configurar nada

- **`kli init`** (21/11/2026) acha os CLIs, os servidores locais e as chaves desta máquina e grava a configuração com
  as stacks de exemplo ligadas ao que achou (`src/core/starter.ts`). Quem chega não deve precisar editar JSON para
  ver uma stack responder.
- **Fonte nova que o Kli passa a conhecer** (um CLI, uma porta de servidor, uma API comum): entra também no
  `kli init` e, se fizer sentido, num arquivo de `examples/`.

## 4. Premissa dos CLIs

Quem instalou um CLI e o escolheu como modelo deu a permissão (Alexandre, 30/10/2026). Por isso o CLI trabalha como
agente na pasta, com as ferramentas e as permissões dele. As flags de cada um estão na skill `kli-ferramentas`.

## 5. Idioma e texto na tela

- **Inglês:** o harness inteiro, ou seja, comandos, opções, status, mensagens, configuração, rastro, código e
  comentários.
- **A língua da conversa** é decidida pelo modelo: as instruções pedem para responder na língua de quem escreve.
- **Português do Brasil:** `docs/` e as skills.
- **Mensagens:** curtas e diretas. Quando algo falha, a mensagem diz o que fazer. Exemplo: o ssh sem a chave da
  máquina mostra o comando para aceitá-la.

## 6. Escopo

- **Hoje:** só texto (o multimodal fica para depois). O que falta das ferramentas é o MCP.
- **Ordem das próximas fatias:** está no `docs/kli.md`, seção "Próximas fatias".
- **Mudança de escopo** é decisão do Alexandre. Ideia nova vai como proposta, sem entrar no código.
- **Deploy:** o Kli não tem deploy. No Kli, "deploy" é um uso: o modelo roda o deploy do projeto da pessoa pelo
  Bash.
- **Distribuição** (21/11/2026): o código é público (MIT) e os binários (macOS e Linux, arm64 e x64) vão para o
  GitHub Releases por uma tag `v<versão>`. Nada além disso (npm, Homebrew, instalador) sem decisão do Alexandre.
