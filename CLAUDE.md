# CLAUDE.md

Orientação para agentes de IA (o Claude Code e outros) neste repositório. O próprio Kli também lê este arquivo quando
roda aqui.

## O que é

O **Kli** (כלי) é um harness de terminal em que qualquer pessoa registra todas as suas fontes de inferência: servidores
locais, outras máquinas por SSH, APIs e outros CLIs. Ele trabalha na pasta com as ferramentas do Claude Code, e junta
modelos em stacks. Leia o `docs/kli.md` antes de mudar comportamento; a porta de entrada é o `README.md`.

**Instalar o Kli numa máquina** (a sua ou a de outra pessoa): siga o `docs/instalacao.md`, escrito para a IA que
instala.

**Idioma:** o Kli em si (tela, mensagens, código, comentários) é em inglês. As docs, as skills, os commits e os PRs são
em português do Brasil; o `README.md` é em inglês, com o `README.pt-BR.md` ao lado. Converse na língua de quem
escreve.

**Instruções pessoais** de quem mantém (máquinas, quando fazer push, para onde vão os experimentos) ficam no
`CLAUDE.local.md`, fora do Git. O Claude Code e o Kli leem esse arquivo depois deste.

## Skills (as regras)

| Skill | Quando |
|---|---|
| `kli-produto` | o que o Kli é e não é, a régua do Claude Code, o `kli init`, idioma, escopo e distribuição |
| `kli-stack` | stack travada (Bun, sem dependência de execução, HTTP direto, laço e tela próprios), onde cada coisa mora |
| `kli-ferramentas` | ferramentas, permissão, comandos, `!comando`, `AGENTS.md`/`CLAUDE.md`, CLIs como agentes |
| `kli-fontes` | locais, provedores e modelos; configuração, SSH, túneis, chaves, reserva, protocolos |
| `kli-stacks` | model stacks: o grafo de modelos, junção, várias saídas, medidas, rastro, `/stack` e `/stackbuilder` |
| `kli-entrega` | testes isolados, conferência na tela e no Linux, docs, branch, commit, PR e release |

## Comandos

```
bun test
bun run typecheck
bun run build          # dist/kli
bun run dev "pergunta"
bun run dev init       # grava a configuração com as fontes desta máquina (use KLI_CONFIG de rascunho)
bun run release        # dist/release: os binários de macOS e Linux e o SHA256SUMS
```

## Regras que não podem escapar

- **Testes:** com `KLI_CONFIG`, `KLI_ENV` e `sessions.dir` de rascunho. Nunca se escreve nas sessões, nas chaves ou
  na configuração de quem desenvolve, em `~/.kli`.
- **Repositório público:** nada de segredo, IP, usuário de rede ou nome de máquina e de projeto de alguém no código,
  nos testes, nas docs ou nos commits. Exemplos usam nomes genéricos (`laptop`, `gpubox`, `admin@192.168.10.230`).
- **Nenhum código depende das máquinas de quem desenvolve.** Quem usa o Kli tem as próprias fontes.
