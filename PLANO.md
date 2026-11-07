# Proxy protocol contracts — Nex, rodada 1

Fonte canônica; [HTML](PLANO.html). Dono `nex-evolution-build-sol`; branch `xmacna/proxy-agent-protocol-contracts`. Origem: `FILA-AUTORIZADA.md` e lacuna reproduzida no utilitário `makeProxyAgent.ts`. Item 2 da rodada, independente da PR #10 e da frente interactiveResponseMessage.

- [x] Conferir PRs abertas e `task-claims.ndjson`; registrar posse própria `evolution-proxy-contracts` antes de editar.
- [x] Reproduzir quatro falhas: HTTPS, SOCKS4, paridade de objeto e alias SOCKS no Undici.
- [x] Correção mínima e seis testes offline verdes com agentes reais; sem tráfego de rede.
- [x] Acrescentar `test:xmacna-proxy` ao CI Node 24.
- [ ] Publicar PR, prova, inbox e fila de revisão Nex no SHA atual; conferir build do CI.

Critério de pronto de código: seis testes e build/CI verdes, revisão solicitada e evidência remota. Relato/limites: [PROXY-CONTRACTS.md](docs/proxy-agent/PROXY-CONTRACTS.md) e [HTML](docs/proxy-agent/PROXY-CONTRACTS.html). Sem produção, merge, proxy real ou alteração de serviços.
