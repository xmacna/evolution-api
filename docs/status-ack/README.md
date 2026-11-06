# ACK de Status — canário, sem rollout

Responsável Infra; revisor Rafael (@raffareis). Origem: xmacna/elysium#1047 e WhiskeySockets/Baileys#2858. Não é correção comprovada da surdez específica da Lia (#1044); pool (#1048) permanece separado.

## Mudança

A imagem derivada altera somente `node_modules/baileys/lib/Socket/messages-recv.js`, no rc14 auditado. Acrescenta handler da stanza própria Status, ACK sem erro, roteamento pela fila offline e contenção de falha, inclusive no fast path de JID ignorado. Não emite mensagem, leitura de Status, resposta do bot, logout ou QR. Não muda código do Partenon, banco, credenciais, integração ou configurações.

O patch falha antes de gravar quando o SHA não coincide, âncora falta/duplica ou o candidato já está aplicado. O Dockerfile do canário herda a imagem viva imutável, sem instalar pacotes nem baixar dependências. Nenhum Dockerfile de produção foi alterado.

## Verificações realizadas

- Dependência local em leitura tem os MESMOS bytes da viva: SHA850445e6f9e076b1beb98034cbc5cf79562dfda26a44f5a874a84e3609bfd710.
- Testes executam o ACK builder e a fila reais, com o bloco de roteamento extraído do módulo efetivo e somente I/O externo simulado. Baseline falha nos4 casos de Status; candidato6PASS/0skip,≈0,2s. Inclui ordem offline, mensagem posterior, NACK ausente e erro de rede sem prender a fila. Não é prova contra WhatsApp real.
- Imagem isolada construída sem rede06/11 14:36:52Z: `xmacna/evolution-status-ack:canary-20261106`, ID`sha256:3ce3432e7fb89be020ce4578435a3c06b36e40c18f95aec6ff972e17d43d1a87`. Camada≈90kB sobre a base local. `node --check`PASS. Container/ID/start/restarts de produção permaneceram iguais; nenhum canário iniciado.
- BaseID`sha256:06349100dd517ba48ced9f670e5b1b0520e96e911980283d2daff68968851805`, fonte de imagem5955acd0. A base não tem RepoDigest publicado; portanto não substituí por uma imagem upstream diferente por conveniência.

Comando de teste: `BAILEYS_AUDITED_ROOT=<dependência auditada em leitura> node --test Docker/status-ack/test.cjs`. Adicionar `STATUS_ACK_TEST_BASELINE=1` demonstra falha antes do patch. Não requer install/build da aplicação.

## Canário real pendente

Supera Teste Fim e mv-mari-teste estão close. O único teste open encontrado é Meta oficial, que não exercita Baileys. Não copiei sessão/auth de cliente, não religuei número nem gerei QR. AGUARDA Vesper/Rafael: designar um aparelho/número INTERNO disponível e quem confirma mensagens/Status, ou locator de canário Baileys já vinculado fora da produção. O canário usará banco/rede/volumes próprios, sem rotas para dados/filas de cliente. Não reutilizar o container vivo para teste.

Plano nominal: registrar baseline; usar Status de um contato de teste consentido e entradas com marcador único; verificar ACKs reais e os mesmosIDs no receptor/webhook; observar pelo menos4 ciclos de50min (>=200min), com entrada consentida em cada fronteira. Sem stanza real de Status, zero erros não prova a correção. Coletar quedas/uptime, ACK Status, erros, ingresso e latência; payloads/telefones ficam privados. Se falhar, parar só o canário e preservar logs; nunca fazer QR em loop.

Rollback do canário: parar apenas seu container e voltar à imagem base imutável com o mesmo volume próprio, sob dono do teste. Não existe rollback de produção nesta entrega porque não houve rollout. Rollout exige evidência real + revisão Rafael + GO Vesper, novo snapshot/rollback/watch.

Provas privadas: C:/Users/lucca/argos/.local/lia-causa-raiz-20261106/{STATUS-ACK-RED.txt,STATUS-ACK-GREEN.txt,STATUS-ACK-IMAGE-BUILD.json}. Contexto remoto isolado `/tmp/xmacna-status-ack-image-20261106`, registro de build no mesmo diretório. Não declarar canário ou quatro ciclos concluídos.

## Revisão preparada

[Pacote nominal do canário](REVISAO-CANARIO.md): pré-condições, matriz, evidência mínima e rollback. Avaliador offline novo com8testes; nenhuma mudança no patch da imagem e nenhuma nova execução dos6verdes anteriores. Canário real continua pendente.
