# LinkedIn Easy Apply Interest Loop

Easy Apply may return to an interest or review step after an attempted action. Detect the current dialog stage from visible headings and controls rather than assuming navigation succeeded.

Do not answer screening questions in the search skill. Hand the job to `auto-job-application`, which loads the user's cache and asks for unknown required answers. A repeated dialog with no visible state change is a blocker, not a successful application.
