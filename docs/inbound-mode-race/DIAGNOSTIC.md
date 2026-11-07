# Mode-race diagnostic candidate

Canonical; [HTML](DIAGNOSTIC.html). This is an incomplete diagnostic draft, not a release-ready correction. Origin: [independent AJUSTES on PR11](https://github.com/xmacna/evolution-api/pull/11#issuecomment-6712969805), [failing run](https://github.com/xmacna/evolution-api/actions/runs/42412475966).

The existing PostgreSQL test failed while an enforce claim and mode downgrade raced. Its assertion must remain intact. The diagnostic patch records only error code, constructor name and whether it is an instance of the imported Prisma error class; it rethrows the original error. It exercises 200 synthetic iterations instead of 30 to improve the observation rate. Customer data, SQL parameters and credentials are not added to the diagnostic record.

No runtime behavior is changed at this stage. Root cause is not yet established; do not infer that the retry budget or proxy code is the cause. The existing quality CI provisions its own disposable PostgreSQL fixture. No local database, Docker/WSL service, customer source, migration or production operation is requested.

Next evidence: inspect the diagnostic run once it completes, turn the actual failure into a deterministic regression at the correct seam, then apply the smallest supported correction and obtain build evidence. Do not skip the test, weaken the assertion or blindly rerun the same SHA for a green result. Independent review is requested only for the final candidate.
