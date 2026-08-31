# Selenium Container Quirks

## File Paths

Chromium can upload only paths visible inside the container. The default Job Hunter mount is `/home/seluser/job-hunter`; use `/home/seluser/job-hunter/CV.docx`.

## Browser State

The browser profile is stored under the local Job Hunter workspace and bind-mounted into the container. Stop duplicate browser processes before reusing the same profile.

## noVNC

A reachable noVNC page does not prove the VNC backend is healthy. Verify the backend and restart only the affected supervised process when evidence supports it.

## CDP

The published Compose stack exposes the CDP proxy on localhost. Use the configured host port and keep browser work single-threaded.

## Visual Recovery

Use screenshots from the same browser coordinate system as the click tool. Verify state change after every visual click and stop on repeated no-op actions.
