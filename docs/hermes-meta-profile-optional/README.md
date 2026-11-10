# Meta Cloud: `contacts[0].profile.name` opcional no `messageHandle`

**Branch:** `xmacna/hermes-meta-profile-optional-20261110`, **rebaseado sobre `5955acd0eb15d9c25659f6716fe6c40dde07aa2b`**: a revisão rotulada na imagem primária `06349100…` (v2.3.7), tree `66600d43…`. O commit anterior, sobre `8692b80`, fica preservado como histórico em `preserve/hermes-meta-profile-ef4583a-20261110` (`ef4583a`). O delta S3 (#1070: `join`→`posix`) **não** entra aqui. **Estado:** correção mínima com regressão local. **Ainda sem build, imagem, canário, deploy ou E2E**, e **sem prova de que os recibos foram resolvidos**.

## Defeito
`BusinessStartupService.messageHandle` lia `received.contacts[0].profile.name` sem guarda, **antes** dos ramos `messages`/`statuses`. Um callback de status com `contacts` sem `profile`/`name` (ou com `contacts: []`) lançava `TypeError: Cannot read properties of undefined (reading 'name'|'profile')`, e o `catch` do método engolia o erro. O laço `statuses` nunca rodava, então nenhum `MessageUpdate` era gravado.

**Evidência de runtime (só leitura, coletada pelo gerente):**
- `/evolution/dist/main.js:285:774` (`messageHandle`) ← `:285:9979` (`eventHandler`), com 4× às 09:02:22 e 4× às 09:08:14 em 2026-11-10.
- Recorte estático: `if(e.contacts&&(i=e.contacts[0].profile.name),e.messages){…`. O `main.js` executado tem SHA `cfc2250474e69989bf406787c8de81220bfa2d11eeb1f610891c669db4c72422`, **diferente** do módulo separado `whatsapp.business.service.js` lido antes.

**Limites:**
- A equivalência com este fonte foi demonstrada **só para este trecho**. A equivalência da imagem/`main.js` inteira com este commit **não está comprovada**.
- A ligação com o callback de um wamid específico **não está provada**.

## Correção (1 linha)
`pushName = received.contacts?.[0]?.profile?.name;`
- Sem `contacts`/`profile`/`name`, o resultado é `undefined`, como antes. Nenhum nome é inventado; um nome válido é preservado.
- Não mudam: guardas de instância/ID, `findFirst`, enum de status, os demais ramos e a lógica de persistência. Nada é fabricado: delivered/read só vêm do `status` real.

## Regressão
```
node --experimental-transform-types --no-warnings test/xmacna-meta-profile-optional.test.mjs
```
- Requer Node ≥ 22.7, sem `node_modules`.
- Executa o `messageHandle` **de produção**: o fonte desta checkout e o baseline `5955acd` (revisão da imagem) via `git show` em memória. Só o bloco de imports vira stub (`test/helpers/meta-profile-stubs.mjs`); o corpo da classe é idêntico ao fonte, com CRLF normalizado para LF.
- **Exit 0 só se** o patched der 7 PASS / 0 FAIL **e** o baseline der exatamente 3 PASS / 4 FAIL, com os erros literais `reading 'name'`/`'profile'`.
- `META_PROFILE_PATCHED_REF=5955acd0…` serve de autoteste: sem a correção, o exit é 1. O cleanup só remove o diretório temporário criado pelo próprio teste (`os.tmpdir()/meta-profile-*`); um diretório passado por env nunca é apagado.

| Caso | Baseline 5955acd (imagem) | Com correção |
|---|---|---|
| delivered, `contacts:[{wa_id}]` sem profile | FAIL `reading 'name'` | PASS (MessageUpdate DELIVERED) |
| read, `contacts:[{wa_id}]` sem profile | FAIL `reading 'name'` | PASS (READ) |
| delivered, sem contacts | PASS | PASS |
| read, `contacts: []` | FAIL `reading 'profile'` | PASS (READ) |
| delivered, profile sem name | PASS | PASS |
| status de id desconhecido | FAIL `reading 'name'` | PASS (nenhum update) |
| entrada com `profile.name` válido | PASS (nome preservado) | PASS (nome preservado) |

Nenhuma chamada de rede (stub do axios = 0). A evidência vem de stubs e payloads sintéticos, não de PostgreSQL, do runtime ou de recibo real.

## Pendente (fora deste commit)
- Build da imagem a partir de fonte com procedência comprovada.
- Canário, revisão operacional, deploy com snapshot/rollback e E2E real.
- Observação sem correção: `received.contacts[0].profile.phone` no ramo `messages` também não tem guarda; não há causa demonstrada.
