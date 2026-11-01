# Handoff — Evolution / TC token

Fechamento solicitado por Vesper em 01/11/2026 14:00 UTC para liberar memória. Dono: wk-evolution-versao-sol; responsável: Vesper/Argos. O responsável fecha o pane depois de ler este arquivo.

## Checkout e retomada

- cwd: `C:/Users/lucca/evolution-tctoken-1026`.
- Repositório: `xmacna/evolution-api`.
- Branch: `fix/tctoken-persistence-1026-20261029`, upstream `origin/fix/tctoken-persistence-1026-20261029`.
- HEAD do candidato conferido antes do commit documental de fechamento: `998a75dd3b9c8db05bbcf19d65680f51f54d1889`.
- HEAD de fechamento: consultar `git rev-parse HEAD`; o valor exato depois do commit e push está na ENTREGA em `C:/Users/lucca/argos/inbox/general2.ndjson`. O hash do próprio commit não pode ser embutido nele.
- ID real da sessão Codex, conferido em CODEX_SESSION_ID e CODEX_THREAD_ID: `01a18995-3615-7b53-a519-7dbb059f940e`.

```powershell
Set-Location C:/Users/lucca/evolution-tctoken-1026
codex resume 01a18995-3615-7b53-a519-7dbb059f940e
```

## Pronto e publicado

Correção focal de persistência TC token publicada na branch e no [PR 7, aberto em draft](https://github.com/xmacna/evolution-api/pull/7). O IQ continua desacoplado; a resposta tardia grava em transação nova, fora do contexto encerrado, com o mutex do mesmo proprietário. Instalador recusa versão ou bytes inesperados; não altera schema. Código e retorno documentados em `docs/tctoken-persistence-1026.md`.

Validação retida: rc14 original falha em quatro dos sete casos; candidato passa dez testes específicos, 14 de compatibilidade e TypeScript. Cache/providers reais e Redis local foram exercitados; fixtures limitadas a IQ e repositório inicial de credenciais. Os quatro checks GitHub do HEAD acima estão concluídos com sucesso: Check Code Quality, CodeQL Analysis, Dependency Review e CodeQL. Não repetir testes somente para o fechamento documental.

Investigação e comentários das issues 1025/1026 entregues. Atribuição histórica de logouts continua sem prova de autor/rotina ou chamada HTTP; a mensagem de aplicação aparece em quatro caminhos e a retenção não cobre os segundos solicitados. Provas privadas em `C:/Users/lucca/argos/.local/evolution-versao-20261029/seguimento-1026/`; mapa e diagnóstico em sua pasta pai. Nenhum deploy ou canário foi executado por este worker. Redis temporário foi encerrado; não há monitor ou job ativo mantido por esta frente.

## Imagem pronta e suspensa — frente relacionada

O registro da imagem ARM64 pertence ao ger-disparo-ativo-sol, em `C:/Users/lucca/elysium-worktrees/disparo-ativo-20261029/.local/disparo-ativo/EVOLUTION-PRONTO-30.md`, atualizado em 30/10 09:52 UTC. Fonte: [PR Meta 8](https://github.com/xmacna/evolution-api/pull/8). O registro declara build e smoke prontos, publicação suspensa, nenhum push da imagem ou update Evolution e nenhum canário enviado. Portanto, o código está publicado em branches/PRs; a publicação da imagem não está comprovada por esse registro.

Referência da imagem local: `evolution-meta-receipts-1030-31716cf`, Linux/ARM64, identidade `sha256:acc9a3f0cb717f0411f9199ab845a969109aefa868e0c5944a63e43045371c6f`. Não presumir que o candidato de TC token do PR 7 esteja incluído na imagem do PR 8: conferir a composição no responsável antes de qualquer release dessa correção.

Rollback dessa frente relacionado à baseline `evolution-api-candidate@sha256:4aaa5d80bfb46b66e786fe1691d1766878e02fb1739a8164fe83c31eb4f2b541`: ensaio offline de preparo, aplicação e retorno registrado em `rollback-exercise-30.log`, na mesma pasta. Não foi rollback real. O estado de cutover real ainda depende de autorização e preparo; usar o plano canônico do responsável, sem executar comandos live deste handoff.

## O que falta e condição de retomada

- **AGUARDA Lucca:** OK escrito para publicar/deployar. Vesper confirma o aviso prévio ao Rafael e a janela antes de qualquer mudança. O pedido de fechar esta sessão não autoriza deploy.
- **AGUARDA revisão:** avaliar PR 7 e sua inclusão no candidato correto; preservar patches e requisitos de ARM64, segurança e retorno. Imagem Meta e correção TC token são entregas distintas.
- **Canário pendente:** somente após autorização específica e sob o plano do responsável. Na frente Meta há previsão de um único envio interno com prova DELIVERED/READ; nenhum canário foi feito. Persistência offline não prova entrega nem causa/solução de banimento.
- **Rollback ensaiado offline:** evidência existe na frente da imagem. Antes do cutover autorizado, atualizar snapshot, confirmar digest anterior e preparar estado de avanço/retorno. Não declarar ensaio em produção ou retorno pronto no runtime sem essas etapas.
- **Vínculos, até segunda ordem:** nenhum agente pareia, desconecta, faz logout ou lê QR por script/Manager. Pareamento apenas por uma pessoa pelo Partenon, com Vesper avisado antes. A regra também vale para o canário. Campanhas em lista ficam com ger-disparo-ativo-sol.
- **Histórico administrativo:** Argos/Rafael podem indicar fonte adicional dos segundos de 25/09 16:32 e 20/10 14:12. Retomar por evidência nova, sem polling.

Este worker para no checkpoint documental. Vesper lê a ENTREGA e fecha o pane pelo rito; nenhum fechamento próprio será executado.
