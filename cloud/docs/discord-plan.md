# Discord bridge: implementation plan

Goal: selected-guild export through Vencord, asynchronous MCP requests and 15-minute reconciliation without a Discord token on the host.

Spec: discord-design.md. Node.js 24, existing SQLite, one cloud process. Native implementation in this session under the user's instruction to proceed independently; no extra design approval required.

- [x] Add persistent bridge jobs, allowlists, import cursors, bounded batches, per-message FTS/history and accurate completeness. Test interrupted/repeated pages, scope violations, full-versus-incremental reconciliation and quota errors.
- [x] Wire authenticated bridge routes, cloud and local MCP tools, the 900-second schedule and existing Discord read tools. Keep old REST transport compatible. Test credentials, read/sync scopes and offline queuing.
- [x] Add a Vencord userplugin with sequential pagination, archive discovery, permission filtering, checkpoint recovery, event updates and an installation guide. Test the pure collector with mocked Discord/transport; do not claim a live client test.
- [x] Run cloud/local targeted tests, syntax and release checks. See discord-validation.md for evidence and environmental limits.
- [ ] Install the custom Vencord build, configure its separate Workspace credential and verify an actual export. This requires a Vencord source checkout and a reachable local service or Wispbyte URL.
