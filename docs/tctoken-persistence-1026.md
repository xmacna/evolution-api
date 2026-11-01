# Persistência do TC token após o commit do envio

Desdobramento de [xmacna/elysium#1026](https://github.com/xmacna/elysium/issues/1026). Candidato local de correção, sem deploy, imagem publicada ou canário com conta WhatsApp.

Quando a emissão assíncrona de TC token recebe a resposta depois do commit do envio, a promise ainda pode carregar o AsyncLocalStorage daquela transação. O `keys.set` original altera o buffer encerrado e não chega ao armazenamento/cache subjacentes. O erro foi reproduzido com o rc14 original usando módulos reais, cache real e armazenamento persistente.

## Correção

`Docker/scripts/patch-baileys-tctoken.cjs` modifica apenas três arquivos do `baileys@7.0.0-rc14`: função de transação, callback de resposta da emissão e declaração de tipos. Ele verifica integralmente os bytes auditados antes de modificar qualquer arquivo; recusa outra versão, drift e marker falso. Reaplicar é idempotente. Não acessa auth-state, segredos, serviço ou rede.

A função adicional `transactionIsolated` sai do contexto herdado com `txStorage.exit` e abre uma transação nova. Somente o callback de persistência do IQ usa essa função. A operação de rede continua desacoplada, depois do envio, e fora do mutex de envio; não foi introduzida espera de cinco segundos ou busca de token antes da mensagem.

A transação da resposta usa **o mesmo proprietário `meId` que a transação do envio**. Dessa forma, uma resposta rápida espera o commit anterior e lê estado fresco. Um mutex de nome diferente permitia que a limpeza de token vencido do envio sobrescrevesse um token recém-gravado; a regressão inclui esse caso. As chamadas simultâneas da mesma sessão também preservam o índice compartilhado de tokens. Transações normais e aninhadas mantêm o comportamento anterior.

O controle em voo permanece ativo até o commit da resposta terminar, e o catch/finally originais continuam liberando-o em caso de falha. Não se alteraram seleção de destinatário, política de emissão, stanza, receipt, guard de grupo/protocol/peer, retry, timeout de rede ou comportamento de reconexão.

## Instalação em checkout de desenvolvimento

Usar Node 24 e o lockfile existente:

```sh
npm ci
npm run patch:xmacna-tctoken
npm run verify:xmacna-tctoken
npm run test:xmacna-tctoken
```

O teste Redis é ativado por `XMACNA_TCTOKEN_REDIS_URL=redis://127.0.0.1:16782`. Usar somente um Redis local de teste. A suíte exige loopback e porta dedicada, usa chave sintética própria e a remove ao final; não faz FLUSHDB. Sem a variável, somente o caso Redis é pulado, explicitamente. A validação desta entrega executou **todos os dez testes, sem skips**. O workflow de qualidade passa a fornecer o Redis isolado e executar instalação, verificação e regressões.

O Dockerfile canônico aplica o patch no builder, depois de npm ci. Uma reinstalação de dependências fora desse Dockerfile exige reaplicá-lo. Não se adicionou postinstall nem modificação automática do serviço vivo. Outras receitas de imagem precisam incorporar a mesma etapa explicitamente; este candidato não substitui o inventário dos demais patches da release implantada.

## Testes e limites

- Rc14 original: sete testes comportamentais executados, quatro falhas que demonstram o defeito, nenhum skip.
- Candidato: sete testes comportamentais e três de instalação/verificação, todos aprovados, nenhum skip.
- Casos: token frio, resposta após commit, recriação de provider/cache, 16 respostas concorrentes e índice completo, token mais novo preservado, erro de IQ e nova tentativa, resposta rápida contra limpeza antiga, rollback aninhado e Redis real.
- Armazenamento: provider de arquivos do Baileys; `useMultiFileAuthStatePrisma` da Evolution no caminho de chaves Redis, com CacheService e RedisCache reais. As quatro implementações de provider/cache comparadas são iguais às fontes extraídas da imagem principal implantada.
- Somente o transporte IQ e o repositório inicial de credenciais são fixtures. A importação de server.module é substituída no teste para não iniciar servidor nem carregar conexões do aplicativo. As chaves TC percorrem os serializers, cache e Redis reais; não há banco de credenciais real no ensaio.
- Node v24.22.2, Redis 7.4.12 local, Windows/WSL. A produção principal observada usa Node v24.19.0 em ARM64; não foi construído/testado um contêiner ARM64 nesta missão.
- Compatibilidade existente: 14 testes aprovados; tsc --noEmit aprovado. Um import de teste existente foi tornado portátil com pathToFileURL, após falhar pelo caminho Windows.

As provas locais RED/GREEN e a auditoria de logouts estão no diretório interno `argos/.local/evolution-versao-20261029/seguimento-1026/`. Não foram incluídos dados de cliente ou registros de produção neste repositório.

Esse resultado demonstra persistência no ensaio, não entrega real de WhatsApp nem causa ou solução de banimento. Canário com número, validação ARM64, comparação dos demais patches e decisão de release continuam com Argos/Lucca.

Regra de Argos de 29/10/2026 22:41 UTC, até segunda ordem: agentes não pareiam, desconectam, fazem logout ou leem QR de instância por script ou Manager. Pareamento somente por uma pessoa pelo Partenon, com Vesper avisado antes. Uma futura aprovação de canário não dispensa essa regra. Os testes descritos aqui usam dados sintéticos e permanecem offline.

## Retorno

O patch não muda schema nem formato dos registros. No desenvolvimento, uma reinstalação limpa pelo lockfile restaura os arquivos originais; no futuro rollout autorizado, o retorno é à imagem/bundle anterior fixado, preservando os dados criados depois da virada. Não apagar auth-state nem restaurar chaves Signal antigas para desfazer somente código.
