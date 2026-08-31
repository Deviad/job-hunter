# Application Handoff Threshold

The default handoff policy is:

```text
fit_score >= 60 and no hard blocker -> Apply candidate
otherwise -> Skip or resolve the blocker
```

The score must be computed from persisted matched/total criterion counts. Hard blockers include only verified conflicts such as mandatory unsupported language, incompatible country-specific work authorization, explicit no-sponsorship requirements, or a clearly out-of-scope role.

Unknown eligibility is not silently converted into either approval or rejection; surface it for resolution.
