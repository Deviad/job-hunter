---
name: docx
description: Create, inspect, validate, or edit Microsoft Word DOCX documents. Use when a .docx or .dotx file is the primary input/output, or the user asks for a polished Word report, letter, manuscript, or template.
allowed-tools: read bash write edit
---

# DOCX documents

Use this Pi-native skill for Word deliverables. It is implemented independently with open tooling; do not copy files from Claude Cowork's proprietary document skills.

## Tool

Resolve paths relative to this skill directory and run:

```bash
uv run scripts/docx_tool.py create INPUT.md OUTPUT.docx --title "Title" --author "Author"
uv run scripts/docx_tool.py inspect FILE.docx
uv run scripts/docx_tool.py validate FILE.docx
```

`uv` installs the declared `python-docx` dependency into its managed cache on first use.

## Workflow

1. Inspect existing input before changing it.
2. Keep editable source in Markdown when creating a new document.
3. Put title, author, and language in optional frontmatter:

   ```markdown
   ---
   title: Example
   author: Name
   language: en
   ---
   ```

4. Generate the DOCX to the user's requested folder, never a hidden session directory.
5. Run `validate` and report the path, byte size, hash, paragraph count, heading count, and known limitations.
6. For edits beyond the helper's create path, use `python-docx` in a targeted script and save to a new file unless overwrite was explicitly requested.

## Quality requirements

- Use heading styles rather than simulated bold headings.
- Use list styles for bullets and numbered lists.
- Preserve a canonical Markdown/source file alongside substantial generated documents.
- Do not claim visual fidelity without opening/rendering the file. Structural validation is not visual validation.
- Never overwrite the source document without explicit authorization.
- For book-length output, use the `books` and `create-book` skills; this skill owns DOCX rendering and inspection only.
