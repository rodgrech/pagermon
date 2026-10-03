# External API integration rules

Any new or changed third-party API integration must be quota-safe by default:

- Fetch through PagerMon's server; never let each browser call the provider directly.
- Cache successful responses and choose a polling interval from the provider's documented access cost and the configured subscription allowance.
- Coalesce concurrent requests for the same resource into one in-flight provider request.
- Honour `Retry-After` and rate-limit reset headers. Do not retry continuously after `429` responses.
- Preserve the last successful response and serve it with an explicit stale/unavailable indicator during provider or quota failures.
- Persist useful caches when practical so a PagerMon restart does not immediately discard the fallback data.
- Keep credentials server-side and out of logs, browser responses, source control, and diagnostic output.
- Log provider status and error codes without logging secrets.
- Show required provider attribution wherever provider data is displayed.
- Document the per-refresh access cost and a safe recommended interval in the administrator settings.

