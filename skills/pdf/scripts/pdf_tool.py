#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pypdf>=5", "reportlab>=4"]
# ///
"""Create, inspect, validate, merge, and split PDF files."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import ListFlowable, ListItem, PageBreak, Paragraph, SimpleDocTemplate, Spacer

SKILLS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SKILLS / "_document_common"))
from document_common import markdown_blocks, parse_frontmatter, sha256_file, strip_inline_markdown  # noqa: E402


def create(source: Path, output: Path, title: str | None, author: str | None) -> dict:
    text = source.read_text(encoding="utf-8")
    metadata, _ = parse_frontmatter(text)
    resolved_title = title or metadata.get("title")
    resolved_author = author or metadata.get("author")
    output.parent.mkdir(parents=True, exist_ok=True)
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="BookTitle", parent=styles["Title"], alignment=TA_CENTER, fontSize=26, leading=32, spaceAfter=18))
    styles.add(ParagraphStyle(name="Byline", parent=styles["Normal"], alignment=TA_CENTER, fontSize=12, spaceAfter=18))
    story = []
    if resolved_title:
        story.extend([Paragraph(resolved_title, styles["BookTitle"])])
        if resolved_author:
            story.append(Paragraph(resolved_author, styles["Byline"]))
        story.append(PageBreak())
    for block in markdown_blocks(text):
        value = strip_inline_markdown(block["text"])
        if block["type"] == "heading":
            style = styles["Heading1"] if block["level"] == 1 else styles["Heading2"]
            story.extend([Spacer(1, 8), Paragraph(value, style)])
        elif block["type"] in {"bullet", "number"}:
            story.append(ListFlowable([ListItem(Paragraph(value, styles["BodyText"]))], bulletType="bullet" if block["type"] == "bullet" else "1"))
        elif block["type"] == "quote":
            story.append(Paragraph(f"<i>{value}</i>", styles["Italic"]))
        else:
            story.extend([Paragraph(value, styles["BodyText"]), Spacer(1, 6)])
    document = SimpleDocTemplate(
        str(output), pagesize=LETTER, rightMargin=0.8 * inch, leftMargin=0.8 * inch,
        topMargin=0.75 * inch, bottomMargin=0.75 * inch,
        title=resolved_title or source.stem, author=resolved_author or "",
    )
    document.build(story)
    return inspect(output)


def inspect(path: Path) -> dict:
    reader = PdfReader(path)
    text = "\n".join((page.extract_text() or "") for page in reader.pages)
    return {
        "path": str(path.resolve()),
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
        "pages": len(reader.pages),
        "encrypted": reader.is_encrypted,
        "metadata": {str(k): str(v) for k, v in (reader.metadata or {}).items()},
        "text_chars": len(text),
        "text_preview": text[:500],
    }


def merge(inputs: list[Path], output: Path) -> dict:
    writer = PdfWriter()
    for source in inputs:
        for page in PdfReader(source).pages:
            writer.add_page(page)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as stream:
        writer.write(stream)
    return inspect(output)


def split(source: Path, output_dir: Path) -> list[dict]:
    output_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for index, page in enumerate(PdfReader(source).pages, 1):
        target = output_dir / f"page-{index:04d}.pdf"
        writer = PdfWriter()
        writer.add_page(page)
        with target.open("wb") as stream:
            writer.write(stream)
        results.append(inspect(target))
    return results


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
    join = sub.add_parser("merge")
    join.add_argument("output", type=Path)
    join.add_argument("inputs", type=Path, nargs="+")
    divide = sub.add_parser("split")
    divide.add_argument("source", type=Path)
    divide.add_argument("output_dir", type=Path)
    args = parser.parse_args()

    if args.command == "create":
        result = create(args.source, args.output, args.title, args.author)
    elif args.command in {"inspect", "validate"}:
        result = inspect(args.path)
        if args.command == "validate" and (result["pages"] == 0 or result["text_chars"] == 0):
            raise SystemExit("invalid PDF: no pages or extractable text")
    elif args.command == "merge":
        result = merge(args.inputs, args.output)
    else:
        result = split(args.source, args.output_dir)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
