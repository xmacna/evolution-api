# 🗂️ Plano e prova — S3 independente da plataforma (#1070)

**Estado:** correção implementada e verificada localmente; revisão independente pendente.
Terceira entrega da rodada 4 de nex-serie-trilha-sol, gpt-6.1-sol high, sem subagentes.
Origem: [Elysium #1070](https://github.com/xmacna/elysium/issues/1070), FILA-AUTORIZADA/Pauta 3.
O fork Evolution tem issues desativadas. Branch `nex/s3-object-keys-1070-20261107`,
clone próprio `evolution-s3-1070-nex`, base main `6b93af39399f01a17aa421b0a235d82c41c6e4c9`.
PRs/task-claims conferidos antes da reserva; sem duplicar os donos de #1061/#244.

## ✅ Critério e resultado

- [x] Reproduzir as quatro falhas de chave S3 no Windows, cliente falso e assinatura local.
- [x] Usar separador `/` em upload, temporário, URL assinada e exclusão, preservando Linux.
- [x] Preservar metadata, ContentLength, expiração, disabled e retorno de erros.
- [x] Inbox 82/82, lint do arquivo após correção de EOL, typecheck e builds CJS/ESM.
- [x] Prova remota MD/HTML e manifesto no SHA final; solicitação de revisão na fila Nex.
- [ ] Revisão independente no SHA final; nenhuma autoaprovação, merge ou deploy.

## 🔎 Diagnóstico e correção

O backend usava `path.join`, cujo separador é nativo do sistema. No Windows,
`evolution-api` + `inst/audio/x.ogg` produzia `evolution-api\inst\audio\x.ogg`.
O problema já existia no `PutObjectCommand`, antes de qualquer chamada/assinatura AWS.

| Hipótese | Previsão e evidência |
|---|---|
| 1. Composição nativa da chave | `path.join` introduz barras invertidas; o probe nativo/POSIX confirmou os quatro casos. |
| 2. Codificação do SDK | Não explica as três falhas que já aparecem no comando falso antes da assinatura. |
| 3. Entrada alterada pelo chamador | Os testes fornecem `a`, `y.bin` e paths com `/`; o separador surge ao juntar os segmentos. |

Troca mínima no backend: `path.posix.join` nos quatro pontos. Nenhum outro
comportamento de storage foi alterado. O conjunto S3 existente já captura o
bug nesta plataforma: baseline **3/7**, com quatro diferenças de separador;
candidato **7/7** dentro dos 82 testes da inbox. O arquivo S3 de testes conserva
o mesmo hash LF entre baseline e candidato; não se enfraqueceram assertivas.

| Operação | Baseline Windows | Candidato |
|---|---|---|
| Upload | `evolution-api\inst\audio\x.ogg` | `evolution-api/inst/audio/x.ogg` |
| Temporário | `tmp\y.bin` | `tmp/y.bin` |
| Exclusão | `evolution-api\a` | `evolution-api/a` |
| URL assinada | `/evolution-api%5Cinst%5Cimg.jpg` | `/evolution-api/inst/img.jpg` |

## 🧪 Prova e isolamento

Node **v24.22.2** no Nex/Windows; o Node padrão 22 não foi usado nos checks.
O lockfile local é idêntico ao das dependências já instaladas; node_modules é
uma junction somente de leitura operacional para reutilizá-las. Nenhum npm ci,
Prisma generate, install hook, servidor ou migração foi executado.

O teste S3 importa uma exceção que, por ciclo de imports, carregaria o roteador
e provedores WhatsApp. `test/helpers/s3-offline-preload.cjs` entrega **somente o
HttpStatus lido do enum real** a esses módulos de exceção. Mantém reais backend,
SDK, ConfigService, Logger e as classes de exceção. HTTP/TCP são bloqueados;
só o pipe local exato de IPC do tsx no Windows é permitido. Uma tentativa de
rede inesperada falha o processo. A prova final da inbox não contém bloqueios
de rede nem rejeições assíncronas.

O gate completo revelou ainda uma fixture existente que fazia `import()` de
um path Windows. Ela agora usa `pathToFileURL(outfile).href`; os mocks e
assertivas do serviço n8n permanecem iguais. É uma correção do transporte da
fixture, sem mudança produtiva no n8n.

| Check final | Exit | Tempo |
|---|---:|---:|
| inbox | 0 | 10.14 s |
| lint-target | 0 | 135.45 s |
| typecheck | 0 | 16.42 s |
| build-cjs | 0 | 40.50 s |
| build-esm | 0 | 17.55 s |

O lint geral inicial apontou sete erros **somente no arquivo S3 alterado**,
por EOL misto. Após normalização, o lint focado passou. Não se repetiu o scan
dos demais arquivos. O hash normalizado LF e o JavaScript CommonJS compilado
permaneceram idênticos após a formatação, preservando a prova 82/82 já obtida.
Typecheck e builds usam o arquivo final. Nenhum teste verde foi repetido por espera.

O ESM encerrou inicialmente com status nativo Windows `3221226505`, sem erro
TypeScript. Somente essa etapa foi repetida, retirando o preload de testes do
processo de build; passou em 17.55 s.
Fonte, fixture e heap permaneceram iguais. Isso não prova a causa do erro
nativo; a tentativa anterior está preservada no manifesto/log. As demais
etapas verdes não foram repetidas. O preload não é requisito do build.

Reserva inicial da etapa final: 2.174 GiB,
BelowNormal, heap 768 MiB, V8 pool/UV threadpool/GOMAXPROCS em 1.
Lock global exclusivo, adquirido antes dos processos e liberado ao concluir.
Builds por formato em série, conforme limite de memória deste Nex; saída local
em dist, fora do commit. Os checks PostgreSQL e compatibilidade com servidores
HTTP sintéticos não foram executados localmente; o workflow existente os cobre
no CI. CI remota ainda não atestada neste relatório.

[Manifesto JSON](prova.json) contém ambiente, comandos, tempos, hashes de fonte,
teste e logs. [Baseline TAP](evidence/s3-red-v3-s3-baseline.tap) ·
[Inbox final TAP](evidence/s3-green-v2-inbox.tap). Os logs são
fixtures sintéticas; não há credencial ou objeto de cliente.

## 🔁 Reprodução limitada

Com Node24, dependências do lockfile e lock global/reserva antes dos comandos:

```powershell
$env:NODE_OPTIONS='--max-old-space-size=768 --v8-pool-size=1 --require=./test/helpers/s3-offline-preload.cjs'
$env:S3_ENABLED='false'
$env:TELEMETRY_ENABLED='false'
$env:SENTRY_DSN=''
$env:DATABASE_PROVIDER='postgresql'
$env:GOMAXPROCS='1'
$env:UV_THREADPOOL_SIZE='1'
$files = (((Get-Content package.json -Raw | ConvertFrom-Json).scripts.'test:xmacna-inbox' -split ' ') | Select-Object -Skip 2)
node node_modules/tsx/dist/cli.mjs --test --test-reporter=tap --test-concurrency=1 @files
node node_modules/eslint/bin/eslint.js src/api/integrations/storage/s3/libs/minio.server.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/tsup/dist/cli-default.js --format cjs
$env:NODE_OPTIONS='--max-old-space-size=768 --v8-pool-size=1'
node node_modules/tsup/dist/cli-default.js --format esm --no-clean
```

O preload é um executor offline de teste para Windows, não uma configuração de
produção. O CI existente executa suas próprias fixtures em Linux; os workflows
inspecionados fazem qualidade/segurança, sem rito de release ou deploy.
Não rerodar os mesmos checks sem mudança, novo achado ou outra plataforma necessária.

## 🧭 Impacto e limites

Sem migração de banco. Chaves Linux preservadas. Objetos anteriormente gravados
no Windows com barras invertidas não são migrados por esta PR. Nenhum bucket,
AWS, canário, app, bot, cliente, serviço, produção, merge ou deploy foi operado.
A revisão independente avalia este SHA, sem herdar aprovações de outras PRs.

## ➡️ Próximo item concreto — outra rodada

[Elysium #640](https://github.com/xmacna/elysium/issues/640), código em Olympus:
`projetos/services/src/cache/redis-client-manager.ts` ainda desconecta e recria
o cliente imediatamente dentro do handler de erro na main inspecionada.
Sem PR de correção correspondente; posse futura reservada em task-claims:
`olympus-redis-640-nex`, branch `nex/redis-error-backoff-640-20261107`.

Pronto: Redis/logger/relógio falsos, 60 s simulados sem recriar clientes em loop
e com ≤10 logs; retry com teto e opções explícitas preservadas; combined.log
limitado; checks pertinentes e PR MD/HTML. Sem Redis real, im-gateway, serviço,
configurações privadas, Prumo/Nyx ou deploy. Não iniciar quarta entrega nesta rodada.
Origem: FILA/Pauta3 e issue640 aberta. A #537 já pertence ao nex-skills-sol e
foi entregue na PR1075; a leitura de inventário local não virou implementação.
