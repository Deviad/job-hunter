# Indeed Apply button semantics

Indeed search results can produce two distinct application paths:

1. `Apply with Indeed`
   - Treat as Indeed SmartApply.
   - Continue through the Indeed hosted flow and handle review-page reCAPTCHA if needed.

2. `Apply on company site`
   - Treat as an external company-site redirect, not as an Indeed SmartApply failure.
   - Click/follow the button and capture both current-tab navigation and newly opened tabs.
   - If a DOM click returns true but the page stays on `uk.indeed.com/viewjob`, retry with trusted CDP mouse events on the button bounding box.
   - Once an external URL is reached, hand off to the company/ATS application workflow.

Closed applications are not scoring failures. Record/report them as closed/no-longer-accepting terminal outcomes, then continue to the next threshold-pass job.
