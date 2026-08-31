# SmartRecruiters and DataDome

DataDome may block SmartRecruiters before the application form loads. Treat it as a security boundary.

- Confirm the page is the authorized employer's SmartRecruiters application.
- Do not bypass DataDome or replay challenge tokens.
- Use the supported CAPTCHA workflow only when the browser presents an interactive application challenge.
- Pause for the user when the page requires account verification, repeated challenges, or an unsupported flow.
- Resume only after the same tab visibly reaches the intended application form.
