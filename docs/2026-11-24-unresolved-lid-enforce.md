# LID não resolvido no inbox enforce

Entrega interna para elysium#1495. Escopo: correção no fork Evolution, sem mudança em produção.

## Comportamento

O chatbot recebe a identidade LID quando o resolver não conhece o telefone. Em `enforce`,
`key.remoteJid` e `key.senderLid` ficam iguais ao LID completo; não se deriva telefone dos dígitos.
O dispatch inicial e a recuperação mantêm a entrega durável e o registro do sink como `sent`.
A recuperação conclui o recibo pelo caminho existente `markDone` após os sinks se resolverem.
Aliases conhecidos continuam indo ao telefone. `off`, modo ausente e `shadow` mantêm a entrega anterior.

Na recuperação, apenas `UnresolvedInboundLidError` autoriza o fallback. Erros inesperados de resolver,
transporte, banco ou fencing continuam falhando. `remoteJidAlt` só é reescrito pelo caminho resolvido;
o fallback preserva o hint anterior. Best-effort continua condicionado à entrega durável e ao mark bem-sucedidos.
O evento novo `unresolved_inbound_lid_delivered_as_lid` tem apenas `event`, `mode` e `sink`.
Não há identificador, LID, telefone nem mensagem de erro nesse evento. Logs preexistentes não foram saneados.

## RED → GREEN

O teste novo chama `dispatchInboundChatbot`, `attemptDurableInboundSink` e `resolveInboundAddress` reais.
O helper de teste extrai por AST o método inteiro `dispatchRecoveredInbound` do serviço, sem substituir
seu corpo, e o executa em sandbox com o resolver real. São simulados o transporte, o store de aliases,
o controlador n8n e a persistência; não há aplicação iniciada, acesso a banco ou recibo real.
A persistência simulada verifica o envelope passado ao `markSink`; os testes exigem `sent` e `markDone`.

O mesmo teste foi executado contra os arquivos de produção de `origin/main`, lidos em memória com `git show`,
e depois contra os arquivos alterados. O runner aceita um SHA completo para reproduzir o baseline:

```sh
XMACNA_INBOUND_BASELINE_REF=21d5d901e594cb308a11e8cad95080d0b65495ba \
  node --test --test-reporter=tap test/xmacna-inbound-lid-enforce.test.cjs
node --test --test-reporter=tap test/xmacna-inbound-lid-enforce.test.cjs
```

| Execução | Passaram | Falharam |
| --- | ---: | ---: |
| Código anterior, teste novo | 9 | 6 |
| Código corrigido, teste novo | 15 | 0 |
| Controles existentes: identidade, sinks e contratos de serviço | 17 | 0 |

No baseline, falham dispatch enforce, recovery unknown/ambiguous, preservação do hint e os controles
que precisam atingir a entrega durável antes de exercitar falha de transporte/fencing.
O defeito central aparece como `chatbot: failed` onde o teste exige `chatbot: sent`.
Passam os controles de alias resolvido, modo ausente/off/shadow, erro inesperado do resolver e já entregue.

O helper de dispatch também passou `tsc --noEmit --strict --skipLibCheck --target ES2022`.
Execução local: Node 26.13.0 e TypeScript 4.9.5 emprestado em leitura; o pacote exige Node 24 e TypeScript ^5.7.2.
Não foi possível executar a suíte completa ou o typecheck integral sem as dependências da aplicação.
Não houve instalação de dependências, build, Docker, ECR, deploy ou restart. A transpilação dos testes
acontece somente em memória, sem artefato de aplicação. Todos os dados novos são sintéticos.

## Conferência offline do FD

Foi feito somente `GET /api/v1/workflows/5RHLnFFEXXrAvxQb`, com sucesso HTTP 200, em 24/11/2026.
Somente o `jsCode` do nó `Extract Message` foi retido em arquivo privado 0600 em RAM.
Não foram lidas execuções, leads, conversas ou outros workflows. Credenciais ficaram em memória.
O código foi executado em sandbox sem rede ou variáveis de ambiente, com `$input` sintético e console silenciado.
Não foi publicado código de workflow ou configuração.

Payload nativo sintético plano: `instanceName` igual a `synthetic-instance`, `chatInput` textual,
`remoteJid` e `senderLid` iguais a `900000000000000000000001@lid`, `fromMe=false`, sem `data/key` aninhados.
Também foi executada a variante sem `senderLid`, correspondente ao source n8n sem o patch da receita.

| Campo de saída | Resultado |
| --- | --- |
| `sessionId` | `synthetic-instance_900000000000000000000001@lid` |
| `userId` | `synthetic-instance_900000000000000000000001@lid` |
| `remoteJid` | `900000000000000000000001@lid` |
| `senderLid` | `900000000000000000000001@lid` |
| `shouldRespond` | `true` |

Sem `senderLid` no payload, somente esse campo de saída fica vazio; as três identidades e
`shouldRespond` permanecem iguais. O nó não quebrou em nenhuma das duas variantes. Isso verifica o Extract Message, não o restante do grafo nem uma entrega e2e.
O `base-chatbot.service.ts` preserva o JID completo em `number: remoteJid.includes('@lid') ? remoteJid :
remoteJid.split('@')[0]` nos envios de mídia, áudio e texto. O serviço n8n inclui o `remoteJid` no payload.
Não se enviou mensagem. Nenhum workflow foi corrigido ou alterado.

## Receita da imagem e riscos

O brief identifica a imagem viva como oriunda da receita Elysium `b3044e8f` com `XMACNA_PATCH_*`.
Esse commit abreviado não está nos dois checkouts disponíveis e o GET GitHub de commits devolveu 422;
portanto a receita histórica e os valores dos patches não foram reconciliados nesta tarefa.

A receita versionada consultada em Elysium (`deploy/evolution-api/Dockerfile.durable-inbox`) seleciona o fork
por `EVOLUTION_REPO`, `EVOLUTION_BRANCH` e `EVOLUTION_COMMIT`; grava as revisões do source e da receita
em labels. O script `build-inbox-candidate-local.sh` passa `--source-commit` como `EVOLUTION_COMMIT`.
A mudança entra por um novo commit do fork, após revisão/integração, selecionado pela receita canônica
que o dono reconciliar. O candidato futuro deve manter os patches existentes, inclusive a exposição de
`senderLid` plano no payload n8n por `fix-sender-lid.js` (ausente no source n8n deste fork), e atestar o par source/receita antes de qualquer cutover. Estes comandos
não foram executados e esta PR não autoriza construir ou implantar a imagem.

Riscos e limites:

- Uma conversa pode começar com identidade LID e mensagens futuras passarem a PN após o alias surgir;
  sessões/memória anteriores podem ficar separadas. Não se mesclam identidades neste delta.
- O Extract Message aceita o LID; CRM, memória, tools e outros nós não tiveram prova e2e nesta tarefa.
- Entrega durável mantém a semântica existente de retry, inclusive possível duplicação quando o efeito
  externo sucede mas a confirmação/persistência falha.
- Recibos já `dead` não são revividos; nenhum replay/backfill foi feito ou autorizado.
- Alias ambíguo usa LID sem escolher um telefone; erros inesperados continuam exigindo recuperação.
- Webhook e Chatwoot conservam seus caminhos existentes; o teste foca a integração n8n durável.
- A receita histórica e a versão Node 24 ainda precisam de validação no rito de release futuro.

## CI e revisão

O commit desta entrega usa `[skip ci]` por ordem expressa de não executar build.
Os workflows de PR contra main incluem `npm run build` e CodeQL autobuild, inclusive para draft.
CI não foi executado; checks obrigatórios podem permanecer pendentes e impedir merge.
Não confundir os testes locais com CI verde. Ver a documentação oficial de
[skip workflow runs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs).
Nenhum workflow GitHub foi editado. A PR permanece draft, sem merge e sem produção.
