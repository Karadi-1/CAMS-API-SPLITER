# Test entry points

Run `npm run check` and `npm test` using Node 22.16+ or 24. The suites use synthetic attendance, ephemeral loopback HTTP mocks and temporary SQLite databases.

The current test design and staging limits are in [TEST_INFRA.md](TEST_INFRA.md). Earlier June static-review PASS labels under `.agents/` are historical and are not current execution evidence. CI reports the actual candidate's results. Production deployment still requires the independent staging checks in [DEPLOYMENT_INSTRUCTIONS.md](DEPLOYMENT_INSTRUCTIONS.md).
