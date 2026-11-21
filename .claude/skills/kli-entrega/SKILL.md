---
name: kli-entrega
description: O fluxo de entrega do Kli: testes isolados das coisas de quem desenvolve, conferência na tela e com os provedores reais, docs, branch, commit, PR e release. Use ao testar, compilar, commitar, abrir PR ou publicar uma versão, e antes de dizer que uma entrega está pronta.
---

# Kli · Entrega

O repositório é público (`pacmanalx/kli`, MIT). Regras pessoais de quem mantém (máquinas, quando fazer push) ficam no
`CLAUDE.local.md`, fora do Git, e valem junto com esta skill.

## 1. Antes de dizer que está pronto

- **Verdes:** `bun test`, `bun run typecheck` e `bun run build`. O workflow `test` roda os três no macOS e no Linux em
  cada PR.
- **O build pode trocar o Kli de quem desenvolve:** quem instalou do código tem o `kli` do PATH apontando para o
  `dist/kli` (link com caminho absoluto). Só compile com os testes verdes, e diga que é preciso reabrir o `kli`.
- **Mudou a tela:** veja de verdade num terminal falso (pty).
  - Use Python `pty` e `pyte`, 120×40, com `KLI_ANIMATION=off`.
  - Espere 3 s antes de digitar: a pergunta da cor de fundo (OSC 11) consome o que chega antes.
  - Leia a tela e confira cortes, sobras e alinhamento.
- **Mudou provedor ou CLI:** rode com o real (`kli -p`, `kli check <onde>`), usando uma cópia da configuração.
- **Mudou o `kli init` ou os exemplos:** rode o `kli init` com `KLI_CONFIG` de rascunho e uma stack de verdade com a
  configuração que ele gravou. O `test/examples.test.ts` confere que `examples/` e `kli.example.json` carregam.
- **Mudou algo de sistema (cópias, cerca, comandos):** rode a suíte também num Linux. Sem máquina Linux, um container
  serve: `oven/bun:<versão>` com `git`, `ripgrep`, `python3` e `bubblewrap`; sem `--privileged` o `bwrap` não cria a
  caixa e a cerca fica de fora, com `--privileged` ela entra.
- **Página ou imagem:** capture com o Chrome sem janela (`--headless --screenshot`) e olhe, inclusive em largura de
  celular. Para o celular, o `--window-size=390,…` não basta: o Chrome não monta a página com menos de ~500 px e a
  captura engana. Ponha a página num `<iframe>` de 390 px e confira, no `onload`, que o `scrollWidth` dá 390.
- **Página que se usa (clicar, digitar, rodar):** dirija o Chrome sem janela pelo protocolo de depuração, como no
  `/stackbuilder` (skill `kli-stacks`, Testes): ali o celular sai certo com `Emulation.setDeviceMetricsOverride`.
- **Imagem com `loading="lazy"`** só carrega perto da tela: na captura, role até ela antes (`scrollIntoView`), senão
  ela sai vazia e parece quebrada.
- **Página servida pelo Kli: confira a do binário compilado**, não só a do `bun run`. Em 31/10/2026 a do código-fonte
  funcionava e a do `dist/kli` abria em preto (JSX de desenvolvimento com React de produção).
- **Se não viu ou não testou, diga.** Se um teste falhou, mostre a saída. Se pulou um passo, diga qual.

## 2. As coisas de quem desenvolve são dela

- **Rascunho sempre:** teste com `KLI_CONFIG` e `KLI_ENV` de rascunho, e `sessions.dir` também no rascunho. Nunca
  escreva em `~/.kli/sessions`, `~/.kli/.env` ou `~/.kli/config.json`. Para testar com as fontes da pessoa, copie a
  configuração para o rascunho e aponte o `sessions.dir` para lá **antes** de rodar.
- **A configuração da pessoa** muda pelo uso que ela faz do Kli (Save, `/model`). Você não muda.
- **`~/.ssh`:** nada é gravado no `known_hosts` nem no `config` sem perguntar.
- **O que a pessoa faz no Kli** (sessões, arquivos criados pelos modelos) é dela: leia para verificar, mas não apague.

## 3. Docs na mesma entrega

- **`docs/kli.md`:** o que o Kli faz e como se usa, em português, com o porquê de cada decisão. Atualize quando o
  comportamento mudar.
- **`README.md` e `README.pt-BR.md`:** a porta de entrada; mudou a instalação, o começo rápido ou o que o Kli faz,
  atualize os dois.
- **`docs/instalacao.md`:** escrito para a IA de quem instala; mudou o build, o binário, a configuração ou um
  pré-requisito, atualize.
- **Skills (`.claude/skills/kli-*`):** mudou uma regra, atualize a skill no mesmo PR.

## 4. Branch e commit

- **A pasta pode ter o trabalho de outra sessão.** Quem desenvolve pode usar o próprio Kli, com um CLI como agente,
  nesta mesma pasta. Por isso:
  - antes de abrir uma branch, confira `git branch --show-current` e `git status`;
  - abra a branch a partir do `main`, sempre: `git switch -c <tipo>/<nome> main`;
  - comite só os arquivos da entrega, com `git add <arquivos>`, nunca `git add -A`;
  - arquivo mudado que não é seu: pergunte, ou deixe fora;
  - se você tirou a pasta da branch de outra sessão, devolva quando acabar.
- **Branch por entrega:** `feat/<nome>`, `fix/<nome>`, `docs/<nome>`, `refactor/<nome>` ou `test/<nome>`. Nunca
  commite direto no `main`.
- **Mensagem:** `tipo(escopo): o que muda`, em português (`feat(tools): …`, `fix(harness): …`, `docs(skills): …`).
  Ponha um corpo quando a decisão não for óbvia. O agente acrescenta a linha de coautoria.
- **Repositório público:** nem a mensagem nem o diff levam segredo, IP ou usuário de rede, nem nome de máquina ou de
  projeto de alguém. Exemplos e testes usam nomes genéricos.
- **Fora do Git:** `dist/`, `node_modules/`, `.*.bun-build`, `.claude/settings.local.json` e `CLAUDE.local.md`. Antes
  do commit, confira com `git status` o que entra.
- **Quando commitar e quando fazer push:** quando quem mantém pedir (o `CLAUDE.local.md` diz como).

## 5. PR e release

- **PR para o `main`:** o que muda, como foi testado e o que **não** foi. Termina com a linha do Claude Code. O
  workflow `test` precisa passar.
- **Release:** a versão sobe no `package.json` dentro de um PR. Depois do merge, uma tag `v<versão>` no `main` dispara
  o workflow `release`, que confere a tag contra o `package.json`, roda os testes, compila os quatro binários
  (`bun run release`, num Mac, para os do macOS saírem assinados) e publica o release com o `SHA256SUMS`.
- **O que relatar ao fechar:** branch, commit e PR, com o hash; o que mudou e para quem; o que foi testado e como, e
  o que não foi; se o binário foi recompilado e se é preciso reabrir o `kli`; o que ficou pendente (uma decisão, um
  comando com `!`, uma chave).
