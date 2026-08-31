---
name: pdf
description: Create, inspect, validate, merge, split, or extract text from PDF files. Use whenever PDF is the primary input or deliverable, including reports, forms, manuscripts, page operations, and searchable-text checks.
allowed-tools: read bash write edit
---

# PDF documents

Use this Pi-native skill for PDF work. It uses open Python libraries declared directly in its script.

## Tool

```bash
uv run scripts/pdf_tool.py create INPUT.md OUTPUT.pdf --title "Title" --author "Author"
uv run scripts/pdf_tool.py inspect FILE.pdf
uv run scripts/pdf_tool.py validate FILE.pdf
uv run scripts/pdf_tool.py merge OUTPUT.pdf INPUT1.pdf INPUT2.pdf
uv run scripts/pdf_tool.py split INPUT.pdf OUTPUT_DIRECTORY
```

For quick independent extraction checks, this machine also provides:

```bash
pdftotext FILE.pdf -
pdfinfo FILE.pdf
```

## Workflow

1. Inspect the PDF before editing or transforming it.
2. For new PDFs, retain the editable Markdown source.
3. Perform page operations into a new output unless overwrite was requested.
4. Validate page count and extractable text after generation.
5. When dealing with scans, determine whether OCR is needed; do not call an image-only PDF searchable.
6. Report output path, pages, bytes, SHA-256, and whether text extraction succeeds.

## Quality requirements

- Structural validation does not prove visual layout; render or open the result when visual fidelity matters.
- Preserve metadata and page order for merges.
- Never silently remove encryption, signatures, annotations, or form fields.
- Use `create-book` for multi-format book publication; this skill owns the PDF-specific operation.
