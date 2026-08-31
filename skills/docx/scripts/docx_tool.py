#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["python-docx>=1.2.0", "Pillow>=10"]
# ///
"""Create, inspect, and validate DOCX files using open Python tooling."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt

SKILLS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SKILLS / "_document_common"))
from document_common import markdown_blocks, parse_frontmatter, sha256_file, strip_inline_markdown  # noqa: E402


def create(source: Path, output: Path, title: str | None, author: str | None) -> dict:
    text = source.read_text(encoding="utf-8")
    metadata, _ = parse_frontmatter(text)
    document = Document()
    section = document.sections[0]
    section.top_margin = Inches(0.8)
    section.bottom_margin = Inches(0.8)
    section.left_margin = Inches(0.9)
    section.right_margin = Inches(0.9)
    styles = document.styles
    styles["Normal"].font.name = "Aptos"
    styles["Normal"].font.size = Pt(11)
    styles["Title"].font.name = "Aptos Display"
    styles["Title"].font.size = Pt(30)

    resolved_title = title or metadata.get("title")
    resolved_author = author or metadata.get("author")
    if resolved_title:
        paragraph = document.add_paragraph(style="Title")
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        paragraph.add_run(resolved_title)
        if resolved_author:
            byline = document.add_paragraph()
            byline.alignment = WD_ALIGN_PARAGRAPH.CENTER
            byline.add_run(resolved_author).italic = True
        document.add_section(WD_SECTION.NEW_PAGE)
    document.core_properties.title = resolved_title or source.stem
    document.core_properties.author = resolved_author or ""

    for block in markdown_blocks(text):
        value = strip_inline_markdown(block["text"])
        if block["type"] == "heading":
            document.add_heading(value, level=min(block["level"], 9))
        elif block["type"] == "bullet":
            document.add_paragraph(value, style="List Bullet")
        elif block["type"] == "number":
            document.add_paragraph(value, style="List Number")
        elif block["type"] == "quote":
            paragraph = document.add_paragraph(value)
            paragraph.style = "Intense Quote"
        else:
            document.add_paragraph(value)

    output.parent.mkdir(parents=True, exist_ok=True)
    document.save(output)
    return inspect(output)


def inspect(path: Path) -> dict:
    document = Document(path)
    paragraphs = [p.text for p in document.paragraphs if p.text.strip()]
    tables = [[len(table.rows), len(table.columns)] for table in document.tables]
    return {
        "path": str(path.resolve()),
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
        "title": document.core_properties.title,
        "author": document.core_properties.author,
        "paragraphs": len(paragraphs),
        "headings": sum(1 for p in document.paragraphs if p.style.name.startswith("Heading")),
        "tables": tables,
        "text_preview": "\n".join(paragraphs)[:500],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    make = sub.add_parser("create")
    make.add_argument("source", type=Path)
    make.add_argument("output", type=Path)
    make.add_argument("--title")
    make.add_argument("--author")
    check = sub.add_parser("inspect")
    check.add_argument("path", type=Path)
    validate = sub.add_parser("validate")
    validate.add_argument("path", type=Path)
    args = parser.parse_args()

    if args.command == "create":
        result = create(args.source, args.output, args.title, args.author)
    else:
        result = inspect(args.path)
        if args.command == "validate" and (result["bytes"] < 1000 or result["paragraphs"] == 0):
            raise SystemExit("invalid DOCX: empty or structurally incomplete")
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
