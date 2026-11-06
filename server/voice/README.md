# Fluxer voice moves

Fluxer can reuse a voice connection ID when moving a member to another room. A late LiveKit departure from the old room could clear the destination's pending connection before Fluxer confirmed the join. The member could then be connected to LiveKit while missing from the room roster.

The patch checks the pending connection's user and channel before clearing it. Build this image for Fluxer gateway revision `c9fdf8fead395841933b9ef328036510481f4dc1`:

```sh
docker build -t fluxer-gateway:tempvoice-roster ./server/voice
```

Set the Compose `gateway` service image to `fluxer-gateway:tempvoice-roster`. To verify the fix, join a TempVoice creator channel as a member the bot can move, then confirm the creator appears in the new room's roster.

When upgrading Fluxer, check whether the new gateway already scopes pending disconnects to the expected user and channel before carrying this patch forward.
