# Handoff — correção focal de TC token

Regra vigente de Argos, 29/10 22:41Z, até segunda ordem: agentes não pareiam, desconectam, fazem logout ou leem QR de instância por script ou pelo Manager. Pareamento somente por uma pessoa pelo Partenon, com Vesper avisado antes. Vale também para eventual canário aprovado; esta missão permanece offline e sem deploy. Campanhas em lista são tratadas pelo ger-disparo-ativo-sol.

Dono: wk-evolution-versao-sol; responsável Vesper/Argos. Sessão Codex real: 01a18995-3615-7b53-a519-7dbb059f940e. Retomar com `codex resume 01a18995-3615-7b53-a519-7dbb059f940e` neste checkout.

Checkout: C:/Users/lucca/evolution-tctoken-1026. Repo: xmacna/evolution-api. Branch: fix/tctoken-persistence-1026-20261029. Mandato e cursor: PLANO.md. Código, instalação, testes e limites: docs/tctoken-persistence-1026.md.

Provas privadas: C:/Users/lucca/argos/.local/evolution-versao-20261029/seguimento-1026/RESULTADO.md, ATRIBUICAO-LOGOUTS.md, REGRESSAO-RESULTADO.json, logs RED/GREEN e PROVEDORES-COMPARACAO.json. O patch só foi aplicado ao node_modules deste checkout isolado; nenhum serviço, conta WhatsApp ou ambiente de produção foi tocado. Redis local de teste encerrado após a validação; não há job ou watcher em execução.

Resultado: rc14 original com quatro falhas de persistência; candidato com dez testes específicos, 14 de compatibilidade e TypeScript aprovados. IQ continua desacoplado; resposta grava em transação isolada, com o mutex do mesmo proprietário. Tipo/schema de registro preservados; patch recusa versão/bytes inesperados. Não foi construída imagem ARM64 ou validado banimento/entrega WhatsApp.

Logouts: autor/rotina e chamada à rota HTTP permanecem não comprovados. Os logs retidos examinados não cobrem os segundos pedidos, e quatro caminhos compartilham o texto. Há busca complementar local com cobertura e ausência de recibo explicitadas; não ampliar isso para todas as máquinas/painéis.

AGUARDA: revisão do candidato; fonte histórica adicional, se houver; decisão expressa de Argos para canário com número. PR em draft: https://github.com/xmacna/evolution-api/pull/7 . Comentário publicado e conferido na issue1026 e ENTREGA no general2; links e recibos no PLANO e na pasta de evidências. CI termina por evento no GitHub, sob acompanhamento do revisor; não há polling deste worker. Não encerrar o próprio pane; responsável fecha pelo rito.
