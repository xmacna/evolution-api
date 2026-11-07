# Await instance deletion before reporting success

Canonical report; [human HTML](DELETE-COMPLETION.html). Owner: nex-evolution-build-sol. Origin: [elysium#244](https://github.com/xmacna/elysium/issues/244), authorized Nex queue and PAUTA 3. This is the upstream Evolution completion contract; Partenon polling/retry/recovery remains a separate task and the issue must stay open.

## Reproduction and change

The DELETE controller used synchronous `emit('remove.instance')`. The monitor's asynchronous listener then launched both cleanup promises without awaiting them, removed the in-memory entry and logged REMOVED while the persistent name could still exist. A following create could race that deletion, as described in #244.

The controller now awaits `emitAsync`. The listener awaits session/cache cleanup, then the existing persistent-store cleanup, before removing the in-memory entry and logging success. Cleanup failures propagate to the controller's existing error response; they do not produce a successful DELETE. Cleanup still uses the existing per-instance methods and scoping. No schema change, new deletion path, retry loop, background job or auto-restart is introduced.

## Offline proof

The test compiles the entire actual controller and monitor classes using the project's TypeScript compiler and exercises them together with the actual EventEmitter2 implementation. It substitutes external imports and injects cleanup promises. Real process/filesystem cleanup is forbidden by throwing stubs. No database, auth store, WhatsApp session, proxy, listener or network request is opened. Deferred promises control completion; no sleeps or service timing are used.

The six initial regression cases failed on baseline `6b93af39399f01a17aa421b0a235d82c41c6e4c9`. The candidate passes seven cases, including added open/connecting logout ordering:

| Contract | Expected result |
| --- | --- |
| Persistent cleanup still running | DELETE promise remains pending |
| Session/cache cleanup still running | Persistent deletion has not started |
| Persistent deletion still running | Live registry entry remains present |
| Persistent cleanup rejects | DELETE rejects; target/other registry entries retained |
| Success | Both cleanup stages once, target removed, other instance unchanged |
| Session cleanup rejects | Awaiting removal rejects, store cleanup not started |
| Open/connecting request | Existing logout finishes before removal stages |

```sh
npm ci
npm run test:xmacna-instance-delete
npm run build
```

The targeted local run used Node 22.11.0 with a small isolated TypeScript/EventEmitter2 harness. The Node 24 quality workflow runs this test before the existing inbox tests and build. Its outcome must be read from the PR; no CI success is asserted in advance. To reproduce the six baseline failures, copy those six tests into a separate baseline checkout with its locked dependencies; never change an active owner's files.

## Limits and operational acceptance

Awaiting real cleanup increases request latency to include its actual duration. Existing database/webhook/provider timeouts still govern that duration; this patch does not guarantee a ten-second bound or atomic rollback if a cleanup stage partially completes before failing. External-client timeouts need the Partenon polling/recovery path described in #244. Background callers using synchronous `emit` do not acquire this API completion guarantee.

The tests substitute cleanup I/O; they prove orchestration/error propagation, not real provider, filesystem or database deletion. Concurrent logout/connection events and a real migration still require integration/canary review by the owner. No production deletion or migration was performed. Independent Nex and Rafael review, publication/deployment authority and real environment readback remain separate. The issue is not closed by this upstream candidate.
