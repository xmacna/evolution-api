# Instance DELETE completion — Nex, rodada 1

Fonte canônica; [HTML](PLANO.html). Dono `nex-evolution-build-sol`; branch `xmacna/244-await-instance-removal`. Origem [elysium#244](https://github.com/xmacna/elysium/issues/244), `FILA-AUTORIZADA.md` e `PAUTA-3-ORDEM.md`. Item 3 da rodada, em worktree próprio; sem posse concorrente no inventário lido.

- [x] Reproduzir seis falhas no contrato de conclusão do DELETE usando classes/EventEmitter2 reais e limpeza simulada.
- [x] Controller aguarda evento; monitor aguarda ambas as etapas antes de remover memória e registrar sucesso.
- [x] Sete testes candidatos PASS, incluindo ordem do logout, falhas e preservação de outra instância.
- [x] Acrescentar comando focado ao CI Node 24; manter limites e receita documentados.
- [ ] Publicar PR/prova, registrar inbox e solicitar revisão independente no SHA final; conferir CI/build.

Critério de pronto de código: testes focados e build/CI verificados, revisão solicitada e prova remota. Documentação: [DELETE-COMPLETION.md](docs/instance-delete/DELETE-COMPLETION.md) e [HTML](docs/instance-delete/DELETE-COMPLETION.html).

Fora desta entrega: Partenon `waitUntilInstanceGone`, retry de conflito no rollback e mensagem de recuperação da issue #244. Migração real, produção e fechamento da issue permanecem pendentes do rito/dono. Ao atingir três entregas, o próximo item executável deve ficar no checkpoint com origem concreta, sem quarta implementação nesta rodada.
