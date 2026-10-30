# Runtime dependency security

The Node 24 runtime retains Baileys `7.0.0-rc14`, whatsapp-rust-bridge `0.5.5`,
OpenAI `4.104.0`, and Sharp `0.35.5`. The Baileys and bridge tarball integrity
values are unchanged by the dependency remediation for xmacna/elysium#1019.

Audited dependencies are resolved by the lockfile and package overrides:

| Package | Runtime version |
| --- | --- |
| qs | 6.16.1 |
| body-parser under Express 4 | 1.20.9 |
| ip-address | 10.7.4 |
| multer | 2.5.0 |
| undici (direct) | 7.30.1 |
| undici under link-preview-js 5 | 8.12.2 |

The two Undici consumers retain their own major versions. No SDK major version
is forced through an incompatible override. Jimp is no longer a direct dependency;
its Baileys peer is optional. Removing it also removes the Zod 3 dependency tree.
OpenAI's Zod peer is optional and is absent; existing non-Zod SDK calls remain
unchanged. Do not force Zod 4 into a consumer requiring Zod 3.

Chatwoot ad thumbnails use the shared Sharp codec through
`createChatwootAdThumbnail`: a centered cover crop to 320 by 180 pixels, encoded
as PNG. Invalid image input rejects; it is not returned as an image attachment.
This changes only the ad thumbnail conversion, not normal media transport.

Validate after a clean `npm ci` on Node 24:

```sh
npm audit --omit=dev --audit-level=low
DATABASE_PROVIDER=postgresql npm run db:generate
npx tsc --noEmit
npm run test:xmacna-compat
npm run test:xmacna-meta
npm run test:xmacna-inbox
```

The compatibility suite checks the installed versions and retains its existing
HTTP parsing, multipart upload, Baileys protocol, and native bridge assertions.
The inbox suite includes the production thumbnail helper, checking PNG dimensions,
centered cropping without stretching or letterboxing, and rejection of invalid data.
