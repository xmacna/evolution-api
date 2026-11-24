# Meta coexistence fixtures — opened 2026-11-24

All values are synthetic. No captured customer payloads.

- echo-text.json: normalized from the Text message example in https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes . Kept object/entry/changes/value/metadata/contacts/message_echoes and to_user_id. Replaced IDs, body, timestamp and phone strings. Official contacts have no profile/name; deliberately retained that absence.
- inbound-text.json and status-delivered.json: normalized from Incoming messages / Outgoing messages examples in https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages . Replaced values; discarded pricing/conversation fields unused by these tests (not a wire-protocol change).
- Test-derived copies: BSUID-only removes optional to/wa_id per official Syntax warning; username adds optional profile.username. Batches concatenate official-shaped entries/changes/echoes; empty arrays and missing collections exercise guards. Image/video/document variants use documented MESSAGE_TYPE contents (id, mime_type, optional caption/filename) and synthetic media IDs; no live URL. Revoke/edit variants use original_message_id/edit.message from the corresponding official examples, with synthetic values.


Media variants are parameterized synthetic safety cases, not captured app media echoes. The echo reference defines the type-dependent contents; its image edit example explicitly shows id/mime_type/caption. The image/document/audio request references opened today also show media id and optional caption/filename/voice: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/image-messages ; https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/document-messages ; https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/audio-messages . Video/sticker are additional guard cases based on the generic media shape, not a claim that a new official subtype sample was retrieved (specific reference requests returned 429). No unsupported subtype is advertised as proven end-to-end.

Signature fixtures use Node HMAC over the unchanged serialized fixture bytes (including whitespace and newline) with a clearly synthetic App Secret. Official protocol source opened today: https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validate-payloads . Altered-body, absent/malformed header and missing-configuration cases are local security mutations, not Meta payload examples.

History guard mutation uses the field=history + value.messages media-follow-up envelope documented in https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/history (opened 2026-11-24). The text-shaped control is deliberately sufficient to detect accidental live dispatch; no claim of a captured media event.

BR/MX/AR synthetic phone controls are local country-identity variants of the same official to/from/recipient_id fields; the actual legacy createJid utility is executed to demonstrate the old transformation, never mocked. Rate limiting uses actual pinned express-rate-limit middleware, a loopback request IP and a controlled test clock; no HTTP listener or request is opened.


complex-content.json is synthetic content derived from the official location webhook reference, contacts-messages request syntax and reaction-messages request plus reaction webhook/removal examples, all opened/read 2026-11-24. Sources: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/location ; https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/contacts-messages ; https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/reaction-messages ; https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/reaction . Public Accept:text/markdown fetches supplied the reaction examples after web-tool 429 responses. Location 0/0 and .invalid addresses/names/phone data are synthetic. Removing emoji derives from the documented removal variant; an explicitly unsupported future_local_type is a local resilience mutation rather than an official Meta type.

`history.json` and `history-media.json`: derived on 2026-11-24 from the current
[Meta history reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/history),
including thread context, inbound/outbound `from`, delivery context, phases/chunks,
media placeholder and subsequent `history`/`message_echoes` assets. All identities,
text and timestamps replaced with synthetic values; SHA256 is for `synthetic`
bytes. No production payload. `state-sync.json`: derived on the same date from
[onboarding, Synchronizing WhatsApp Business App Data](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users),
contact add/remove, source timestamp and optional phone/opaque user identity.
No legacy signup v3 example is used to infer current v5 readiness.
