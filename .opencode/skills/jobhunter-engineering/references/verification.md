# JobHunter Verification Reference

## Pre-Completion Checklist (from AGENTS.md)
Before saying "done", verify:

- [ ] Implementation matches SRS requirements (FR/NFR/BR/AC)
- [ ] Tests added/updated and pass (unit/integration/contract/e2e as appropriate)
- [ ] Type checking passes
- [ ] Linting passes
- [ ] Database migrations are valid, safe, and tested (if any)
- [ ] API contracts are correct and consistent
- [ ] Security implications reviewed (secrets, input validation, least privilege)
- [ ] Error handling and edge cases covered (UNKNOWN states, retries, partial failures)
- [ ] SRS compliance confirmed
- [ ] Git diff inspected (no unrelated changes, logically separated)
- [ ] Regression tests exist for bugs fixed

## Bug-Fix Process
1. Reproduce it
2. Add a regression test
3. Fix it
4. Run the regression test
5. Run affected tests
6. Run the broader suite

## Reporting
- Report what was actually verified (tools, commands, results)
- Never claim verification that was not performed

*(Document project-specific commands for tests, types, lint, migrations, etc. as the codebase emerges.)*