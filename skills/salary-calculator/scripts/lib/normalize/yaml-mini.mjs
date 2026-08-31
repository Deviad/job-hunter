/**
 * yaml-mini.mjs - Minimal safe YAML subset parser for rules-loader
 *
 * Parses a strict subset of YAML sufficient for references/normalization.md:
 * - Block mappings (key: value)
 * - Block sequences (- item)
 * - Nested mappings (one level deep)
 * - Flow sequences ([a, b, c])
 * - Comments (#)
 * - Hyphenated keys
 *
 * NOT supported (explicitly rejected):
 * - Anchors/aliases (&anchor, *ref)
 * - Multi-doc (---)
 * - Flow mappings ({key: value})
 * - Booleans/nulls
 *
 * Exports:
 * - parseYaml(text) → parsed YAML object
 * - parseSectionedMarkdown(text) → {header, sections}
 */

/**
 * Parse a SAFE YAML subset
 * Returns: plain object with string keys, values are string | string[] | {bucket, keywords}[] | etc
 * OR returns an array if the YAML is a top-level sequence
 */
export function parseYaml(text) {
  const lines = text
    .split('\n')
    .map((line) => {
      // Strip comments but preserve # in unquoted keys (like c#, c++)
      // Comment detection: find # only after a value or at the start of a line with leading whitespace
      // Simple heuristic: # is a comment if it appears:
      // 1. At the start of line (after optional whitespace) — entire line is a comment, strip to empty
      // 2. After a colon and some value
      // 3. After a dash (array item) and some value
      // For keys like "c#: csharp", the # is part of the key (appears before colon), so preserve it

      // FIRST: check if this is a comment-only line (# at position 0 or only whitespace before it)
      const hashIdx = line.indexOf('#');
      if (hashIdx !== -1 && (hashIdx === 0 || line.substring(0, hashIdx).trim() === '')) {
        // Comment-only line, strip entire thing
        return '';
      }

      const colonIdx = line.indexOf(':');
      const dashIdx = line.indexOf('-');

      if (colonIdx === -1) {
        // No colon: check for array item syntax (- value # comment)
        if (hashIdx === -1) return line; // No hash, return as-is

        // This is an array item with an inline comment (- value # comment)
        // The dash should appear before the hash, and should be at the start (after optional whitespace)
        if (dashIdx !== -1 && dashIdx < hashIdx && line.substring(0, dashIdx).trim() === '') {
          // This is "  - value # comment", strip the comment
          return line.substring(0, hashIdx);
        }

        // Otherwise preserve the line
        return line;
      }

      // Has colon: check for comment after the colon
      if (hashIdx === -1 || hashIdx < colonIdx) return line; // No comment after colon, or hash is before colon

      const afterColon = line.substring(colonIdx + 1);
      const hashIdxInValue = afterColon.indexOf('#');
      if (hashIdxInValue === -1) return line; // No comment

      // Check if # is inside quotes (simple check for quoted values)
      const beforeHash = afterColon.substring(0, hashIdxInValue).trim();
      if (beforeHash.startsWith('"') || beforeHash.startsWith("'")) {
        // Value is quoted; # might be inside or after quotes
        // Find the closing quote
        const quoteChar = beforeHash[0];
        let endQuoteIdx = beforeHash.indexOf(quoteChar, 1);
        if (endQuoteIdx !== -1) {
          // Quote closes before # was found, so # is a comment
          return line.substring(0, colonIdx + 1 + hashIdxInValue);
        }
        // Quote doesn't close; # is likely inside; preserve the line
        return line;
      }

      // Unquoted value; # is a comment
      return line.substring(0, colonIdx + 1 + hashIdxInValue);
    })
    .filter((line) => line.trim().length > 0);

  // Reject unsupported YAML features
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('&') || line.includes('*')) {
      throw new Error(`yaml-mini: unsupported YAML feature (anchors/aliases) at line ${i + 1}`);
    }
    if (line.trim() === '---') {
      throw new Error(`yaml-mini: unsupported YAML feature (multi-doc) at line ${i + 1}`);
    }
  }

  // Detect if this is a top-level array (starts with -)
  const firstLine = lines.length > 0 ? lines[0].trim() : '';
  if (firstLine.startsWith('-')) {
    return parseTopLevelArray(lines);
  }

  const result = {};
  let currentKey = null;
  let currentValue = [];
  let inArray = false;
  let baseIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    const indent = line.match(/^\s*/)[0].length;

    // Detect flow sequence: [a, b, c]
    if (trimmed.startsWith('[') && trimmed.includes(']')) {
      const flowContent = trimmed.slice(1, -1);
      const items = flowContent
        .split(',')
        .map((s) => s.trim())
        .map((s) => stripQuotes(s))
        .filter((s) => s.length > 0);
      result[currentKey] = items;
      currentKey = null;
      inArray = false;
      continue;
    }

    // Detect key: value
    if (trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':');
      const key = trimmed.substring(0, colonIdx).trim();
      const restOfLine = trimmed.substring(colonIdx + 1).trim();

      // Commit previous key-value
      if (currentKey !== null) {
        if (inArray) {
          result[currentKey] = currentValue;
        } else {
          result[currentKey] = currentValue.length === 1 ? currentValue[0] : currentValue;
        }
      }

      currentKey = key;
      currentValue = [];
      inArray = false;
      baseIndent = indent;

      if (restOfLine.length > 0) {
        if (restOfLine.startsWith('[')) {
          // Flow array on same line
          const flowContent = restOfLine.slice(1, restOfLine.includes(']') ? restOfLine.indexOf(']') : undefined);
          const items = flowContent
            .split(',')
            .map((s) => s.trim())
            .map((s) => stripQuotes(s))
            .filter((s) => s.length > 0);
          result[currentKey] = items;
          currentKey = null;
          inArray = false;
        } else {
          // Scalar value on same line
          currentValue = [stripQuotes(restOfLine)];
        }
      }
      continue;
    }

    // Detect array item: - value
    if (trimmed.startsWith('-')) {
      const value = trimmed.substring(1).trim();

      // Check if this is a nested object { bucket: x, keywords: [...] }
      if (value.includes(':')) {
        const nestedObj = parseNestedObject(value, lines, i);
        currentValue.push(nestedObj);
        i = nestedObj._endLine;
        inArray = true;
      } else if (value.startsWith('{')) {
        // Flow object (shouldn't happen in our rules, but reject it)
        throw new Error(`yaml-mini: unsupported YAML feature (flow mapping) at line ${i + 1}`);
      } else {
        currentValue.push(stripQuotes(value));
        inArray = true;
      }
      continue;
    }

    // If we're expecting more array items at the same or deeper indent, continue
    if (inArray && indent > baseIndent) {
      if (trimmed.startsWith('-')) {
        const value = trimmed.substring(1).trim();
        if (value.includes(':')) {
          const nestedObj = parseNestedObject(value, lines, i);
          currentValue.push(nestedObj);
          i = nestedObj._endLine;
        } else {
          currentValue.push(stripQuotes(value));
        }
      } else if (trimmed.includes(':')) {
        // Continuation of current array item (nested key-value)
        // Parse as part of the current object
      }
    }
  }

  // Commit final key
  if (currentKey !== null) {
    if (inArray) {
      result[currentKey] = currentValue;
    } else {
      result[currentKey] = currentValue.length === 1 ? currentValue[0] : currentValue;
    }
  }

  return result;
}

/**
 * Parse a top-level YAML array (starting with -)
 * Returns: array of objects or scalars
 */
function parseTopLevelArray(lines) {
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    if (trimmed.startsWith('-')) {
      const value = trimmed.substring(1).trim();

      if (value.includes(':')) {
        // This is a nested object
        const nestedObj = parseNestedObject(value, lines, i);
        result.push(nestedObj);
        i = nestedObj._endLine + 1;
      } else if (value.length > 0) {
        // Scalar value
        result.push(stripQuotes(value));
        i++;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }

  return result;
}

/**
 * Parse a single nested object: bucket: ..., keywords: [...]
 * Returns: { bucket, keywords, _endLine } where _endLine is the index of the last line processed
 */
function parseNestedObject(firstLine, lines, startIdx) {
  const obj = {};
  const metadata = { _endLine: startIdx };
  let currentKey = null;

  // Parse the first line
  const colonIdx = firstLine.indexOf(':');
  if (colonIdx > -1) {
    const key = firstLine.substring(0, colonIdx).trim();
    const value = firstLine.substring(colonIdx + 1).trim();
    currentKey = key;
    if (value.startsWith('[')) {
      const flowContent = value.slice(1, value.includes(']') ? value.indexOf(']') : undefined);
      const items = flowContent
        .split(',')
        .map((s) => s.trim())
        .map((s) => stripQuotes(s))
        .filter((s) => s.length > 0);
      obj[currentKey] = items;
    } else if (value.length > 0) {
      obj[currentKey] = stripQuotes(value);
    }
  }

  // Continue with subsequent lines (nested keys)
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('-')) {
      // End of this nested object
      metadata._endLine = i - 1;
      return Object.assign(obj, metadata);
    }

    if (trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':');
      const key = trimmed.substring(0, colonIdx).trim();
      const value = trimmed.substring(colonIdx + 1).trim();
      if (value.startsWith('[')) {
        const flowContent = value.slice(1, value.includes(']') ? value.indexOf(']') : undefined);
        const items = flowContent
          .split(',')
          .map((s) => s.trim())
          .map((s) => stripQuotes(s))
          .filter((s) => s.length > 0);
        obj[key] = items;
      } else if (value.length > 0) {
        obj[key] = stripQuotes(value);
      }
      currentKey = key;
    }
  }

  metadata._endLine = lines.length - 1;
  return Object.assign(obj, metadata);
}

/**
 * Strip surrounding quotes from a value
 */
function stripQuotes(value) {
  value = value.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse markdown text into header + sections
 * Splits on ^## headings, extracts fenced YAML blocks under each heading
 *
 * Returns: { header: string, sections: { sectionName: string } }
 */
export function parseSectionedMarkdown(text) {
  const lines = text.split('\n');
  const sections = {};
  let header = [];
  let currentSection = null;
  let inFence = false;
  let fenceContent = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect section heading
    if (line.startsWith('## ')) {
      // Save previous section if any
      if (currentSection && fenceContent.length > 0) {
        sections[currentSection] = fenceContent.join('\n').trim();
        fenceContent = [];
      }

      currentSection = line.substring(3).trim();
      inFence = false;
      continue;
    }

    if (currentSection === null) {
      // Still in header
      header.push(line);
      continue;
    }

    // Detect fence
    if (line.trim().startsWith('```')) {
      if (!inFence) {
        inFence = true;
      } else {
        inFence = false;
        // Fence is closed; save this section
        if (fenceContent.length > 0) {
          sections[currentSection] = fenceContent.join('\n').trim();
          fenceContent = [];
          currentSection = null; // Expect next ## heading or end
        }
      }
      continue;
    }

    if (inFence) {
      fenceContent.push(line);
    }
  }

  // Save last section if still open
  if (currentSection && fenceContent.length > 0) {
    sections[currentSection] = fenceContent.join('\n').trim();
  }

  return {
    header: header.join('\n').trim(),
    sections,
  };
}

// Self-test (runs if this file is executed directly)
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('yaml-mini self-test:');

  // Test 1: parseYaml basic
  const yaml1 = `a: 1
b:
  - x
  - y`;
  const result1 = parseYaml(yaml1);
  console.log('Test 1 (basic):', JSON.stringify(result1) === '{"a":"1","b":["x","y"]}' ? 'PASS' : 'FAIL');

  // Test 2: parseSectionedMarkdown
  const md = `# Header

NORMALIZER_VERSION: 1

## foo

\`\`\`yaml
bar: baz
\`\`\`

## qux

\`\`\`yaml
zap: [1, 2]
\`\`\`
`;
  const result2 = parseSectionedMarkdown(md);
  console.log('Test 2 (sections):', Object.keys(result2.sections).length === 2 && result2.sections.foo && result2.sections.qux ? 'PASS' : 'FAIL');

  // Test 3: reject anchors
  try {
    parseYaml('&anchor a: 1');
    console.log('Test 3 (anchor rejection): FAIL');
  } catch (e) {
    console.log('Test 3 (anchor rejection):', e.message.includes('unsupported') ? 'PASS' : 'FAIL');
  }

  console.log('Self-test complete');
}
