# Handoff — LID não resolvido em enforce

Worker: `/root/evolution_lid_enforce_1495`, sob ger-nyx-sol. Data: 24/11/2026.
Posse: `/dev/shm/evolution-lid-enforce-1495-20261124`.
Branch: `nyx/lid-enforce-1495-20261124`, origin `xmacna/evolution-api`, base main.
[PR draft 18](https://github.com/xmacna/evolution-api/pull/18).

Implementação e revisão do gerente concluídas. Dispatch/recovery entregam LID sem alias;
PN conhecido, off/shadow, erros inesperados e fencing preservados. Novo evento sem identificadores.
Prova reproduzível: [relatório](../2026-11-24-unresolved-lid-enforce.md) e [saída sanitizada](PROVA.md).
RED: 9/15 passam e 6 falham no código antigo; GREEN: 15/15. Controles existentes: 17/17.
Typecheck focado sem emit passou; suíte completa/typecheck integral não executados.
Node 26/TS 4.9 locais diferem de Node 24/TS ^5.7.2 do pacote.

GET nominal Extract Message: HTTP 200; replay offline com payload nativo plano aceita LID.
Session/user/remote preservam LID com/sem senderLid plano. Campo senderLid depende do patch
fix-sender-lid da receita, que deve ser preservado no release futuro. Rota de retorno @lid conferida
no source, sem envio real. Nenhum workflow, execução, lead, conversa ou recibo real alterado.

Receita histórica b3044e8f indisponível nas fontes consultadas; a receita versionada disponível foi
mapeada e os limites ficaram explícitos. Não há autorização de build, ECR, deploy, restart, merge
ou replay de recibos dead. A eventual separação de sessão LID/PN e falta de prova e2e estão declaradas.

O HEAD usa [skip ci] por ordem SEM BUILD. Primeiro readback: draft OPEN, base main,
checks vazios, zero workflow runs. O gerente deve confirmar pelo HEAD final ao integrar.
Não declarar CI verde; checks podem ficar pendentes.

Bundle de transporte próprio em RAM: `.private/evolution-lid-enforce-1495.bundle`.
Código, testes e esta documentação ficam duráveis na branch GitHub; o bundle em RAM é uma cópia
para transporte, não o único registro. Nenhum arquivo .private ou dependência foi commitado.
Nenhuma mensagem foi enviada ao general2 ou a cliente por este worker.

Retomada em máquina com dependências: clonar o fork, checkout da branch e executar os comandos
do relatório. Para retomar a posse atual: `cd /dev/shm/evolution-lid-enforce-1495-20261124`.
Próximo dono: gerente revisa/entrega ao ger-partenon-opus; release só no rito e com autorização própria.
