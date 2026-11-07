# Status ACK in the main build — issue #1064

Canonical document; [human HTML render](BUILD.html). Owner: nex-evolution-build-sol. Code review requested from Rafael (`raffareis`) and the independent Nex reviewer. Related: [elysium#1064](https://github.com/xmacna/elysium/issues/1064), [#1047](https://github.com/xmacna/elysium/issues/1047), [reviewed PR #9](https://github.com/xmacna/evolution-api/pull/9#pullrequestreview-5809084909).

## Scope and provenance

The main Dockerfile previously installed rc14 without the Status stanza patch. It now runs the offline differential verification after `npm ci`, applies the patch, and copies those patched dependencies into the final stage. The existing quality CI performs the same verification and application before the application checks/build. There is no postinstall hook: ordinary dependency installation remains separate from explicitly patching it.

`Docker/status-ack/source.json` records the npm URL, lockfile SHA512 integrity, three source SHA256 values and the exact transformed output hash. The patch transformation comes from PR #9, commit `17183c7200adb4207096ef726d8b120ba4b9ceb4`; its output bytes are unchanged. No code from the separate interactiveResponseMessage work is included. The PR #9 branch is untouched.

| Input/output | Pin |
| --- | --- |
| Package | `baileys@7.0.0-rc14` |
| Source | `https://registry.npmjs.org/baileys/-/baileys-7.0.0-rc14.tgz` |
| Archive SHA256 observed locally | `2eb4579d9594ff3b55359bcf5685e19f034bfd77e49da3a7d158474167791869` |
| Original messages-recv.js SHA256 | `850445e6f9e076b1beb98034cbc5cf79562dfda26a44f5a874a84e3609bfd710` |
| Patched messages-recv.js SHA256 | `4537c82638a21a37f96ec2d03e58391cf42d6d3ed01d1930bf440563b5bf4a40` |

The patch refuses a different package identity, modified source/queue/ACK-builder bytes, missing/duplicate anchors, repeated application or changed output bytes before writing. Updating Baileys requires another source/patch review; it must never silently skip this guard. The baseline runner checks the package and lockfile pins and requires exactly the four expected Status failures, then six candidate passes, with no cancellations/skips.

The patch is reproducible from git and the locked npm source. Whole-image byte reproducibility is not established: the existing Node/Alpine tags and apk repository inputs remain mutable. No registry digest or local image identity is invented here.

## Reproduce the offline proof without installing application dependencies

Use Node 24 (the project runtime) and Python 3. The preparer downloads only the approximately 1 MB npm archive, verifies its SHA512 against the lockfile/pins and extracts four explicitly selected regular files. It runs no install scripts, imports no application module and refuses an existing destination.

```powershell
# Run in the checkout; choose a NEW path outside it.
python Docker/status-ack/prepare-source.py C:/Temp/evolution-rc14-proof
$env:BAILEYS_AUDITED_ROOT = 'C:/Temp/evolution-rc14-proof'
npm run test:status-ack
```

To prepare with an already cached archive and no network:

```powershell
python Docker/status-ack/prepare-source.py C:/Temp/evolution-rc14-cached --archive C:/Temp/baileys-7.0.0-rc14.tgz
$env:BAILEYS_AUDITED_ROOT = 'C:/Temp/evolution-rc14-cached'
npm run test:status-ack
```

On POSIX, set `BAILEYS_AUDITED_ROOT=/tmp/evolution-rc14-proof npm run test:status-ack` after running the Python preparer with that new path. Once the audited files exist, `npm run test:status-ack` makes no network requests. Tests import the actual npm ACK builder and offline processor, and execute the actual routing/ACK code with socket I/O stubbed. They do not open sessions, start Evolution, connect to a database or send WhatsApp traffic. Temporary patch-CLI checks leave the audited source unchanged.

The runner prints TAP for the intentional failing baseline and then validates the expected failure set. Its final exit is zero only if baseline, candidate, guard and evidence checks all match. Look for the final `STATUS_ACK_PROOF` JSON line; a stray failing subprocess is not accepted as a successful baseline.

## Build from the checkout

Normal CI/build path, on a fresh install:

```sh
npm ci
npm run test:status-ack
npm run patch:status-ack
DATABASE_PROVIDER=postgresql npm run db:generate
npm run build
```

Remove an external `BAILEYS_AUDITED_ROOT` override when checking the installed dependency. Repeated application intentionally fails; use a fresh `npm ci` when rebuilding the dependency tree. Applying the patch explicitly is required for non-Docker application builds.

On an already provisioned Docker host, from a clean checkout of this PR commit:

```sh
docker build --progress=plain --tag evolution-status-ack:local-review .
docker run --rm --network none --entrypoint node evolution-status-ack:local-review \
  -e "const fs=require('node:fs'),c=require('node:crypto');const h=c.createHash('sha256').update(fs.readFileSync('node_modules/baileys/lib/Socket/messages-recv.js')).digest('hex');console.log(h);if(h!=='4537c82638a21a37f96ec2d03e58391cf42d6d3ed01d1930bf440563b5bf4a40')process.exit(1)"
```

The readback overrides the image entrypoint and uses no network or volume. It does not start Evolution or database migration. Build acquisition needs network for locked packages and the pre-existing OS/base inputs. Do not push an image or run the normal application entrypoint under this mandate. On Nex any heavy build must first acquire the manager's exclusive `heavy-build.lock` and confirm at least 1.5 GiB free commit; this recipe is not an automated lock bypass.

## Test corrections and boundary policy

The two offline queue tests now subscribe to completion of their following message before enqueuing it. There is no fixed sleep; a 5-second test deadline detects a stranded queue. The ignored-JID recovery case checks exactly one successful ACK, its `ignored-ok` ID and absence of an error attribute.

`canary-evidence.cjs` accepts the manifest field `webhookBoundaryToleranceMs` only as an integer from 0 to 60000; omitted means zero. This bounded policy is proposed for review, not an operational approval. A new incoming event must belong to its cycle `[start, end)`; only webhook completion may extend to `end + tolerance` inclusive. The ten-minute incoming-to-webhook limit, cycle duration/continuity, unique IDs, real Status/ACK counters, error counters, retained logs and isolation/consent requirements still apply. A delivery exactly at `end` needs no grace. An event at `end` belongs to the following cycle.

Every delivery past its cycle end is exposed in `boundaryDeliveries` with cycle, message ID hash and delay, including rejected late deliveries. The effective tolerance is returned. Missing evidence does not become a success: empty pairs, ID reuse, delivery beyond the declared grace, reversed clocks or an over-ten-minute delivery yield HOLD. The evaluator checks supplied metadata and cannot discover omitted traffic by itself; reviewers must read the retained logs and nominated probe IDs.

The image allowlist remains the historically reviewed PR #9 canary image. A newly built main image is not automatically approved by this evaluator. Its real identity/digest and evidence need the owner's review before updating that policy.

## Evidence and remaining acceptance criteria

Local first-round proof on Windows/Node `v22.11.0` (Node 24 CI result must be checked separately):

| Check | Result |
| --- | --- |
| Official archive / lockfile SHA512 / three file SHA256s | PASS |
| Baseline Status seam | 2 pass / 4 expected failures |
| Patched Status seam | 6 pass / 0 skip |
| Patch CLI / drift guards | 8 pass |
| Evidence evaluator | 15 pass, including 7 new boundary-policy cases |
| Disposable CLI application / patched file syntax | PASS |
| Source preparer: good archive, bad integrity, overwrite refusal | PASS |
| Local Docker image build | NOT RUN: Docker executable unavailable |
| Full local application build | NOT RUN: application dependencies absent; delegated to existing Node 24 CI |
| Registry digest / actual canary | PENDING owner/Vesper |

Two new policy tests failed against the previous evaluator before its correction. All tests use synthetic I/O/evidence. The final PR conversation records the tested commit and CI evidence; this document does not assert a CI outcome in advance.

Issue #1064 must remain open until a reviewed image has a real registry digest and the isolated canary satisfies the operational criteria: baseline `ack class=status` failure on the same internal number, followed by at least four contiguous 50-minute cycles / 200 minutes on the candidate with real Status ACKs and continuing inbound/webhook delivery. Rafael's review and Vesper's GO remain required. Registry publication, actual canary, rollout and the 24-hour production watch are outside this code/testing task.
