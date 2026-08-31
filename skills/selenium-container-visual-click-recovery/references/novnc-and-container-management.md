# noVNC and Container Management

Verify the noVNC HTTP page and the underlying VNC backend separately. A loaded web client can still have a failed backend.

Prefer supervised process restarts inside the existing container. Restart or recreate the whole container only when logs and health checks support that action. Preserve the browser profile and Job Hunter workspace mounts.

After recovery, verify noVNC connectivity, CDP connectivity, and the visible browser state before resuming automation.
