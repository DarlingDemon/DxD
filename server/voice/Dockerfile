FROM ghcr.io/fluxerapp/fluxer-gateway@sha256:fcb22999f99d98c54a5a1eebaa4a8d9fd9947d18fb884a76a07961183ddbe879 AS build

USER root
WORKDIR /tmp/voice-patch
COPY creator-roster.patch .
RUN apt-get update && apt-get install -y --no-install-recommends patch \
    && curl -fsSL --retry 3 -o guild_voice_disconnect_channel.erl \
        https://raw.githubusercontent.com/fluxerapp/fluxer/c9fdf8fead395841933b9ef328036510481f4dc1/fluxer_gateway/src/guild/voice/guild_voice_disconnect_channel.erl \
    && echo '3290dbfa3dce47603d4b373a6828a7f52bf868c27d550ea53ad67c8c7e423877  guild_voice_disconnect_channel.erl' | sha256sum -c - \
    && patch --batch --fuzz=0 -p1 < creator-roster.patch \
    && erlc guild_voice_disconnect_channel.erl

FROM ghcr.io/fluxerapp/fluxer-gateway@sha256:fcb22999f99d98c54a5a1eebaa4a8d9fd9947d18fb884a76a07961183ddbe879

COPY --from=build --chown=65532:65532 /tmp/voice-patch/guild_voice_disconnect_channel.beam /opt/fluxer_gateway/lib/fluxer_gateway-0.0.0/ebin/
