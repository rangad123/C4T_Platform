<!-- ai-testing-platform:ci-report -->
## AI Testing Platform: gate failed

- 1 finding at high or higher severity (worst: critical).
- 1 test could not be validated.

| Run | Passed | Findings | Could not validate | Not run |
| ---: | ---: | ---: | ---: | ---: |
| 5 | 1 | 3 | 1 | 1 |

### Findings

| Severity | Test | What was found |
| --- | --- | --- |
| Critical | [WEB-002](http://platform.test/#/tests/t2?a=1&b=2) Checkout <b>button</b> works \| really | Expected the "Pay" button to be visible & enabled but it was missing <script>alert(1)</script> _(payment flow)_ |
| Medium | WEB-003 Security headers | Passive security check: Content-Security-Policy header is missing _(missing header)_ |
| Low | WEB-004 Contrast | Accessibility: 2 violations |

### Tests that could not be validated

| Test | What happened |
| --- | --- |
| API-001 List orders | Timed out waiting for response after 30000 ms |

<sub>Target http://app.test:3000 · replay · 12.3 s · 2026-01-02T03:04:05.000Z</sub>
