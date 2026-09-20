# Main do fork Xmacna

A main incorpora o runtime `9f9f70326e2fb524c98735398ba01e02acc4d1a3` (debounce destacado e inbox durável), preservando também os seis commits exclusivos de documentação, licença e URLs da main anterior. `src/`, `prisma/`, `package.json` e lockfile são byte a byte iguais ao runtime selecionado. Nenhuma atualização upstream foi acrescentada.

## Publicação e recuperação

- Main é a linha de desenvolvimento do fork. Os publicadores herdados que escreviam em `evoapicloud/evolution-api` foram removidos. Publicação Xmacna continua pelo fluxo de candidato no Elysium, com source SHA, validação, digest imutável e promoção separada.
- Baseline sem inbox: tag `recovery/20260919-rc14-baseline`, commit `2940626fbf52a01d9d5049a76c158c1f3b7b7da9`. Não mesclar: é alternativa de rollback sem a funcionalidade de inbox.
- Olympus vivo: tag `release/olympus-20260816-93d137a9`, commit `93d137a99ba29e1bbbe5884cd1235505da03ef21`.
- Default vivo: tag `release/default-20260914-9f9f7032`, commit `9f9f70326e2fb524c98735398ba01e02acc4d1a3`.
- Estado anterior da main: `recovery/20260919-before-main`.

As tags preservam código; rollback operacional usa os digests já publicados, não um rebuild implícito. Remover branches antigas somente após os consumidores usarem main ou tags imutáveis. Não alterar pins vivos para fazer limpeza.

## Evidência de 19/09/2026

- 14 testes de compatibilidade e 37 testes de inbox/storage aprovados; lint e build aprovados. Tempo 23,50s, pico 2,28GiB. Instalação isolada 12,95s.
- PostgreSQL16 isolado em loopback: 11 testes aprovados em 4,66s, incluindo 840 entregas concorrentes, fencing, isolamento e replay.
- Health dos dois targets: API e EB aprovados; 86 instâncias default, 20 Olympus. EB Green/Ready: default `xmacna-inbox-default-820b573e0865-20260914T233734Z`; Olympus `xmacna-inbox-olympus-41155399cf10-20260816T210523Z`.
- Nenhum deploy/restart/mensagem/DDL de produção. A consolidação registra código já implantado. Evidência privada e backups Git/restauráveis: `~/backups/repos/2026-09-19/`.
