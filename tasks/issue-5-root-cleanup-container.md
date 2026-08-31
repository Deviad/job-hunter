# Run the Compose cleanup helper as root

Parents: #1, #3

## Goal

Fix the isolated Compose rehearsal teardown on GitHub-hosted Linux runners after three issue #3 attempts proved all service checks pass but root-owned Chromium profile artifacts survive cleanup.

## Approach

Keep the verified rehearsal unchanged and run its post-teardown cleanup helper container with `--user root`. This is a separate one-line mechanism slice after the issue #3 circuit breaker.

## Acceptance Criteria

- [ ] `bash scripts/rehearse-compose.sh` exits zero locally with six passing service checks and teardown.
- [ ] Pull-request `compose-rehearsal` completes successfully on GitHub Actions.
- [ ] The validation job remains successful.

## Non-Goals

- Changing service images, ports, health checks, or application behavior.
