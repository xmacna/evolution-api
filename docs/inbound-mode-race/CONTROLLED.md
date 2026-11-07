# Controlled PostgreSQL mode-race diagnosis

Origin: [PR11 AJUSTES](https://github.com/xmacna/evolution-api/pull/11#issuecomment-6712969805), following the [limited PR14 diagnostic](https://github.com/xmacna/evolution-api/pull/14). The original run failed while creating an inbound receipt, but its assertion retained only the error string, not the Prisma code, constructor identity or attempt number. The original CI artifact was read without requesting a rerun.

## Questions and hypotheses

1. A real conflict might have a code/constructor identity that the runtime classifier does not recognize. Prediction: the controlled failed transaction records a code other than P2034 or `instanceof` false, and claim rejects before retry.
2. All eight retries might be exhausted. Prediction: the failing role reaches attempt eight with real transaction conflicts, rather than rejecting the first recognized conflict. Two controlled single-transition cases cannot establish or exclude sustained multi-writer contention.
3. The first stale snapshot is handled as intended. Prediction: the loser produces exactly one recognized native P2034, retries, then either bypasses off mode or blocks the downgrade on the committed receipt. This result would refute hypothesis1 only for these two interleavings, not diagnose the original run.

## Deterministic fixture

Two new cases run the actual `PrismaInboundInbox.claim` and `transitionInboundMode` against the existing disposable PostgreSQL16 CI service, preserving Serializable transaction options, eight retries, all original assertions and runtime source bytes.

- Both first snapshots are acquired: claim reads enforce; downgrade reads enforce and an empty incomplete-receipt count.
- Claim-first: release claim and wait for its committed receipt, then release downgrade. The downgrade must encounter the actual database conflict and retry into the blocked-mode error.
- Downgrade-first: release downgrade and wait for off to commit, then release claim. The claim must encounter the actual database conflict and retry into off-mode bypass, without creating a receipt.

Only the dedicated test repositories wrap transactions. The wrappers gate after actual first reads, record the exact thrown error and rethrow the same object. They never synthesize a conflict, replace SQL/results, relax isolation, change timeout/retry options or instrument the existing stochastic test. Promise barriers have bounded failure deadlines and unconditional release/settlement before deleting only the synthetic instance's rows. No timing sleep chooses the winner. The original test remains unchanged, including its claim-must-not-throw assertion.

The test requires exactly one native P2034 from the losing role at attempt1, recognized by Prisma identity, and exactly two attempts for that role. Structured `[mode-race-interleaving]` diagnostics publish role, attempt, code, constructor and instanceof. These are permanent bounded test evidence, not runtime logs.

## Execution and scope

```sh
npm run test:xmacna-inbox:postgres
npm run build
```

The package script includes the new file after the two existing PostgreSQL test files with `--test-concurrency=1`. CI was inspected: PR quality uses an ephemeral PostgreSQL service/schema, Node24, lint/unit/integration/build; security performs static analysis. No release/deploy workflow is invoked.

## Observed result and bounded conclusion

[Quality run42417452433](https://github.com/xmacna/evolution-api/actions/runs/42417452433), source commit `6538a080e9ceed5547648f8a6310013080e90cbf`: full quality/PG/build PASS, including both controlled cases. Claim-first produced one native P2034 from downgrade attempt1, recognized by `PrismaClientKnownRequestError` identity; attempt2 raised the expected `InboundModeTransitionBlockedError` with one incomplete receipt. Claim used one attempt, downgrade two. Downgrade-first produced one native recognized P2034 from claim attempt1; claim attempt2 bypassed off mode with dispatch preserved and zero receipts. Downgrade used one attempt, claim two.

Hypothesis1 was not observed in these interleavings. Hypothesis2 (eight attempts exhausted under other contention) is not established or excluded. Hypothesis3 matches the measured cases. The original PR11 rejection remains **unreproduced and unexplained**; these results do not fix or approve PR11. No runtime change is justified by them. The old test and runtime are byte-identical to the base. Final documentation-only commit/check results and independent review requests are recorded in PR comments; no same-SHA CI rerun was requested.

## Additional bounded exhaustion experiment

A third fixture now tests hypothesis2 directly. After each real claim snapshot it commits actual off/enforce transitions before allowing the stale claim to insert a receipt. Eight such ordered cycles can exercise the unchanged eight-attempt boundary. No conflict/error is injected, retries are not shortened and the original single-race must-not-throw test remains untouched. This experiment explicitly models repeated mode changes, not the original single downgrade. Its native error provenance, outcomes and limits are published in the final PR proof after execution; they are not inferred from the two passing cases above. Even a matching escaped P2034 would show a possible exhaustion mechanism, not prove the cause of the old CI artifact.

No runtime, schema, isolation, retry, tenant scope or dependency change. No local PostgreSQL/Docker or real account/service/customer access. This is Evolution inbox work, independent of Partenon#1066. A passing controlled test does not retroactively approve PR11 or transfer a build from another SHA. If the original exception is not reproduced, retain that limitation and continue independent executable work.

[HTML](CONTROLLED.html) · [Plan](../../plans/nex-evolution/PLANO.md) · [Plan HTML](../../plans/nex-evolution/PLANO.html).
