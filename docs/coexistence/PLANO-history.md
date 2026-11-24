# Contatos/histórico — 2026-11-24

Dono: worker Evolution / ger-nyx-sol. Branch nyx/meta-coexistence-history-20261124 depende da PR19 (9f49c73, CI integral verde). Editor único. Elysium PR1500 detém Graph SMBAppData e ledger de requests; nenhuma chamada Graph é efeito deste receptor.

- [x] Reabrir fontes atuais history e state_sync; ler contrato Elysium atual.
- [x] Contrato: GET /instance/coexistenceSyncStatus/:instanceName e POST /instance/coexistenceSyncStart/:instanceName autenticados pelos guards atuais. IDs+callback+fields na readiness. Start antes Graph, generation SHA256(account:phone), prazo conservador imutável, request IDs pós-aceite; nenhum reset automático.
- [x] Modelos/migrações PostgreSQL e MySQL: run por instância, chunks JSON imutáveis com cursor/lease, contatos com domínio BSUID separado e tombstones.
- [x] Captura assinada durável antes HTTP200; recovery no startup/intervalo existente do processo, lease CAS e retry por erro operacional, payload tardio conservado.
- [x] Projeção por instância+wamid, sem emit/chatbot/pausa; mídia posterior enriquece mesmo registro; duplicata live/echo não reemite.
- [x] Portal: caminho SQL histórico com timestamps originais, sem API messages.create/Rails callbacks; preservar status/pausa/assignee/unread de conversa existente; novas threads históricas resolvidas.
- [x] RED/GREEN serviços reais; PG16 descartável próprio RAM para SQL/constraints quando útil; suíte Prisma real no PGisolado CI versionada. MySQL não foi executado num servidor.
- [ ] Checkpoint/revisão antes push; PR draft main separada com dependência explícita PR19.

BSUID sem telefone confiável será mantido como identidade opaca/pendência explícita, nunca JID inventado. Status separa progress100 da origem, importação local pendente/bloqueada e mídia posterior. Contatos não têm sinal terminal documentado; não inventar conclusão global. A exceção da ferramenta Prettier já fixada e da lib rate-limit foi autorizada pelo gerente; nenhuma árvore de deps no SSD. Nada de produção/pareamento/merge/deploy/Graph real.

Checkpoint local:19/19 core/runtime;45/45 echo+signed capture;13 PG reais+1 skip Prisma local obrigatório em CI; PG/MySQL datamodels validados sem DB. RED reais preservados para stale binding, pool max1 e remoção sem contato, GREEN correspondente. Próximo: revisão gerente, commit/push/draft e CI obrigatório Prisma/build. Nenhuma promessa e2e ou ativação.
