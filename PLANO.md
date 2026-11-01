# TC token e logouts — issue elysium 1026

Fechamento solicitado por Vesper em 01/11 14:00Z para liberar memória: preservar git limpo/push, HANDOFF.md com cwd/branch/HEAD/sessão/retomada e pendências, e uma ENTREGA no general2 com caminho e HEAD. Não fechar o próprio pane. Handoff canônico de saída: `HANDOFF.md` na raiz deste checkout; imagem relacionada permanece sob ger-disparo-ativo-sol, sem presumir inclusão deste PR nela. Deploy aguarda OK escrito do Lucca e aviso ao Rafael; canário pendente, rollback da imagem ensaiado apenas offline.

Regra vigente de Argos, 29/10 às 22:41Z, até segunda ordem: nenhum agente pareia, desconecta, faz logout ou lê QR de instância por script ou pelo Manager. Pareamento somente por uma pessoa, exclusivamente pelo Partenon, com Vesper avisado antes. Qualquer canário futuro também deve obedecer; os ensaios desta frente são offline, sem conta WhatsApp. Pausa de campanhas em lista é responsabilidade do ger-disparo-ativo-sol; não operar campanhas aqui.

Dono: wk-evolution-versao-sol. Responsável: Vesper/Argos.
Posse: branch fix/tctoken-persistence-1026-20261029 neste checkout isolado; evidências locais em C:/Users/lucca/argos/.local/evolution-versao-20261029/seguimento-1026.
Origem: xmacna/evolution-api, main de 23/10; não é afirmação de que main inteiro esteja implantado.

Ordem de Argos, 29/10 às 21:58Z: “(1) siga com a atribuição dos logouts de 25/09 16:32 e 20/10 14:12, só leitura, pelos logs de acesso e auditoria retidos: quem ou qual rotina chamou /instance/logout; (2) siga com o teste de regressão offline e a correção focal da persistência (store e cache reais, token frio, resposta tardia, recriar o store), sem deploy e sem tocar no serviço. Resultados comentados na #1026 e ENTREGA no general2. O canário com número só vem depois, com a minha decisão.”

- [x] Investigar atribuição dos logouts e registrar limite preciso: autor/rotina e chamada HTTP não comprovados.
- [x] Reproduzir falha com módulos rc14 reais, cache real, armazenamento persistente e store recriado.
- [x] Implementar correção focal sem aguardar IQ no mutex de envio; testar concorrência, isolamento e falhas.
- [x] Documentar instalação/rollback do patch sem deploy; publicação da branch na entrega.
- [x] Comentar resultado sem dados de cliente na issue1026 e registrar ENTREGA no general2.

Critério de pronto: regressão falha no rc14 original e passa com correção; token e índice sobrevivem ao cache/store recriados; callback usa transação nova; erros de IQ liberam dedup; código revisto e checks proporcionais. Nenhum deploy, serviço alterado ou canário.

Verificação de logs: o mesmo texto de logout existe em quatro famílias de caminhos; não atribuir a chamada HTTP por esse texto. AWS em operações de leitura; sem send-command. Logs remotos recentes e metadados de retenção já coletados são reaproveitados.

AGUARDA: Argos decidir canário somente depois da entrega; não executar nesta missão. Eventual pareamento cabe exclusivamente a uma pessoa pelo Partenon, com Vesper avisado antes; nenhuma operação de vínculo por agente.

Prova: rc14 original falha em quatro dos sete casos; candidato passa dez testes específicos, sem skips, mais 14 de compatibilidade e tsc. Redis 7.4.12 local encerrado após o ensaio. As quatro implementações de provider/cache testadas são iguais às fontes da imagem principal implantada. Evidências, relatório e limites na pasta local citada acima; documentação do patch em docs/tctoken-persistence-1026.md.

AGUARDA: Argos/Rafael indicar eventual access/audit log histórico dos segundos solicitados, se existir fora das fontes examinadas. Não houve fonte suficiente para identificar o chamador; quatro famílias de código podem emitir a mesma mensagem de logout.

Candidato em draft: https://github.com/xmacna/evolution-api/pull/7 . Resultado publicado e readback conferido: https://github.com/xmacna/elysium/issues/1026#issuecomment-6509599968 . ENTREGA registrada no general2, com recibos ISSUE-READBACK.json e ENTREGA-GENERAL2.json na pasta local da evidência. Checks locais aprovados; os quatro checks GitHub do candidato também estão concluídos com sucesso, conferidos no fechamento de 01/11. Atualização documental de fechamento será enviada na mesma branch; nenhum build/teste adicional solicitado.
