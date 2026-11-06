# Immutable live-image ID must already be available on the isolated build host.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY patch.cjs /tmp/status-ack-patch.cjs
RUN node /tmp/status-ack-patch.cjs /evolution/node_modules/baileys --apply \
 && node --check /evolution/node_modules/baileys/lib/Socket/messages-recv.js \
 && rm /tmp/status-ack-patch.cjs
LABEL ai.xmacna.change="1047-status-stanza-ack-canary-only"
# Original entrypoint and all other files remain inherited; no migration/config change.
