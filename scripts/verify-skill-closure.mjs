import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_SKILLS = [
  'job-hunter',
  'linkedin-job-search',
  'indeed-job-search',
  'job-match-scorer',
  'salary-calculator',
  'auto-job-application',
  'captcha-resolution',
  'qwen-screenshot-debug',
  'selenium-container-visual-click-recovery',
  'obscura-mcp-repair',
  'pi-mcp-repair',
  'brave-obscura-session',
  'docx',
  'pdf',
];

export const PLATFORM_INTEGRATIONS = new Set([
  'apple-mail', 'brave', 'chromium', 'context-mode', 'docker', 'ffmpeg',
  'lm-studio', 'novnc', 'obscura', 'pi', 'searxng', 'selenium', 'xdotool',
]);

/** Verify required skill entry points and explicit skill-path references. */
export async function run(rootDir) {
  const findings = [];
  const skillsDir = join(rootDir, 'skills');
  const bundled = new Set(REQUIRED_SKILLS);

  for (const name of REQUIRED_SKILLS) {
    const skillDir = join(skillsDir, name);
    const directory = await stat(skillDir).catch(() => null);
    if (!directory?.isDirectory()) {
      findings.push({ type: 'missing-skill', path: `skills/${name}`, detail: 'required skill not found' });
      continue;
    }

    const skillPath = join(skillDir, 'SKILL.md');
    const skillFile = await stat(skillPath).catch(() => null);
    if (!skillFile?.isFile()) {
      findings.push({ type: 'missing-skill-md', path: `skills/${name}/SKILL.md`, detail: 'SKILL.md missing or not a file' });
      continue;
    }

    const content = await readFile(skillPath, 'utf8');
    if (!content.trim()) {
      findings.push({ type: 'empty-skill-md', path: `skills/${name}/SKILL.md`, detail: 'SKILL.md is empty' });
    }
  }

  const referencePatterns = [
    /(?:~\/\.pi\/agent\/skills\/|\$\{AGENT_SKILLS_DIR\}\/|(?:^|[^.\w-])skills\/)([a-z][a-z0-9-]*)\//gim,
    /(?:^|[\s`(])([a-z][a-z0-9-]*)\/SKILL\.md\b/gim,
  ];

  for (const name of REQUIRED_SKILLS) {
    const skillPath = join(skillsDir, name, 'SKILL.md');
    const content = await readFile(skillPath, 'utf8').catch(() => '');
    if (!content) continue;

    const references = new Set();
    for (const pattern of referencePatterns) {
      for (const match of content.matchAll(pattern)) references.add(match[1].toLowerCase());
    }
    references.delete(name);

    for (const reference of references) {
      if (bundled.has(reference) || PLATFORM_INTEGRATIONS.has(reference)) continue;
      findings.push({
        type: 'unresolved-skill-ref',
        path: `skills/${name}/SKILL.md`,
        detail: `references skill "${reference}" which is neither bundled nor a platform integration`,
      });
    }
  }

  if (findings.length === 0) {
    return {
      exitCode: 0,
      output: [`Skill closure: all ${REQUIRED_SKILLS.length} required skills present and valid.`],
      findings,
    };
  }

  const output = findings.map((finding) =>
    `[FAIL] ${finding.type}: ${finding.path} — ${finding.detail}`
  );
  output.push(`Skill closure: ${findings.length} finding(s).`);
  return { exitCode: 1, output, findings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] || process.cwd();
  const { exitCode, output } = await run(root);
  for (const line of output) console.log(line);
  process.exit(exitCode);
}
