# Mode-race evidence and failure diagnostics

Canonical; [HTML](DIAGNOSTIC.html). This is a test/diagnostic change, not a runtime correction. Origin: [independent AJUSTES on PR11](https://github.com/xmacna/evolution-api/pull/11#issuecomment-6712969805), [failing run](https://github.com/xmacna/evolution-api/actions/runs/42412475966).

The existing PostgreSQL test failed while an enforce claim and mode downgrade raced. The candidate preserves the real unwrapped repository and all assertions, and exercises 200 synthetic iterations instead of 30. Only when a claim fails, the assertion adds iteration, error code, constructor name and whether the error is an instance of the imported Prisma error class. There is no extra promise/wrapper on the success path, no skip and no acceptance of an error. Customer data, SQL parameters and credentials are not added to the diagnostic record.

## Bounded observation

An initial instrumented probe at `cd65372` wrapped claim transactions to observe caught errors. [CI 42415055387](https://github.com/xmacna/evolution-api/actions/runs/42415055387) passed all checks/build: 200 synthetic mode races and 204 caught conflicts, all `P2034`, constructor `PrismaClientKnownRequestError`, imported-class check true. This establishes that those observed errors were recognized; it does not identify the error/code at the original failure or prove the incident resolved.

That wrapper can alter promise scheduling, so it is removed from the final test. The original unwrapped path remains under the stricter 200-iteration assertion; failure diagnostics execute only after a failure. The final candidate's CI outcome is recorded in the PR, not assumed from the instrumented probe. Neither the original failed SHA nor a completed candidate run is blindly rerun to seek green.

No runtime behavior, retry budget, serialization/fencing or tenant scope is changed. Root cause is not yet established; do not infer that the retry budget or proxy code is the cause. The existing quality CI provisions its own disposable PostgreSQL fixture. No local database, Docker/WSL service, customer source, migration or production operation is requested.

The proxy PR11 remains blocked on the documented integration/build acceptance; a green diagnostic branch without the proxy delta does not approve it. The remaining diagnostic task is to capture an actual failure on the unwrapped path and turn its code/provenance/interleaving into a deterministic regression before changing runtime policy. Independent review is requested for the final test-only candidate; no merge/deploy or runtime fix is claimed here.
