# Pacote de revisão — ACK de Status

Para Rafael (@raffareis), PR xmacna/evolution-api#9. Dono operacional Infra; autorização de rollout Vesper. Este pacote prepara o ensaio; nenhum canário, telefone ou produção foi iniciado por ele.

## O que revisar

1. `patch.cjs`: hash exato do rc14, unicidade das âncoras, handler de Status e roteamento na fila offline. Rejeitar drift/patch repetido, sem fallback por conveniência.
2. `test.cjs`: seis provas existentes contra o builder/fila reais; quatro falham no baseline. São testes de código com I/O simulado, não ciclos WhatsApp.
3. `Dockerfile`: só camada sobre base imutável já auditada, sem pacote novo ou Dockerfile de produção. A imagem isolada já foi construída no servidor; [proveniência e IDs](README.md). Não reconstruir no PC durante VR.
4. `canary-evidence.cjs`: oito testes pequenos novos. O avaliador só confere metadados declarados; nunca sobe container, acessa API, pareia, envia ou concede rollout. Mesmo o resultado READY_FOR_REVIEW exige ler os logs e receber a revisão/decisão humanas.

## Pré-condições do ensaio real

- Vesper/Rafael indicam número/aparelho INTERNO, custódia e consentimento para mensagens/Status. Teste Fim e Mari estavam close na prova anterior; não repetir busca nem parear por hipótese.
- Um executor e uma VM de ensaio. O container do cliente não é reaproveitado. Banco, volumes, porta e receptor de webhook são próprios; não copiar sessão/auth de cliente, produção, filas ou `.env` vivo.
- A máquina de ensaio deve receber a imagem pelo caminho de artefato aprovado e conferir o ID. Nome sugerido `evo-ack-status-canary-20261106`; deduplicar esse alvo antes de criar. Não há container desse nome criado nesta entrega.
- Receiver de webhook apenas interno de teste, com relógio UTC. As entradas devem ter marcador/ID novo e consentido, sem contato de cliente. Dados e telefones só nos arquivos privados.
- Snapshot e registro de identidade do container/volume/base próprios antes da ação. Sem autorização e custódia, estado é AGUARDA, não tentativa automática.

## Matriz de aceitação

| Caso | Prova necessária | Falha/limite |
|---|---|---|
| Status online | Stanza real recebida e ACK sem NACK/class=status | Zero erros sem receber Status não vale |
| Status offline/ordem | ACK e mensagem posterior sem fila presa; logs/ordem preservados | Unidade já cobre mecanismo; canário precisa tráfego real |
| Recepção | Entrada nova por ID/hash e callback no receptor interno em até10min | Não confundir com resposta final de bot |
| Quatro ciclos | Pelo menos4 intervalos contíguos de50min, Status e entrada em cada | Menos de200min ou período sem amostra fica incompleto |
| Regressão | Zero stream/status errors e reconexões nos ciclos declarados | UNKNOWN não vira zero |
| Isolamento | Imagem certa, volume próprio, logs retidos por hash, produção intacta | Divergência bloqueia a conclusão |

Cada ciclo precisa de UTC de início/fim, contadores explícitos, log locator/SHA e pares `messageIdHash`, `evolutionAt`, `webhookAt`. `messageIdHash` deve ser novo por ciclo. O hash deve ser calculado no servidor sobre o recorte sanitizado fechado, não no F: nem em logs gigantes do PC. O avaliador não autentica o arquivo só por receber uma string SHA; Rafael confere a prova real.

CLI offline de revisão: `node Docker/status-ack/canary-evidence.cjs < manifesto-sanitizado.json` em shell que suporte redirecionamento. No PowerShell: `Get-Content -Raw -LiteralPath '<manifesto>' | node Docker/status-ack/canary-evidence.cjs`. Exit2=HOLD, exit0=metadados completos para revisão, nunca autorização de deploy. Fixtures nos testes são sintéticas e não são quatro ciclos reais.

## Interromper e reverter

Qualquer erro de Status, queda ou perda do par esperado: registrar UTC/contadores/logs e parar somente o canário identificado, preservando volume e logs. Conferir ID/nome do alvo antes de `docker stop`; nunca usar comandos globais ou container de cliente. Retorno à base imutável apenas com o mesmo volume próprio e decisão do dono do teste. Não gerar QR repetidamente para tentar salvar o resultado.

Não há rollback de produção a executar: produção não foi alterada. Rollout futuro exige Rafael revisar, Vesper aprovar, snapshot/rollback/readback e vigia próprios. A imagem de ACK não comprova resolver a surdez específica da Lia nem o pool #1048.

## Estado atual

Imagem e testes mecânicos prontos; canário real AGUARDA custódia do teste e revisão Rafael. Nenhum ciclo real novo. A ferramenta deve retornar HOLD para o manifesto atual vazio, sem substituir a evidência ausente por fixtures. O próximo evento é a indicação do teste interno ou o parecer do revisor; o restante da Infra segue em outros itens leves.
