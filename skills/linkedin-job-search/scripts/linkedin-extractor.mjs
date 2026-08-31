/**
 * LinkedIn Job Extractor
 *
 * Extracts fields from LinkedIn job HTML using regex patterns.
 * Used by both the test harness and the skill instructions.
 *
 * Patterns are derived from common LinkedIn DOM structures.
 * When LinkedIn changes their DOM, update these patterns.
 */

/**
 * Extract the job title from HTML.
 * @param {string} html
 * @returns {string|null}
 */
export function extractTitle(html) {
  const patterns = [
    /class="top-card-layout__title"[^>]*>([^<]+)</,
    /class="job-details-jobs-v2__main-job-title">([^<]+)</,
    /class="job-card-list__title"[^>]*>([^<]+)</,
    /class="job-title"[^>]*>([^<]+)</,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Extract company name.
 * @param {string} html
 * @returns {string|null}
 */
export function extractCompany(html) {
  const patterns = [
    /class="topcard__org-name-link"[^>]*>([^<]+)</,
    /class="job-details-jobs-v2__company-name"[^>]*>([^<]+)</,
    /class="job-card-list__company-name"[^>]*>([^<]+)</,
    /class="company-name"[^>]*>([^<]+)</,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Extract location.
 * @param {string} html
 * @returns {string|null}
 */
export function extractLocation(html) {
  const patterns = [
    /class="topcard__flavor--bullet"[^>]*>([^<]+)</,
    /class="job-details-jobs-v2__location"[^>]*>([^<]+)</,
    /class="job-card-list__location"[^>]*>([^<]+)</,
    /class="job-location"[^>]*>([^<]+)</,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Extract applicant count from HTML.
 * @param {string} html
 * @returns {number|null} null if no applicant info found
 */
export function extractApplicants(html) {
  const patterns = [
    /class="num-applicants__figure"[^>]*>(\d+)[^<]*</,
    /class="job-card-list__applicant-count"[^>]*>(\d+)\s*applicants?/,
    /class="job-details-jobs-v2__applicant-count"[^>]*>(\d+)\s*applicants?/,
    /over\s+(\d+)\s*applicants?/i,
    /(\d+)\+?\s*applicants?\s*(?:applied|have applied)?/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Extract the full description text from HTML.
 * @param {string} html
 * @returns {string}
 */
export function extractDescription(html) {
  const patterns = [
    /class="description__text"[^>]*>([\s\S]*?)<\/div>/,
    /class="show-more-less__description"[^>]*>([\s\S]*?)<\/div>/,
    /class="job-card-list__description"[^>]*>([\s\S]*?)<\/div>/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      // Strip HTML tags from description
      return m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

/**
 * Extract application links from HTML.
 * @param {string} html
 * @returns {string[]}
 */
export function extractApplicationLinks(html) {
  const links = [];
  const patterns = [
    /class="apply-link"[^>]*href="([^"]+)"/,
    /class="apply-link external"[^>]*href="([^"]+)"/,
    /class="apply-button"[^>]*href="([^"]+)"/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1] && m[1] !== '#') links.push(m[1]);
  }
  return links;
}

/**
 * Extract recruiter/hirer name.
 * @param {string} html
 * @returns {string|null}
 */
export function extractRecruiter(html) {
  const patterns = [
    /class="hirer-name"[^>]*>([^<]+)</,
    /class="recruiter-name"[^>]*>([^<]+)</,
    /class="hirer-info"[^>]*>[\s\S]*?class="hirer-name"[^>]*>([^<]+)</,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Extract job posting date from HTML.
 * @param {string} html
 * @returns {string|null}
 */
export function extractJobPostingDate(html) {
  const patterns = [
    /class="job-posted-date"[^>]*>([^<]+)</,
    /class="posted-date"[^>]*>([^<]+)</,
    /class="posted-date"[^>]*datetime="([^"]+)"/,
    /class="job-posted-date"[^>]*datetime="([^"]+)"/,
    /class="job-details-jobs-v2__posted-date"[^>]*>([^<]+)</,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Extract recruiter email from HTML.
 * @param {string} html
 * @returns {string|null}
 */
export function extractRecruiterEmail(html) {
  const patterns = [
    /class="hirer-email"[^>]*>([^<]+)</,
    /class="recruiter-email"[^>]*>([^<]+)</,
    /class="hirer-info"[^>]*>[\s\S]*?([\w.+-]+@[\w.-]+\.[a-zA-Z]{2,})[\s\S]*?</,
    /mailto:([^")]+)/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Extract recruiter profile link from HTML.
 * @param {string} html
 * @returns {string|null}
 */
export function extractRecruiterProfileLink(html) {
  const patterns = [
    /class="hirer-name"[^>]*href="([^"]+)"/,
    /class="recruiter-name"[^>]*href="([^"]+)"/,
    /class="hirer-info"[^>]*>[\s\S]*?class="hirer-name"[^>]*href="([^"]+)"/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Parse language requirements from a description string.
 *
 * Returns an object with:
 *  - required: string[] of languages that are required
 *  - niceToHave: string[] of languages that are nice-to-have
 *
 * @param {string} description
 * @returns {{ required: string[], niceToHave: string[] }}
 */
export function parseLanguageRequirements(description) {
  const result = { required: [], niceToHave: [] };
  if (!description) return result;

  // Known language keywords to detect
  const languageKeywords = [
    'English', 'German', 'French', 'Spanish', 'Italian',
    'Portuguese', 'Dutch', 'Japanese', 'Chinese', 'Korean',
    'Arabic', 'Example Company 094n', 'Polish', 'Swedish', 'Danish',
    'Norwegian', 'Finnish', 'Turkish', 'Hindi', 'Bengali',
  ];

  // Build regex that matches any of these languages
  const langPattern = languageKeywords.join('|');

  // Required patterns: "Required: Fluent in X", "Must speak X", "X is required", "Requirements: X"
  const requiredRegex = new RegExp(
    `(?:Required|Requirement|Must|Fluent|Proficient|Mandatory|Essential)`
    + `[^.]*?(?:in|speak|speaking|language|fluent|proficient)`
    + `[^.]*?\\b(${langPattern})\\b`,
    'gi'
  );
  let m;
  while ((m = requiredRegex.exec(description)) !== null) {
    const lang = capitalizeLang(m[1]);
    if (!result.required.includes(lang)) result.required.push(lang);
  }

  // Also catch simpler patterns like "Required: English" or "Requirements: English"
  const simpleRequired = new RegExp(
    `(?:Required|Requirements):\\s*(${langPattern})`,
    'gi'
  );
  while ((m = simpleRequired.exec(description)) !== null) {
    const lang = capitalizeLang(m[1]);
    if (!result.required.includes(lang)) result.required.push(lang);
  }

  // Nice-to-have patterns: "Nice to have: X", "X is a plus", "X is nice to have"
  const niceRegex = new RegExp(
    `(?:Nice|Plus|Bonus|Preferred|Optional|Good to have)`
    + `[^.]*?(?:to have|skill|language|speak|speaking)`
    + `[^.]*?\\b(${langPattern})\\b`,
    'gi'
  );
  while ((m = niceRegex.exec(description)) !== null) {
    const lang = capitalizeLang(m[1]);
    if (!result.niceToHave.includes(lang)) result.niceToHave.push(lang);
  }

  // Also catch "X is a plus", "X is nice to have"
  const simpleNice = new RegExp(
    `(${langPattern})[^.]*?(?:is a plus|is nice to have|nice to have)`,
    'gi'
  );
  while ((m = simpleNice.exec(description)) !== null) {
    const lang = capitalizeLang(m[1]);
    if (!result.niceToHave.includes(lang)) result.niceToHave.push(lang);
  }

  return result;
}

/**
 * Determine if a job passes the language filter.
 *
 * A job passes if:
 *  - No required languages are specified (pass by default)
 *  - All required languages match the user's language
 *  - A required language is listed as "nice to have" (not strictly required)
 *
 * @param {{ required: string[], niceToHave: string[] }} requirements
 * @param {string} userLanguage - e.g. "English", "German"
 * @returns {boolean} true = include job, false = skip
 */
export function passesLanguageFilter(requirements, userLanguage) {
  if (!requirements || !userLanguage) return true;

  // Normalize user language
  const userLang = capitalizeLang(userLanguage);

  // If no required languages, job passes
  if (requirements.required.length === 0) return true;

  // Check if any required language does NOT match user's language
  const allMatch = requirements.required.every(
    (req) => req.toLowerCase() === userLang.toLowerCase()
  );

  return allMatch;
}

/**
 * Capitalize a language name properly.
 * @param {string} lang
 * @returns {string}
 */
function capitalizeLang(lang) {
  if (!lang) return '';
  return lang.charAt(0).toUpperCase() + lang.slice(1).toLowerCase();
}
