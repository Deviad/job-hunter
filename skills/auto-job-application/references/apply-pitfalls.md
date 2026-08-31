# Application Pitfalls

## Page State

A blank body, spinner, login page, verification page, or closed-posting banner is not an empty application. Classify the visible state before filling.

## Framework Controls

React and custom controls may ignore direct value assignment. Use the native setter or real input events, then re-read visible state. Searchable dropdowns require opening the list and selecting a visible option.

## Uploads

Use container-visible paths with `DOM.setFileInputFiles`. A filename in the DOM is not proof of acceptance; verify the page's upload status.

## Unknown Questions

Never answer employment history, work authorization, sponsorship, salary, disclosure, demographic, consent, or product-use questions from repository defaults. Use the cache field that belongs to the question or ask the user.

## Submission

A submit click is not success. Require a confirmation page, success message, or application identifier. Record ambiguous states as unconfirmed.

## Browser Recovery

When DOM actions do not visibly progress, capture visual evidence before retrying. Keep one application flow on the shared CDP session at a time.
