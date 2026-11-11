# Evolution Status ACK — Nex, rodada 1

Fonte canônica; [versão visual](PLANO.html). Dono: `nex-evolution-build-sol`; branch `xmacna/1064-status-ack-main-build`. Mandato: [elysium#1064](https://github.com/xmacna/elysium/issues/1064), revisão anterior em [Evolution PR #9](https://github.com/xmacna/evolution-api/pull/9#pullrequestreview-5809084909). Sem checkpoint anterior nesta posse.

- [x] Ler #1064/#1047 e revisão Rafael; preservar a branch da PR #9 e os patches interactiveResponseMessage de outra frente.
- [x] Integrar patch auditado ao Dockerfile principal e CI, com pins, SHA256, âncoras únicas e recusa de drift.
- [x] Corrigir ID `ignored-ok`, espera por conclusão da fila e tolerância de webhook explícita/testada.
- [x] Prova offline: baseline 4 falhas; candidato 6/6; guardas 8/8; avaliador 15/15; CLI/sintaxe PASS. Receita e limites: [BUILD.md](docs/status-ack/BUILD.md) / [BUILD.html](docs/status-ack/BUILD.html).
- [x] Publicar [PR #10](https://github.com/xmacna/evolution-api/pull/10) e [prova](https://github.com/xmacna/evolution-api/pull/10#issuecomment-6712666695), solicitar revisão Rafael e Nex, [vincular em #1064](https://github.com/xmacna/elysium/issues/1064#issuecomment-6712670146), registrar inbox.
- [x] Conferir [CI Node 24 e build completo](https://github.com/xmacna/evolution-api/actions/runs/42411550360) e [segurança](https://github.com/xmacna/evolution-api/actions/runs/42411550254): PASS no commit de código `d41e4357ab785db42550db11e5dc6c6b09805ec0`.
- [ ] Receber revisões Rafael/Nex no SHA atual e tratar apontamentos. Continuidade no checkpoint e HANDOFF.md/.html externos da frente.

CI Node `v24.22.2` passou, inclusive build completo e testes PostgreSQL isolados. Docker não está instalado/disponível no PATH; nenhum serviço foi instalado/configurado. Receita reproduzível entregue, sem afirmar build de imagem local. O CI do último commit documental deve ser conferido pela retomada se ainda estiver em execução.

AGUARDA: revisor Nex e `raffareis`, revisão independente do candidato atual. A aprovação da PR #9 não aprova esta integração.

AGUARDA: dono/Vesper, digest real de registro, canário ≥4 ciclos/200min, revisão e GO. A issue permanece aberta. Sem publicação de imagem, canário real, deploy, produção, beta2, n8n ou cliente nesta rodada.
