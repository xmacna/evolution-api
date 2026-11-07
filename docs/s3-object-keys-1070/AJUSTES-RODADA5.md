# 🗂️ PR15 — quatro produtores S3 corrigidos após AJUSTES

Origem: [parecer AJUSTES](https://github.com/xmacna/evolution-api/pull/15#issuecomment-6713483817)
no SHA `6fd5c1c3528c3eb3b41e06df3030a932cce09f18`, corrigido pelo revisor no mesmo comentário
em2026-11-07T21:53:41Z, e ordem posterior do ger-nex-sol. **APROVA anterior revogado**.
Rodada5, terceiro item; gpt-6.1-sol high, sem subagentes. Branch própria da PR15 preservada.

## ✅ Resultado do caminho produtor→backend

| Matriz: quatro expressões de produção | Antes | Depois |
|---|---:|---:|
| Windows, chaves/URLs corretas | 0 / 4 | **4 / 4** |
| Linux, chaves/URLs corretas | 4 / 4 | **4 / 4** |
| Total | 4 PASS,4 FAIL | **8 PASS,0 FAIL** |

Na base, valores nativos do Windows chegavam ao backend como
`fixture-instance\fixture-jid\image\fixture.jpg`; posix.join no backend preservava
essas barras existentes. O presigner real produzia `%5C`. Era um defeito funcional
dos chamadores, apesar dos sete testes isolados e da CI Linux verdes.

## 🛠️ Correção e alcance

Três imports `join` de path passam a `posix`; quatro inicializadores `fullName` usam
`posix.join`: Meta, Evolution e Baileys recebido/enviado. Inventário dos bindings
confirma que eram os únicos usos daquele join importado e todos alimentam S3;
nenhuma operação de arquivo local foi substituída. Arrays/string `.join` permanecem iguais.
O backend já corrigido não muda. API, metadata, MIME, tamanho, nome/timestamp/id e persistência
de fullName mantêm o fluxo existente. Não há migração de objetos antigos com backslash.

`test:xmacna-inbox` inclui agora `xmacna-s3-producers.test.ts`, para que a CI exercite
o novo contrato. O teste lê os três arquivos via AST TypeScript, exige contagens1/1/2
de produtores e extrai os inicializadores reais e seus imports de path. Executa cada
expressão com `path.win32` e `path.posix` no contexto de mídia sintético, sem importar
as classes de canal ou inicializar provedores WhatsApp.

O valor resultante segue ao **backend real + S3Client/PutObjectCommand/presigner reais**.
Apenas send é falso; assinatura local com credencial fictícia. Asserts cobrem fullName,
chave, Body/ContentLength/ContentType, pathname sem `%5C`, expiração60s e assinatura.
HTTP/TCP bloqueados pelo preload offline existente; nenhuma chamada a AWS ou bucket.
As duas implementações de path foram exercitadas no host Windows; não se confunde isso
com uma execução nativa Linux, que permanece na CI.

## 🧪 Checks e preservação de prova

- **8/8 casos novos PASS**, zero skip. Baseline4 PASS/4 FAIL antes da alteração.
- Lint focado nos três serviços, typecheck completo e builds CJS/ESM: exit0,
  detalhes em [prova-rodada5.json](prova-rodada5.json) e logs brutos versionados.
- Formatação aplicada antes do verde. A prova original do backend/testes/preload/n8n
  conserva hashes LF idênticos; não foram repetidos os82 testes anteriores localmente.
  O delta dos produtores justifica novo typecheck/build e nova execução da CI no novo SHA.
- Node24.22.2, heap768MiB, BelowNormal, UV/V8/GOMAXPROCS1, lock global exclusivo,
  piso commit1,5GiB. Sem install, Prisma, DB ou mutação das dependências reutilizadas.

Reprodução com dependências instaladas, em shell com limites/recurso já reservados:

```powershell
node --require ./test/helpers/s3-offline-preload.cjs --import tsx --test --test-concurrency=1 test/xmacna-s3-producers.test.ts
```

`S3_ENABLED=false`, `AWS_EC2_METADATA_DISABLED=true` e `DATABASE_PROVIDER=postgresql`
foram definidos no runner. Comandos/versões/recursos e hashes exatos estão no manifesto.

## 🚦 Revisão e limites históricos

Os82 testes, builds e CI anteriores documentam o SHA6fd5c1c e o contrato isolado;
**não aprovam os produtores nem este novo SHA por herança**. O documento anterior
PLANO.md/.html e seu manifesto são histórico preservado; este par descreve o ajuste
completo solicitado pelo parecer. Não houve relaxamento de asserts ou troca dos produtores
por strings já normalizadas. A sonda AST cobre composição→S3, não mensagens/integrações reais.

Solicitar nova revisão independente no SHA final. CI do novo candidato será registrada
separadamente no comentário de prova, sem alterar código/repetir testes para obter verde.
Sem AWS real, credencial real, migração de objetos, serviço, cliente, PC/Nyx, merge ou deploy.
