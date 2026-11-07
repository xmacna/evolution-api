# Proxy agent protocol parity

Canonical report; [human HTML](PROXY-CONTRACTS.html). Owner: nex-evolution-build-sol. Origin: the authorized Nex queue (`FILA-AUTORIZADA.md`, 2026-11-07) allows a reproduced test gap after issue #1064. No existing proxy test or active claim covered this utility when selected.

## Reproduced failure

`makeProxyAgentUndici` already supported HTTPS and SOCKS4, but `makeProxyAgent` rejected those protocols. The Baileys socket setup calls both factories for one proxy configuration, and `ProxyController.testProxy` uses the latter. Thus a protocol accepted by the fetch side failed locally before either could connect. The string `socks://` alias was also rejected by Undici although its object form was accepted.

Six offline tests against baseline `6b93af39399f01a17aa421b0a235d82c41c6e4c9` produced four failures and two passes. The failures were HTTPS string construction, SOCKS4 string construction, object protocol parity and the Undici string SOCKS alias. The candidate passes all six. These tests call the actual utility and installed proxy libraries; they construct and dispose agents without dispatching requests or opening listeners/sockets.

## Change

- Route HTTPS to the existing `HttpsProxyAgent`, which supports TLS proxy URLs.
- Route SOCKS4 to `SocksProxyAgent` and preserve version four in the URL passed to it.
- Normalize the Undici string `socks` alias to the existing SOCKS5 dispatcher branch.
- Preserve the existing HTTP/SOCKS5 behavior, including the socket agent's prior SOCKS5 DNS policy and encoded URL credentials. Unsupported protocols still throw.

The fix changes no dependency version, schema, credential, endpoint, proxy configuration or service. Tests use only `proxy.example.invalid` and synthetic credentials. No production proxy was contacted or configured.

## Verification

```sh
npm ci
npm run test:xmacna-proxy
npm run build
```

The existing Node 24 quality workflow now runs the focused test command before the inbox checks/build. Local targeted tests ran on Node 22.11.0 with a small isolated harness containing the pinned project proxy libraries and tsx, not a full application install. Baseline: 2 pass / 4 fail; candidate: 6 pass / 0 fail / 0 skip. Formatting checked. Full application build and Node 24 proof are delegated to that CI and must be read in the PR, not assumed in advance.

To replay the baseline, copy the new test file into a separate checkout at the baseline commit, install the lockfile there, and run `npx tsx --test --test-concurrency=1 test/xmacna-proxy-agent.test.ts`. Do not replace files in an active owner's checkout.

The proof establishes agent selection and construction, not external proxy reachability, TLS interoperability, DNS availability or a live WhatsApp connection. Independent Nex review is required; no merge or deployment is authorized by this work.
