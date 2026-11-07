# Respostas interativas no normalizador do chatbot

Contrato do fork `xmacna/evolution-api` para [xmacna/elysium#1061](https://github.com/xmacna/elysium/issues/1061). A issue vive no Elysium porque as issues do fork estao desativadas; o codigo funcional vive neste repositorio.

## Variantes suportadas

- `message.interactiveResponseMessage.nativeFlowResponseMessage.name = quick_reply`: usa o campo textual `id` do objeto JSON em `paramsJson`.
- `single_select`: usa o mesmo contrato `paramsJson.id`.
- O ID e o valor semantico da selecao. `body.text`, `display_text`, contexto, titulos de metadados e campos desconhecidos nao substituem um ID ausente ou invalido.
- Outros native-flows, como formularios, pagamentos e acoes de permissao, continuam sem normalizacao ate terem contrato proprio. Nao ha stringify generico nem texto artificial `unknown`.

## Validacao e precedencia

`paramsJson` precisa ser string de ate 16.384 caracteres e decodificar um objeto, nunca array ou escalar. O campo proprio `id` precisa ser string; depois de trim, deve conter 1–1.024 caracteres, sem controles ASCII ou valor literal `unknown` (ignorando caixa). Dados malformados produzem `undefined` e seguem o guard existente de conteudo.

`getInteractiveResponseContent` e chamado pelo mapa real em `src/utils/getConversationMessage.ts`. Texto e respostas legadas de lista/botao/template mantem sua precedencia. O fallback externo de anuncio e sua concatenacao preservam o contrato anterior. `fromMe`, grupos ignorados e deduplicacao continuam no controller/inbox existentes; o normalizador nao cria caminho de envio paralelo nem altera a chave de recibo.

## Prova offline

`test/xmacna-interactive-response.test.ts` usa o normalizador, o controller n8n e `PrismaInboundInbox.claim` reais, com armazenamento e fronteiras externas simulados. Verifica selecao valida, repeticao do mesmo ID, fromMe, grupo ignorado, vazio/malformado, fluxos nao suportados, formatos legados e fallback. A fixture reconstrui apenas a forma publica observada (`messageContextInfo` + `interactiveResponseMessage`); os valores de native-flow sao sinteticos, pois o payload privado minimizado nao estava disponivel nesta posse. Nao e replay do conteudo real da lead nem prova de banco PostgreSQL.

Executar com Node 24: `npm run db:generate`, `npx tsx --test --test-concurrency=1 test/xmacna-interactive-response.test.ts` e `npx tsc --noEmit`. O teste novo integra `npm run test:xmacna-inbox`. O carregamento do bundle temporario usa `pathToFileURL`, inclusive no teste existente do service n8n, para funcionar em Windows e Linux.

Validacao final em Node 24: **81/85 testes de inbox passaram**, incluindo todos os casos interativos/controller/dedupe. As quatro falhas herdadas sao exclusivamente S3/Windows: chaves com barra invertida em arquivos de source/teste identicos aos da base (hash conferido); registradas em [Elysium#1070](https://github.com/xmacna/elysium/issues/1070). A bateria ampla nao esta verde; nao foi repetida nem alterado S3 nesta PR. `tsc --noEmit`, lint integral de `src` e build `tsup` CJS e ESM em etapas separadas com exit 0. Prisma Client gerado localmente a partir do schema PostgreSQL; nenhuma migracao ou conexao de banco foi executada. O teste de service existente tambem passou com import portavel. Docker indisponivel; PostgreSQL real, replay privado e canario nao sao cobertos por esta prova.

## Publicacao pendente

Canario em instancia interna consentida, recibo do mesmo ID no fluxo, revisao Rafael e rito de imagem com snapshot/readback/rollback continuam pendentes. Nenhuma aplicacao, canario real, workflow n8n vivo, bot, Chatwoot ou dado de cliente foi alterado. A PR nao autoriza producao.

Build local: a invocacao padrao CJS+ESM simultanea encerrou com status nativo 3221226505, sem diagnostico de TypeScript. Reexecutado somente o build, com os mesmos entries/opcoes e GOMAXPROCS=1: `tsup --format cjs` e `tsup --format esm --no-clean`, ambos exit 0. Nenhum source/config de build alterado; testes nao repetidos. CI Linux padrao continua responsavel pela invocacao integrada.
