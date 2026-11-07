# Evolution Status ACK — Nex, rodada 1

Fonte canônica; [versão visual](PLANO.html). Dono: `nex-evolution-build-sol`; branch `xmacna/1064-status-ack-main-build`. Mandato: [elysium#1064](https://github.com/xmacna/elysium/issues/1064), revisão anterior em [Evolution PR #9](https://github.com/xmacna/evolution-api/pull/9#pullrequestreview-5809084909). Sem checkpoint anterior nesta posse.

- [x] Ler #1064/#1047 e revisão Rafael; preservar a branch da PR #9 e os patches interactiveResponseMessage de outra frente.
- [x] Integrar patch auditado ao Dockerfile principal e CI, com pins, SHA256, âncoras únicas e recusa de drift.
- [x] Corrigir ID `ignored-ok`, espera por conclusão da fila e tolerância de webhook explícita/testada.
- [x] Prova offline: baseline 4 falhas; candidato 6/6; guardas 8/8; avaliador 15/15; CLI/sintaxe PASS. Receita e limites: [BUILD.md](docs/status-ack/BUILD.md) / [BUILD.html](docs/status-ack/BUILD.html).
- [ ] Publicar PR/prova, solicitar revisão Rafael e Nex no SHA atual, vincular em #1064, registrar inbox.
- [ ] Conferir CI e revisões; tratar apontamentos dentro desta posse; atualizar checkpoint e HANDOFF.md/.html.

AGUARDA: CI, build completo no ambiente Node 24; testes locais leves executados com Node 22. Docker não está instalado/disponível no PATH; nenhum serviço foi instalado/configurado. Receita reproduzível entregue, sem afirmar build de imagem local.

AGUARDA: revisor Nex e `raffareis`, revisão independente do candidato atual. A aprovação da PR #9 não aprova esta integração.

AGUARDA: dono/Vesper, digest real de registro, canário ≥4 ciclos/200min, revisão e GO. A issue permanece aberta. Sem publicação de imagem, canário real, deploy, produção, beta2, n8n ou cliente nesta rodada.
