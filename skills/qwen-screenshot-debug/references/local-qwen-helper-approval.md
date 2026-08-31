# Qwen screenshot workflow approval and safety notes

Use the local helper instead of ad-hoc shell pipelines:

```bash
node ../../qwen-screenshot-debug/scripts/qwen-vlm-inspect.mjs <image> "<focused visual question>"
```

Why:
- Avoids Tirith-flagged `curl | python` / network-output-to-interpreter patterns.
- Keeps screenshot inspection local to LM Studio/Qwen.
- Produces direct model output without requiring manual JSON parsing.

User workflow preference:
- If the tool layer reports a denial for this workflow but the user did not intentionally deny it, do not abandon the task.
- Explain the exact command/action that was blocked and ask for explicit approval.
- After explicit approval, retry through the helper rather than rephrasing the risky pipeline.

Use this helper for browser/application screenshots, CAPTCHA page diagnosis, and visual verification of form state. Do not use platform `vision_analyze` for this user’s job-automation screenshot workflow.