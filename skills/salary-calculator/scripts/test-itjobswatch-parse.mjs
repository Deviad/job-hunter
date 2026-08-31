/**
 * test-itjobswatch-parse.mjs — parser tests for the ITJobsWatch adapter.
 *
 * Fixtures mirror the real page markup: role table first, all-UK baseline
 * table second with identical row labels. Run with:
 *   node scripts/test-itjobswatch-parse.mjs
 */

import assert from 'node:assert';
import { parseItjobswatchHtml, fetchBenchmark, supports, sourceName } from './sources/itjobswatch.mjs';

function row(label, ...cells) {
  return `<tr><td>${label}</td>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
}

// Real markup shape from /jobs/uk/artificial%20intelligence%20architect.do,
// including the second baseline table that previously risked contaminating
// role figures with whole-market ones.
const ROLE_PAGE = `<html><body><table>
${row('6 months to', '2 Aug 2026', 'Same period 2025')}
${row('Number of salaries quoted', '127', '10', '5')}
${row('10th Percentile', '&#163;71,349', '&#163;63,625')}
${row('25th Percentile', '&#163;80,000', '&#163;74,688')}
${row('Median annual salary (50th Percentile)', '&#163;90,000', '&#163;86,250')}
${row('Median % change year-on-year', '+4.35%', '-13.75%')}
${row('75th Percentile', '&#163;100,000', '&#163;100,313')}
${row('90th Percentile', '&#163;102,600', '&#163;102,000')}
${row('UK excluding London median annual salary', '&#163;85,000', '&#163;80,000')}
</table><table>
${row('Number of salaries quoted', '66,672')}
${row('10th Percentile', '&#163;30,000')}
${row('Median annual salary (50th Percentile)', '&#163;55,000')}
${row('90th Percentile', '&#163;96,250')}
</table></body></html>`;

const p = parseItjobswatchHtml(ROLE_PAGE);
assert.equal(p.median, 90000, 'median parsed from role table');
assert.equal(p.lowerDecile, 71349, 'P10 parsed');
assert.equal(p.lowerQuartile, 80000, 'P25 parsed');
assert.equal(p.upperQuartile, 100000, 'P75 parsed');
assert.equal(p.upperDecile, 102600, 'P90 parsed');
assert.equal(p.sampleSize, 127, 'sample size parsed and comma-stripped');
assert.equal(p.medianExcludingLondon, 85000, 'ex-London median parsed');
assert.equal(p.periodLabel, '2 Aug 2026', 'period label parsed');

// The baseline table must not overwrite role figures.
assert.notEqual(p.median, 55000, 'baseline median must not leak into role cohort');
assert.notEqual(p.sampleSize, 66672, 'baseline sample size must not leak');

// Cohorts with too few samples publish "-"; those must read as null, not 0.
const SPARSE = `<html><table>
${row('Number of salaries quoted', '5')}
${row('25th Percentile', '-')}
${row('Median annual salary (50th Percentile)', '&#163;100,000')}
</table></html>`;
const sp = parseItjobswatchHtml(SPARSE);
assert.equal(sp.lowerQuartile, null, 'unpublished percentile => null');
assert.equal(sp.median, 100000, 'median still parsed alongside null percentile');

// Empty / non-table input must not throw.
assert.equal(parseItjobswatchHtml('').median, null, 'empty input => null median');
assert.equal(parseItjobswatchHtml('<html>no tables</html>').median, null, 'no tables => null median');

// Adapter contract.
assert.equal(sourceName, 'itjobswatch');
assert.equal(supports.benchmark, true);
assert.equal(supports.exactSalary, false);

// fetchBenchmark must hit the .do page, never the retired JSON endpoint.
let requested = null;
const ctx = {
  httpClient: {
    get: async (url) => { requested = url; return ROLE_PAGE; },
    getJson: async () => { throw new Error('getJson must not be used — /api/salary.json is retired (404)'); },
  },
};
const b = await fetchBenchmark({ title: 'AI Architect', region: 'United Kingdom' }, ctx);
assert.ok(requested.includes('/jobs/uk/'), `expected .do page URL, got ${requested}`);
assert.ok(!requested.includes('api/salary.json'), 'must not call the retired JSON API');
// "ai architect" 404s upstream; the alias must redirect to the real cohort.
assert.ok(
  decodeURIComponent(requested).includes('artificial intelligence architect'),
  `expected canonical alias slug, got ${requested}`
);
assert.equal(b.amountMedian, 90000, 'benchmark median mapped');
assert.equal(b.amountP10, 71349, 'benchmark P10 mapped');
assert.equal(b.amountP90, 102600, 'benchmark P90 mapped');
assert.equal(b.amountMin, 80000, 'benchmark min = lower quartile');
assert.equal(b.amountMax, 100000, 'benchmark max = upper quartile');
assert.equal(b.sampleSize, 127, 'benchmark sample size mapped');
assert.equal(b.currency, 'GBP');
assert.equal(b.countryCode, 'GB');
assert.equal(b.compensationType, 'base_salary');
assert.ok(b.rawPayloadJson.includes('90000'), 'raw payload retained for payload_hash dedup');
assert.ok(b.normalizerVersion, 'normalizerVersion stamped (camelCase, else silently ignored)');

// A page with no published median must fail closed, not cache an all-null row.
const NO_MEDIAN = `<html><table>${row('Number of salaries quoted', '2')}</table></html>`;
await assert.rejects(
  () => fetchBenchmark({ title: 'Nonexistent Role' }, {
    httpClient: { get: async () => NO_MEDIAN },
  }),
  /not found/i,
  'missing median must reject so caller records not_found'
);

// Upstream 404 must map to the same not-found path.
await assert.rejects(
  () => fetchBenchmark({ title: 'Bogus' }, {
    httpClient: { get: async () => { const e = new Error('404'); e.status = 404; throw e; } },
  }),
  /not found/i,
  '404 must map to not-found'
);

// A 404 on the first candidate must fall through to the next, not abort.
const tried = [];
const fallback = await fetchBenchmark({ title: 'Senior AI Architect' }, {
  httpClient: {
    get: async (u) => {
      tried.push(decodeURIComponent(u));
      if (tried.length === 1) { const e = new Error('404'); e.status = 404; throw e; }
      return ROLE_PAGE;
    },
  },
});
assert.ok(tried.length > 1, 'must try a second slug after a 404');
assert.equal(fallback.amountMedian, 90000, 'fallback slug still yields a benchmark');

// Real postings carry qualifiers with no register cohort. The slug ladder must
// degrade to the canonical trailing cohort name rather than give up.
// Real titles from the UK queue that previously yielded no benchmark at all.
for (const [title, expected] of [
  ['Forward Deploy Engineer || IDP & GTM || AI & Agentic', 'forward deploy engineer'],
  ['Solutions Architect - Western Europe', 'solutions architect'],
  ['Senior Principal AI Infrastructure Architect', 'infrastructure architect'],
  ['Senior Cloud Architect, Delivery (GenAI)', 'cloud architect'],
]) {
  const seenSlugs = [];
  await fetchBenchmark({ title }, {
    httpClient: {
      get: async (u) => {
        const slug = decodeURIComponent(u).split('/jobs/uk/')[1].replace('.do', '');
        seenSlugs.push(slug);
        if (slug === expected) return ROLE_PAGE;
        const e = new Error('404'); e.status = 404; throw e;
      },
    },
  });
  assert.ok(
    seenSlugs.includes(expected),
    `"${title}" must try slug "${expected}"; tried ${JSON.stringify(seenSlugs)}`
  );
}

// ctx.httpClient.get resolves a fetch Response, not a string. An adapter that
// treats the Response as HTML parses nothing and reports a false not_found,
// which is exactly how every live benchmark lookup silently returned no data.
let responseUrl = null;
const viaResponse = await fetchBenchmark({ title: 'AI Architect' }, {
  httpClient: {
    get: async (u) => {
      responseUrl = u;
      return { ok: true, status: 200, text: async () => ROLE_PAGE };
    },
  },
});
assert.equal(viaResponse.amountMedian, 90000, 'Response-shaped body must be read via .text()');
assert.ok(responseUrl, 'request issued');

// A non-ok Response (no throw) must still be treated as a miss, not parsed.
await assert.rejects(
  () => fetchBenchmark({ title: 'Ghost Role' }, {
    httpClient: { get: async () => ({ ok: false, status: 404, text: async () => '' }) },
  }),
  /not found/i,
  'non-ok Response must map to not-found'
);

// Transient errors must NOT be swallowed as not-found — the orchestrator needs
// to retry rather than record a permanent miss.
await assert.rejects(
  () => fetchBenchmark({ title: 'AI Architect' }, {
    httpClient: { get: async () => { const e = new Error('boom'); e.status = 503; throw e; } },
  }),
  /boom/,
  '5xx must propagate, not map to not-found'
);

console.log('itjobswatch parser tests: PASS');
