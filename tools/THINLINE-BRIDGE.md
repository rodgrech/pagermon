# ThinLine Radio source for Central West Alerts

This is an optional, read-only alternative to the existing Rdio Scanner source.
It reads recent calls and audio from a local ThinLine PostgreSQL container through
an authenticated LAN bridge. PagerMon's browser never contacts ThinLine or
PostgreSQL directly.

The bridge expects the ThinLine PostgreSQL container to be named
`thinline-postgres`, with database `thinline_radio` and role `thinline_user`.
It exposes only `GET /health`, `GET /calls?limit=...`, and
`GET /calls/{id}/audio`, and `GET /talkgroups`; all require a bearer token. Bind it to a private LAN
address and do not forward its port to the Internet. The existing Rdio bridge
token can be reused for migration, but rotate it if its access has broadened.

Install `thinline-bridge.py` and `thinline-bridge.service` on the ThinLine host,
then select **ThinLine Radio bridge** in CWA's Radio integration settings. Set
the bridge URL and token server-side. The old **Remote Rdio bridge** option
remains available. The CWA Radio tab shows a compact player beside call history
on larger screens and stacks them on phones. Its follow mode polls for new calls
every 15 seconds and queues their recordings; it is not ThinLine's low-latency
WebSocket stream.
The talkgroup chooser reads the ThinLine catalogue once per page load; Scan
all and Hold TG affect only that browser's history/follow playback.
