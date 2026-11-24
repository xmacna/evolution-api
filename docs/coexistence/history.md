# Sincronização durável do WhatsApp Business app

Draft interno de 2026-11-24. Depende da PR Evolution19 e da orquestração Elysium1500.
Nenhuma configuração, migração, assinatura, upload ou chamada Graph foi aplicada em produção.
A PR19 sozinha não habilita histórico/contatos. Este receptor permanece desligado por padrão.

## Comportamento e contrato

O webhook Meta assinado captura `history` e `smb_app_state_sync` em JSON imutável antes do HTTP200.
Exige `entry.id` igual à conta verificada e `metadata.phone_number_id` igual ao vínculo da instância.
Não infere Messaging account de `Instance.businessId`. Falha de persistência retorna falha ao caller real.
Chunks repetidos compartilham identidade estável; conteúdo tardio é conservado mesmo após o prazo.

O backend de onboarding é dono do POST SMBAppData. Antes dele, chama
`POST /instance/coexistenceSyncStart/:instanceName` com apikey e
`{generation,phoneNumberId,messagingAccountId,onboardedAt,deadline?,contactsRequestId?,historyRequestId?}`.
Generation é SHA256 de `messagingAccountId:phoneNumberId`; prazo/geração são imutáveis e não se renovam por login.
Resposta exige `{ok:true,generation,phoneNumberId,messagingAccountId}` exatos.
Request IDs são anexados após aceite Graph e limitados a 255 caracteres, sem rePOST Graph neste receptor.

`GET /instance/coexistenceSyncStatus/:instanceName`, com os mesmos guards existentes,
retorna `ready`, motivo, os dois IDs, `webhookCallbackUrl`, fields, generation/prazo e estados locais.
O onboarding compara IDs/callback/fields com ativos/subscriptions Graph antes de iniciar sync.
Ready significa receptor configurado, schema e guard presentes; não significa importação concluída.
Progresso 100 da origem é separado de chunks locais pendentes/bloqueados. Fases/chunks podem chegar fora de ordem.
Contato e mídia não têm sinal terminal global comprovado; status retorna `not_signaled` para isso.

Cada instância habilitada recupera trabalho ao iniciar e a cada 5s, com cursor, lease/version CAS e retries de 30s.
A posse é conferida antes/depois de projeção e antes dos efeitos após awaits. A origem e o destino do run
são cercados: rebind de phone/conta ou Portal(account,inbox,URL) bloqueia projeção. Falha Portal posterior
não impede conservar novo conteúdo do run original. Worker expirado não confirma cursor.
Rollback da aplicação deve conservar as tabelas/chunks; não executar DROP de dados capturados.

## Configuração futura explícita

- `WA_BUSINESS_APP_SECRET` obrigatório: HMAC dos bytes raw no webhook.
- `WA_BUSINESS_COEXISTENCE_SYNC_BINDINGS`: JSON default`{}`, nome EXATO da instância →
  `{phoneNumberId,messagingAccountId}` obtidos do onboarding verificado. Phone deve ser `Instance.number`.
- `WA_BUSINESS_COEXISTENCE_SYNC_CALLBACK_URL`: URL HTTPS exata que o onboarding verificará na subscription.
- `WA_BUSINESS_COEXISTENCE_SYNC_PORTAL_URL`: URL HTTPS do Portal correspondente ao banco SQL configurado
  em `CHATWOOT.IMPORT.DATABASE.CONNECTION.URI`. Esse vínculo de infraestrutura é declarado/verificado pelo dono,
  não descoberto por IDs coincidentes. Provider enabled, token válido User/AgentBot e inbox único são obrigatórios.
- Migrações Evolution PostgreSQL/MySQL aditivas em `20261124180000_business_app_sync`.
- Índice manual Portal abaixo, separado das migrações Evolution. Nada autoaplica o artefato.

O run fixa apenas URL/IDs do destino, nunca tokens. Provider é lido de novo por operação;
nenhum receiver singleton mutável pode trocar a instância durante um await.

## Portal, unicidade e anexos

Histórico usa INSERT SQL e timestamps UTC originais, sem `messages.create`, callbacks Rails,
webhooks, chatbot/LLM, recibo WhatsApp, envio ou pausa atual. Não muda status, assignee, unread,
last_activity ou custom pause de conversa existente; novas conversas históricas ficam resolvidas.
Mensagens históricas vivem no Portal e nos chunks capturados; não são reemitidas como mensagens ao vivo
nem criam cópias na tabela Evolution Message. Direção vem do contrato Meta, ator outgoing preserva User/AgentBot;
ID interno da conversa é distinto de display_id da API. Source WAID reconcilia live/echo/history no mesmo account/inbox.

`portal-sql/waid-source-unique.sql` é a única definição manual do índice UNIQUE parcial.
O dono do Portal deve revisar `portal-sql/preflight.sql`, snapshot/rollback e contagens de duplicatas,
seguir o rito próprio de produção e só então aplicar, fora de transação. Nenhum DELETE/dedupe automático.
Readiness/import recusam índice ausente, não único, inválido, indisponível ou com chaves/predicado divergentes.
Rollback do índice: futuro DROP INDEX CONCURRENTLY apenas desse índice, sem apagar mensagens/capturas;
sem ele sync volta a indisponível. O teste local aplica o artefato apenas em schemas descartáveis.
O índice protege também escritor API sem nosso advisory;23505 é reconciliado com conta/inbox/recipient/display_id.
Não há promessa de exactly-once entre bancos, processos ou HTTP.

Media_placeholder permanece pendente até bytes+associação confirmados. Mídia posterior enriquece o mesmo WAID,
sem reenviar conversa ou sobrescrever mensagem live/echo. Download Meta usa modo estrito sem logar AxiosError.
Upload usa DirectUploads nativo por account/display_id, MD5/base64 do conteúdo e SHA256 Meta quando fornecido;
PUT vai apenas a HTTPS sem userinfo, com os headers nativos de storage, sem token Meta/Portal.
A transação associa attachments→active_storage_attachments→blob ao registro histórico já existente;
essa relação o serializer nativo do Portal encontra o arquivo para visualização/download.
Falha de PUT conserva placeholder e cursor retryable. Retry de anexo confirmado não cria novo anexo.
Crash entre aceite remoto e vínculo SQL pode deixar blob órfão; não há limpeza remota automática nem garantia
de dedup absoluta de blobs. HTTP/serializer Rails reais não foram executados, apenas HTTP stub+SQL real e leitura de fonte.

Contatos guardam add/remove e timestamp; remove não apaga contato que possui histórico.
Stamp no próprio destino e advisory por contato impedem add antigo sobrepor novo/remove, inclusive entre processos. A releitura do ledger sob essa trava cobre a remoção de contato ainda inexistente; processador superado reverte a transação e o retry observa o estado novo.
Telefone Cloud é preservado sem heurísticas Baileys/aliases de país.
BSUID tem domínio separado. Pareamento telefone↔BSUID só é aceito quando coexistem no payload oficial assinado;
conflito bloqueia. BSUID sem esse vínculo fica conservado e explicitamente bloqueado para projeção Portal,
sem fakephone. Quarentenas não são reabertas automaticamente após nova configuração/mapeamento:
exigem reconciliação revisada. Isso limita o rollout geral, assim como tipos históricos desconhecidos,
que ficam capturados/bloqueados. Tipos apresentados: text, media_placeholder, image/audio/video/document/sticker,
location, contacts e reaction; edit/revoke históricos não recebem transformação inferida.

## Provas reproduzíveis

Com dependências já declaradas instaladas pelo ambiente, sem produção:

```sh
npm run test:xmacna-meta-sync
npm run test:xmacna-meta-coexistence
# URL deve apontar exclusivamente para PostgreSQL descartável loopback.
XMACNA_INBOX_INTEGRATION=1 DATABASE_CONNECTION_URI="$SYNTHETIC_PG_URI" node --test test/xmacna-meta-history.postgres.test.cjs
# CI exige Prisma gerado e executa o caso real de substituição do client/cursor:
npm run test:xmacna-inbox:postgres
# Validação sem DB, engine já disponível (nenhum download):
PRISMA_SCHEMA_ENGINE_BINARY="$EXISTING_SCHEMA_ENGINE" node test/helpers/validate-meta-sync-schemas.cjs
```

Local: Node 26.13, esbuild 0.25.5 emprestado read-only, PostgreSQL 16.15 descartável RAM.
NODE_PATH pode apontar aos donors existentes de esbuild/pg; caminhos privados não fazem parte do contrato.
O CI normal usa Node 24, Prisma gerado e PGisolado. Local não havia PrismaClient gerado: esse caso é skip explícito
local, obrigatório na suíte CI existente (`META_SYNC_REQUIRE_PRISMA=1`). Nenhum workflow alterado.
Ambos datamodels foram validados por engine Prisma já instalado, sem conexão; migrações geradas pelo diff
correspondente. PG migration executada apenas no banco descartável; servidor MySQL não executado.
Formatter Prettier 3.9.6 já fixado foi extraído em RAM com integrity do lock conferida, exceção autorizada;
nenhuma dependência nova nesta peça. A exceção anterior express-rate-limit pertence à PR19.
Testes de limites externos não são prova E2E com conta real, Portal/Rails ou fluxo n8n vivo.

## Fontes oficiais abertas em 24/11/2026

[Meta history](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/history)
e [onboarding atual, sync/BSUID](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users).
Fixtures públicas/sintéticas e alterações descritas em `test/fixtures/meta-coexistence/README.md`.
A referência específica state_sync retornou429; usamos o contrato explícito da seção na página de onboarding.
[Chatwoot DirectUploadsController](https://github.com/xmacna/chatwoot/blob/main/app/controllers/api/v1/accounts/conversations/direct_uploads_controller.rb),
[Attachment](https://github.com/xmacna/chatwoot/blob/main/app/models/attachment.rb),
[schema Portal](https://github.com/xmacna/chatwoot/blob/main/db/schema.rb),
[ActiveStorage7.1 DirectUploads](https://github.com/rails/rails/blob/v7.1.5/activestorage/app/controllers/active_storage/direct_uploads_controller.rb).
Leitura da fonte mostra messages/conversations SERIAL e content_attributes JSON;
BIGINT no teste separado da PR19 é hardening sintético, não observação de schema de produção.
[Prisma engine API](https://github.com/prisma/prisma-engines/blob/main/schema-engine/json-rpc-api/src/types.rs)
distingue schemaDatamodel (sem conexão) de schemaDatasource/URL; usamos só o primeiro.

Checkpoint local:19/19 core/coordenador,45/45 echo/rota assinada,13 testes PostgreSQL reais+1 skip Prisma local. O caso Prisma é obrigatório em CI. Evidência RED real: rebind antes do fence pool max1 antes do encaminhamento do client e remoção sem contato antes da releitura do ledger; logs GREEN correspondentes em evidence/. Nenhum desses números representa prova e2e de produção.
