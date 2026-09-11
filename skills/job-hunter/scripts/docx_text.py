"""Read DOCX text using the standard ZIP and XML parsers, without extraction to disk."""
import io
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree

MAX_DOCUMENT_BYTES = 16 * 1024 * 1024

def extract_docx_bytes(data):
    if len(data) > 64 * 1024 * 1024:
        raise ValueError('CV archive is too large')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entry = archive.getinfo('word/document.xml')
        if entry.file_size > MAX_DOCUMENT_BYTES:
            raise ValueError('CV document is too large')
        xml = archive.read(entry)
    if b'<!DOCTYPE' in xml.upper():
        raise ValueError('DOCX document type declarations are unsupported')
    parts = []
    for event, element in ElementTree.iterparse(io.BytesIO(xml), events=('start', 'end')):
        tag = element.tag.rsplit('}', 1)[-1]
        if event == 'end' and tag == 't':
            parts.append(element.text or '')
        elif event == 'end' and tag == 'p':
            parts.append('\n')
        elif event == 'start' and tag == 'tab':
            parts.append(' ')
        elif event == 'start' and tag in ('br', 'cr'):
            parts.append('\n')
    return ''.join(parts)

def extract_docx_text(path):
    return extract_docx_bytes(Path(path).read_bytes())

if __name__ == '__main__':
    sys.stdout.write(extract_docx_bytes(sys.stdin.buffer.read()))
