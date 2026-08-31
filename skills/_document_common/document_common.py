"""Shared helpers for Pi's open document-production skills."""

from __future__ import annotations

import hashlib
import html
import json
import re
from pathlib import Path
from typing import Any


def read_text(path: str | Path) -> str:
    return Path(path).expanduser().resolve().read_text(encoding="utf-8")


def write_json(path: str | Path, value: Any) -> None:
    target = Path(path).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def slugify(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return value or "untitled"


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end < 0:
        return {}, text
    metadata: dict[str, str] = {}
    for line in text[4:end].splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            metadata[key.strip()] = value.strip().strip('"\'')
    return metadata, text[end + 5 :]


def markdown_blocks(text: str) -> list[dict[str, Any]]:
    _, body = parse_frontmatter(text)
    blocks: list[dict[str, Any]] = []
    paragraph: list[str] = []

    def flush() -> None:
        if paragraph:
            blocks.append({"type": "paragraph", "text": " ".join(paragraph).strip()})
            paragraph.clear()

    for raw in body.splitlines():
        line = raw.rstrip()
        if not line.strip():
            flush()
            continue
        heading = re.match(r"^(#{1,6})\s+(.+)$", line)
        if heading:
            flush()
            blocks.append({"type": "heading", "level": len(heading.group(1)), "text": heading.group(2).strip()})
            continue
        bullet = re.match(r"^\s*[-*+]\s+(.+)$", line)
        if bullet:
            flush()
            blocks.append({"type": "bullet", "text": bullet.group(1).strip()})
            continue
        numbered = re.match(r"^\s*\d+[.)]\s+(.+)$", line)
        if numbered:
            flush()
            blocks.append({"type": "number", "text": numbered.group(1).strip()})
            continue
        quote = re.match(r"^>\s?(.*)$", line)
        if quote:
            flush()
            blocks.append({"type": "quote", "text": quote.group(1).strip()})
            continue
        paragraph.append(line.strip())
    flush()
    return blocks


def strip_inline_markdown(text: str) -> str:
    text = re.sub(r"!\[([^]]*)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"\[([^]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"(`{1,3}|\*\*|__|\*|_)", "", text)
    return text


def markdown_plain_text(text: str) -> str:
    return "\n".join(strip_inline_markdown(block["text"]) for block in markdown_blocks(text))


def markdown_to_html(text: str) -> str:
    parts: list[str] = []
    in_ul = False
    in_ol = False
    for block in markdown_blocks(text):
        kind = block["type"]
        if kind != "bullet" and in_ul:
            parts.append("</ul>")
            in_ul = False
        if kind != "number" and in_ol:
            parts.append("</ol>")
            in_ol = False
        value = html.escape(strip_inline_markdown(block["text"]))
        if kind == "heading":
            level = block["level"]
            parts.append(f"<h{level}>{value}</h{level}>")
        elif kind == "bullet":
            if not in_ul:
                parts.append("<ul>")
                in_ul = True
            parts.append(f"<li>{value}</li>")
        elif kind == "number":
            if not in_ol:
                parts.append("<ol>")
                in_ol = True
            parts.append(f"<li>{value}</li>")
        elif kind == "quote":
            parts.append(f"<blockquote>{value}</blockquote>")
        else:
            parts.append(f"<p>{value}</p>")
    if in_ul:
        parts.append("</ul>")
    if in_ol:
        parts.append("</ol>")
    return "\n".join(parts)


def split_chapters(text: str) -> list[tuple[str, str]]:
    metadata, body = parse_frontmatter(text)
    chapters: list[tuple[str, str]] = []
    current_title = metadata.get("title", "Introduction")
    current: list[str] = []
    for line in body.splitlines():
        if line.startswith("# "):
            if current and any(item.strip() for item in current):
                chapters.append((current_title, "\n".join(current).strip()))
            current_title = line[2:].strip()
            current = []
        else:
            current.append(line)
    if current or not chapters:
        chapters.append((current_title, "\n".join(current).strip()))
    return chapters


def word_count(text: str) -> int:
    return len(re.findall(r"\b[\w’'-]+\b", markdown_plain_text(text), flags=re.UNICODE))
