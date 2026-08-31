const ROLE_LABELS = Object.freeze([
  'Exact architecture',
  'Adjacent technical',
  'Leadership progression',
  'Leadership lateral',
  'Conditional',
  'Data-domain stretch',
  'Out of scope',
]);

const ROLE_TAXONOMY_VERSION = '1';

export { ROLE_LABELS, ROLE_TAXONOMY_VERSION };

const ROLE_LABEL_SET = new Set(ROLE_LABELS);
const DEFAULT_MAX_QUERIES = 16;
const MAX_QUERIES = 32;
const DATA_GAP_SKILLS = [
  'data modelling',
  'data governance',
  'lakehouse',
  'data warehouse',
  'Spark',
  'Databricks',
  'Snowflake',
];

const AI_TOKENS = [
  'ai',
  'artificial intelligence',
  'gen ai',
  'genai',
  'generative ai',
  'agentic ai',
  'agentic',
  'llm',
  'large language model',
  'machine learning',
  'ml',
  'ml platform',
  'mlops',
];

const ARCHITECTURE_TOKENS = [
  'architect',
  'architecture',
  'system design',
  'systems design',
  'production architecture',
  'platform decisions',
  'technical direction',
  'technical strategy',
  'design authority',
  'architectural decisions',
  'architecture ownership',
  'engineering standards',
];

const ADJACENT_TITLE_PATTERNS = [
  /\bprincipal ai engineer\b/,
  /\bstaff ai engineer\b/,
  /\blead ai engineer\b/,
  /\bprincipal applied ai engineer\b/,
  /\bstaff applied ai engineer\b/,
  /\blead applied ai engineer\b/,
  /\bprincipal ml engineer\b/,
  /\bstaff ml engineer\b/,
  /\blead ml engineer\b/,
  /\bai technical lead\b/,
  /\bai engineering lead\b/,
  /\bai platform lead\b/,
  /\bprincipal ai platform engineer\b/,
  /\bstaff ai platform engineer\b/,
  /\blead ai platform engineer\b/,
  /\bml platform lead\b/,
  /\bmlops architect\b/,
  /\bai enablement architect\b/,
];

const LEADERSHIP_TITLE_PATTERN = /\b(?:engineering manager|senior engineering manager|head of ai(?: engineering| platform)?|director of ai(?: engineering| platform)?|ai engineering director|ai platform director|vp of ai(?: engineering| platform)?|solutions architecture manager|technical delivery manager)\b/;
const LEADERSHIP_WORD_PATTERN = /\b(?:manager|director|head|vp|vice president)\b/;
const LEADERSHIP_AI_PATTERN = /\b(?:ai|artificial intelligence|genai|generative ai|agentic ai|llm|machine learning|ml|ml platform|mlops)\b/;

const DATA_PATTERNS = [
  ['data modelling', /\bdata modell?ing\b/],
  ['data governance', /\bdata governance\b/],
  ['lakehouse', /\blakehouse\b/],
  ['data warehouse', /\bdata warehouse(?:s|ing)?\b/],
  ['Spark', /\b(?:apache )?spark\b|\bpyspark\b/],
  ['Databricks', /\bdatabricks\b/],
  ['Snowflake', /\bsnowflake\b/],
];

const NON_SOFTWARE_ARCHITECTURE_PATTERN = /\b(?:building|construction|interior|landscape|civil|structural|mechanical|electrical|bim|revit|autocad|architectural design|real estate)\b/;
const CONSTRUCTION_DOMAIN_BODY_PATTERN = /\b(?:construction|bim|revit|autocad|civil(?: engineering)?|structural(?: engineering)?|interior(?: design| architecture)?|landscape(?: architecture| design)?|mechanical(?: engineering)?|electrical(?: engineering)?|architectural design|real estate)\b/;
const GENERIC_DATA_ARCHITECTURE_TITLE_PATTERN = /\b(?:data|data platform|data warehouse|data lakehouse)\s+(?:architect|architecture)(?:\s+(?:lead|manager|director))?\b/;
const SALES_TITLE_PATTERN = /\b(?:account executive|sales executive|sales director|business development representative|sales manager|commercial director)\b/;
const QUOTA_OWNERSHIP_PATTERN = /\b(?:quota[- ](?:led|carrying|bearing)|sales quota|revenue quota|commission[- ]based|(?:own|owns|carry|carries|responsible for|accountable for|deliver|deliver on|meet|exceed)\s+(?:the\s+)?(?:sales|revenue)?\s*quota|(?:own|owns|responsible for|accountable for|deliver|meet|exceed)\s+(?:sales|revenue)\s+targets?)\b/;
const POLICY_PATTERN = /\b(?:policy[- ]only|policy development|regulatory policy|compliance policy|policy and compliance|governance framework|responsible ai policy|ethics policy)\b/;
const PRODUCT_MANAGER_PATTERN = /\b(?:product|program|project) manager\b/;
const COMMERCIAL_PATTERN = /\b(?:pre[- ]sales|presales|post[- ]sales|sales engineering|commercial|solutions consultant|solution consultant)\b/;
const SECURITY_GOVERNANCE_STRATEGY_PATTERN = /\b(?:security specialist|security lead|responsible ai|ai governance|governance lead|governance manager|strategy lead|ai strategy|risk and compliance)\b/;
const TECHNICAL_AUTHORITY_PATTERN = /\b(?:technical direction|technical strategy|technical roadmap|architecture quality|architecture standards|architectural standards|engineering standards|platform strategy|platform architecture|system architecture|system design|systems design|production architecture|(?:ai|ml|llm|machine learning|platform|solution|security) architecture|architecture ownership|architecture authority|design authority|architectural decisions?|technical decisions?|implementation authority|implementation governance|implementation design|own technical|lead technical|technical leadership|architecture reviews?|design reviews?|build and deploy|implement(?:ation)? of ai|deploy ai|production ai)\b/;
const AI_ARCHITECTURE_CONTEXT_PATTERN = /\b(?:ai|artificial intelligence|gen ai|genai|generative ai|agentic ai|llm|large language model|machine learning|ml|ml platform|mlops)\b(?:\s+\w+){0,3}\s+(?:architect(?:ure|ural)?|system design|platform(?: strategy| architecture)?|technical direction|production architecture|production ai)\b|\b(?:architect(?:ure|ural)?|system design|platform(?: strategy| architecture)?|technical direction|production architecture|production ai)\b(?:\s+\w+){0,3}\s+(?:ai|artificial intelligence|gen ai|genai|generative ai|agentic ai|llm|large language model|machine learning|ml|ml platform|mlops)\b/;
const HANDS_ON_PATTERN = /\b(?:hands[- ]on|coding|code|implement|implementation|build|develop|development|prototype|production delivery|ship)\b/;
const MANAGEMENT_SCOPE_PATTERN = /\b(?:people management|manage|managing|leadership|hiring|mentoring|organizational design|organisation design|budget(?:ing)?|headcount|roadmap ownership|cross[- ]team|cross[- ]functional)\b/;
const GROWTH_PATTERN = /\b(?:path to|progression to|grow(?:th)? into|next step|promotion|head of|director|vp|vice president|distinguished architect|organizational remit|organisation remit)\b/;
const SCOPE_OWNERSHIP_PATTERN = /\b(?:own(?:s|ing)?|lead(?:s|ing)?|manage(?:s|d|ing)?|oversee(?:s|n)?|direct(?:s|ing)?|responsible for|accountable for)\b.{0,100}\b(?:multiple teams?|multi[- ]team|several teams?|two or more teams?|two teams?|multiple workstreams?|multi[- ]workstream|across\s+(?:two|three|four|five|six|seven|eight|nine|ten|\d+)\s+teams?|department|platform group|engineering practice|business unit|portfolio|org[- ]wide)\b/;
const ORGANIZATIONAL_REMIT_PATTERN = /\b(?:own(?:s|ing)?|lead(?:s|ing)?|manage(?:s|d|ing)?|oversee(?:s|n)?|direct(?:s|ing)?|responsible for|accountable for)\b.{0,100}\b(?:department|platform group|engineering practice|business unit|portfolio|organization(?:al)? remit|organisation(?:al)? remit|org[- ]wide|function|organizational (?:ai )?(?:platform )?(?:strategy|architecture|engineering|scope|remit)|organisational (?:ai )?(?:platform )?(?:strategy|architecture|engineering|scope|remit))\b/;

function asText(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(' ');
  if (typeof value === 'object') return Object.values(value).map(asText).filter(Boolean).join(' ');
  return String(value).trim();
}

function normalize(value) {
  return asText(value)
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasAny(text, values) {
  const padded = ` ${text} `;
  return values.some((value) => padded.includes(` ${value} `));
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function clampConfidence(value, provisional) {
  let confidence = Math.max(0, Math.min(1, value));
  if (provisional) confidence = Math.min(confidence, 0.65);
  return Number(confidence.toFixed(3));
}

function evidenceConfidence({ title, description, jobFunction, industries, decisive, signalCount = 0, provisional }) {
  let value = 0;
  if (title) value += 0.35;
  if (description) value += 0.4;
  if (jobFunction) value += 0.15;
  if (industries) value += 0.1;
  value += Math.min(0.2, signalCount * 0.04);
  if (decisive) value += 0.15;
  return clampConfidence(Math.max(0.05, value), provisional);
}

function dataGapFor({ body, title, aiCentral, dataSignals, dataDominated, dataScopeEvidence }) {
  const isDataRole = /\b(?:data and ai|ai and data|data ai|ai data) architect\b/.test(title)
    || (/\b(?:data|ai)\b.*\b(?:data|ai)\b.*\barchitect\b/.test(title)
      && /\b(?:data|ai)\b/.test(title))
    || /\b(?:data and ai|ai and data) architect\b/.test(body);
  const applies = Boolean(isDataRole || dataDominated || dataScopeEvidence);
  const presentSkills = DATA_GAP_SKILLS.filter((skill) => {
    const pattern = DATA_PATTERNS.find(([name]) => name === skill)?.[1];
    return pattern ? pattern.test(body) : false;
  });
  const missingSkills = applies
    ? DATA_GAP_SKILLS.filter((skill) => !presentSkills.includes(skill))
    : [];

  return {
    applies,
    aiCentral: Boolean(aiCentral),
    dataDominated: Boolean(dataDominated),
    presentSkills,
    missingSkills,
    requiredInPosting: unique(dataSignals),
    secondaryEvidence: Boolean(dataScopeEvidence),
  };
}

function leadershipEvaluationFor({
  isLeadership,
  body,
  title,
  technicalOwnership,
  technicalEvidence,
  scope,
  organizationalInfluence,
  growthPath,
  hybrid,
}) {
  const handsOn = HANDS_ON_PATTERN.test(body);
  const management = MANAGEMENT_SCOPE_PATTERN.test(body) || isLeadership;
  let handsOnTransitionRisk = 'unknown';
  if (management && handsOn) handsOnTransitionRisk = 'medium';
  else if (management && /\b(?:hands[- ]off|no coding|primarily people|mostly people)\b/.test(body)) handsOnTransitionRisk = 'high';
  else if (management) handsOnTransitionRisk = 'high';
  else if (handsOn) handsOnTransitionRisk = 'low';

  return {
    isLeadership: Boolean(isLeadership),
    teamScope: {
      engineers: scope.engineers,
      teams: scope.teams,
      multipleTeams: scope.multipleTeams,
      organizationalRemit: scope.organizationalRemit,
      evidence: scope.evidence,
    },
    technicalOwnership: {
      present: Boolean(technicalOwnership),
      evidence: technicalEvidence,
    },
    organizationalInfluence: {
      present: Boolean(organizationalInfluence),
      evidence: organizationalInfluence ? ['cross-team or organizational responsibility'] : [],
    },
    growthPath: {
      present: Boolean(growthPath),
      evidence: growthPath ? ['explicit progression or broader remit signal'] : [],
    },
    handsOnTransitionRisk,
    hybridArchitectureLeadership: Boolean(hybrid),
    scopeFloorMet: Boolean(scope.engineers >= 8 || scope.multipleTeams || scope.organizationalRemit),
    title,
  };
}

function emptyLeadershipEvaluation(title) {
  return leadershipEvaluationFor({
    isLeadership: false,
    body: '',
    title,
    technicalOwnership: false,
    technicalEvidence: [],
    scope: { engineers: null, teams: null, multipleTeams: false, organizationalRemit: false, evidence: [] },
    organizationalInfluence: false,
    growthPath: false,
    hybrid: false,
  });
}

function makeReason(label, summary, evidence = [], gaps = [], extra = {}) {
  return {
    summary,
    evidence: unique(evidence),
    gaps: unique(gaps),
    classification: label,
    queryUsedAsEvidence: false,
    ...extra,
  };
}

function buildResult({
  label,
  confidence,
  reason,
  signals,
  leadershipEvaluation,
  dataGap,
  provisional,
}) {
  return {
    label,
    confidence: clampConfidence(confidence, provisional),
    reason,
    signals,
    leadershipEvaluation,
    dataGap,
    provisional: Boolean(provisional),
  };
}

const NUMBER_WORDS = Object.freeze({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
});

const OWNERSHIP_VERB_PATTERN = /\b(?:own(?:s|ing)?|lead(?:s|ing)?|define|defines|defining|set|sets|setting|drive|drives|driving|oversee(?:s|ing)?|direct(?:s|ing)?|establish(?:es|ing)?|govern(?:s|ing)?|responsible for|accountable for)\b/;

function countEngineers(body) {
  const numeric = [...body.matchAll(/\b(?:team of|manage(?:s|d|ing)?|lead(?:s|ing)?|over|approximately|around|of|with)?\s*(\d{1,3})\s*(?:\+|[-–]\d+)?\s*(?:engineers?|developers?|people|direct reports?)\b/g)]
    .map((match) => Number(match[1]));
  const written = [...body.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:\+|[-–](?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))?\s*(?:engineers?|developers?|people|direct reports?)\b/g)]
    .map((match) => NUMBER_WORDS[match[1]]);
  const values = [...numeric, ...written];
  return values.length ? Math.max(...values) : null;
}

function countTeams(body) {
  const numeric = [...body.matchAll(/\b(\d{1,2})\s*(?:engineering\s+)?teams?\b/g)].map((match) => Number(match[1]));
  const written = [...body.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:engineering\s+)?teams?\b/g)]
    .map((match) => NUMBER_WORDS[match[1]]);
  const values = [...numeric, ...written];
  return values.length ? Math.max(...values) : null;
}

function hasTechnicalOwnership(body) {
  if (!OWNERSHIP_VERB_PATTERN.test(body) || !TECHNICAL_AUTHORITY_PATTERN.test(body)) return false;
  return /\b(?:own(?:s|ing)?|lead(?:s|ing)?|define|defines|defining|set|sets|setting|drive|drives|driving|oversee(?:s|ing)?|direct(?:s|ing)?|establish(?:es|ing)?|govern(?:s|ing)?|responsible for|accountable for)\b.{0,120}\b(?:technical direction|technical strategy|technical roadmap|architecture|platform|system design|production|implementation|engineering standards|technical decisions?)\b/.test(body)
    || /\b(?:technical direction|technical strategy|technical roadmap|architecture quality|architecture standards|engineering standards|platform strategy|architecture ownership|architecture authority|design authority|technical decisions?|implementation authority|implementation governance|technical leadership)\b.{0,100}\b(?:ownership|authority|accountable|responsible)\b/.test(body);
}

function classifyRole(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const titleRaw = asText(source.title);
  const descriptionRaw = asText(source.descriptionText);
  const jobFunctionRaw = asText(source.jobFunction);
  const industriesRaw = asText(source.industries);
  const provisional = Boolean(source.provisional);
  void source.query;

  const title = normalize(titleRaw);
  const description = normalize(descriptionRaw);
  const jobFunction = normalize(jobFunctionRaw);
  const industries = normalize(industriesRaw);
  const body = [description, jobFunction, industries].filter(Boolean).join(' ');
  const allEvidence = [title, body].filter(Boolean).join(' ');

  const titleHasAi = hasAny(title, AI_TOKENS);
  const bodyHasAi = hasAny(body, AI_TOKENS);
  const adjacentTitle = matchesAny(title, ADJACENT_TITLE_PATTERNS);
  const titleHasArchitecture = /\b(?:architect|architecture)\b/.test(title);
  const technicalDenial = /\b(?:no|without|lack(?:s)? of|not)\s+(?:technical|system|systems|production|platform|architecture|architectural|implementation)\b/.test(body)
    || /\bno\b.{0,80}\b(?:technical|architecture|platform|implementation)\b/.test(body);
  const aiResponsibility = bodyHasAi && !technicalDenial && AI_ARCHITECTURE_CONTEXT_PATTERN.test(body);
  const aiCentral = titleHasAi || aiResponsibility;
  const technicalArchitecture = !technicalDenial && (hasAny(allEvidence, ARCHITECTURE_TOKENS) || matchesAny(allEvidence, [TECHNICAL_AUTHORITY_PATTERN]));
  const aiArchitecture = !adjacentTitle && ((titleHasAi && titleHasArchitecture)
    || (bodyHasAi && AI_ARCHITECTURE_CONTEXT_PATTERN.test(body))
    || /\b(?:design|own|lead|define|deliver)\b.{0,80}\b(?:ai|llm|machine learning|ml)\b.{0,80}\b(?:architecture|platform|system|production)\b/.test(body));

  const dataSignals = DATA_PATTERNS.filter(([, pattern]) => pattern.test(body)).map(([name]) => name);
  const dataRoleTitle = /\b(?:data and ai|ai and data|data ai|ai data) architect\b/.test(title)
    || (/\b(?:data|ai)\b.*\b(?:data|ai)\b.*\barchitect\b/.test(title)
      && /\b(?:data|ai)\b/.test(title));
  const dataDominated = dataSignals.length >= 4
    || /\b(?:primarily|predominantly|mostly|mainly)\s+(?:data|data platform|data architecture)\b/.test(body)
    || (dataSignals.length >= 3 && (dataRoleTitle || /\bdata platform\b/.test(body)))
    || (titleHasAi && dataSignals.length >= 5 && !/\b(?:agentic|llm|generative ai|genai)\b/.test(body));
  const dataScopeEvidence = dataSignals.length >= 2 && (
    /\b(?:secondary|supporting|specialist|required|required experience|must have|experience with|expertise in|responsible for|own|design|build|manage|lead)\b/.test(body)
    || /\b(?:data|lakehouse|warehouse|spark|databricks|snowflake)\b.{0,80}\b(?:required|secondary|supporting|specialist|experience|expertise)\b/.test(body)
  );
  const dataGap = dataGapFor({ body, title, aiCentral, dataSignals, dataDominated, dataScopeEvidence });

  const titleSignals = [];
  const descriptionSignals = [];
  if (titleHasAi) titleSignals.push('AI or machine-learning scope in title');
  if (titleHasArchitecture) titleSignals.push('architecture scope in title');
  if (technicalArchitecture) descriptionSignals.push('system, production, platform, or technical architecture evidence');
  if (dataSignals.length) descriptionSignals.push(`data-specialist signals: ${dataSignals.join(', ')}`);

  const exclusion = [];
  if (/\bsoftware engineer\b/.test(title)) exclusion.push('title contains Software Engineer');
  if (/\bdata scientist\b/.test(title)) exclusion.push('title contains Data Scientist');
  if (/\bresearch scientist\b/.test(title)) exclusion.push('title contains Research Scientist');
  if (GENERIC_DATA_ARCHITECTURE_TITLE_PATTERN.test(title) && !dataRoleTitle) exclusion.push('generic data-architecture title');
  if (NON_SOFTWARE_ARCHITECTURE_PATTERN.test(title)) exclusion.push('non-software architecture title');
  const nonSoftwareBody = titleHasArchitecture && CONSTRUCTION_DOMAIN_BODY_PATTERN.test(body);
  if (nonSoftwareBody) exclusion.push('non-software architecture responsibilities');
  if (SALES_TITLE_PATTERN.test(title) || QUOTA_OWNERSHIP_PATTERN.test(title) || QUOTA_OWNERSHIP_PATTERN.test(body)) exclusion.push('quota-led or sales-led commercial role');

  const leadWithPeopleScope = /\b(?:ai engineering|ai platform|ml platform|ai technical) lead\b/.test(title)
    && /\b(?:manage|managing|team|engineers?|hiring|people|headcount)\b/.test(body);
  const leadershipTitle = LEADERSHIP_TITLE_PATTERN.test(title)
    || (LEADERSHIP_WORD_PATTERN.test(title) && LEADERSHIP_AI_PATTERN.test(title))
    || leadWithPeopleScope;
  const relevantLeadershipScope = leadershipTitle && (LEADERSHIP_AI_PATTERN.test(title) || LEADERSHIP_AI_PATTERN.test(body));
  const teamCount = countTeams(body);
  const scope = {
    engineers: countEngineers(body),
    teams: teamCount,
    multipleTeams: SCOPE_OWNERSHIP_PATTERN.test(body),
    organizationalRemit: ORGANIZATIONAL_REMIT_PATTERN.test(body),
    evidence: [],
  };
  if (scope.engineers !== null) scope.evidence.push(`${scope.engineers}+ engineers or people in scope`);
  if (scope.teams !== null) scope.evidence.push(`${scope.teams} teams in scope`);
  if (scope.multipleTeams) scope.evidence.push('multiple teams or workstreams');
  if (scope.organizationalRemit) scope.evidence.push('organizational or platform remit');

  const technicalOwnership = !technicalDenial && hasTechnicalOwnership(body);
  const technicalEvidence = technicalOwnership
    ? ['explicit technical direction, architecture, platform, or implementation authority']
    : [];
  const organizationalInfluence = scope.multipleTeams || scope.organizationalRemit || (technicalOwnership && /\bcross[- ](?:team|functional)|org[- ]wide\b/.test(body));
  const growthPath = GROWTH_PATTERN.test(body) || scope.organizationalRemit;
  const hybrid = technicalOwnership && (HANDS_ON_PATTERN.test(body) || aiArchitecture);
  const leadershipEvaluation = relevantLeadershipScope
    ? leadershipEvaluationFor({ isLeadership: true, body, title, technicalOwnership, technicalEvidence, scope, organizationalInfluence, growthPath, hybrid })
    : emptyLeadershipEvaluation(title);

  const signals = {
    title: titleRaw,
    evidenceFields: unique([
      title ? 'title' : '',
      description ? 'descriptionText' : '',
      jobFunction ? 'jobFunction' : '',
      industries ? 'industries' : '',
    ]),
    titleSignals,
    descriptionSignals,
    aiCentral,
    aiArchitecture,
    technicalArchitecture,
    leadership: relevantLeadershipScope,
    technicalOwnership,
    hybridArchitectureLeadership: hybrid,
    dataSignals,
    dataDominated,
    exclusions: exclusion,
    queryUsed: false,
  };

  const baseConfidence = evidenceConfidence({
    title,
    description,
    jobFunction,
    industries,
    decisive: exclusion.length > 0 || aiArchitecture || technicalOwnership,
    signalCount: titleSignals.length + descriptionSignals.length,
    provisional,
  });

  if (exclusion.length) {
    return buildResult({
      label: 'Out of scope',
      confidence: Math.max(baseConfidence, 0.85),
      reason: makeReason('Out of scope', `Excluded because ${exclusion.join('; ')}.`, exclusion, []),
      signals,
      leadershipEvaluation,
      dataGap,
      provisional,
    });
  }

  const productManagerWithoutEngineering = PRODUCT_MANAGER_PATTERN.test(title) && !technicalOwnership;
  if (productManagerWithoutEngineering) {
    const reason = 'Product, program, or project management without technical architecture or engineering ownership.';
    return buildResult({
      label: 'Out of scope',
      confidence: Math.max(baseConfidence, 0.82),
      reason: makeReason('Out of scope', reason, ['manager title without technical ownership'], ['technical architecture or engineering authority']),
      signals,
      leadershipEvaluation,
      dataGap,
      provisional,
    });
  }

  if (dataDominated && aiCentral) {
    return buildResult({
      label: 'Out of scope',
      confidence: Math.max(baseConfidence, 0.8),
      reason: makeReason('Out of scope', 'The posting is dominated by specialist data-platform architecture rather than ordinary AI architecture.', dataSignals.map((signal) => `${signal} responsibility`), dataGap.missingSkills),
      signals,
      leadershipEvaluation,
      dataGap,
      provisional,
    });
  }

  const solutionsArchitectureManager = /\bsolutions architecture manager\b/.test(title);
  const commercialSolutionsManager = solutionsArchitectureManager && /\b(?:pre[- ]sales|presales|sales|commercial|quota|revenue|customer)\b/.test(allEvidence);
  const coreGovernanceArchitecture = titleHasAi && titleHasArchitecture && /\b(?:governance|security)\b/.test(title);
  const isConditional = !coreGovernanceArchitecture && (COMMERCIAL_PATTERN.test(allEvidence)
    || commercialSolutionsManager
    || SECURITY_GOVERNANCE_STRATEGY_PATTERN.test(allEvidence));
  const policyOnlyEvidence = POLICY_PATTERN.test(allEvidence) || /\b(?:governance|strategy|compliance)\b/.test(title);
  const isPolicyOnly = policyOnlyEvidence && !technicalOwnership
    && !(coreGovernanceArchitecture && !POLICY_PATTERN.test(allEvidence));

  if (isConditional) {
    if (!technicalOwnership) {
      return buildResult({
        label: 'Out of scope',
        confidence: Math.max(baseConfidence, 0.76),
        reason: makeReason('Out of scope', 'Commercial, security, governance, or strategy scope lacks substantial technical architecture or implementation authority.', ['conditional domain wording'], ['technical architecture or implementation authority']),
        signals,
        leadershipEvaluation,
        dataGap,
        provisional,
      });
    }
    return buildResult({
      label: 'Conditional',
      confidence: baseConfidence,
      reason: makeReason('Conditional', 'The role is eligible only because its commercial, security, governance, or strategy remit includes substantial technical architecture or implementation authority.', [...technicalEvidence, ...(aiArchitecture ? ['AI architecture evidence'] : [])], []),
      signals,
      leadershipEvaluation,
      dataGap,
      provisional,
    });
  }

  if (isPolicyOnly) {
    return buildResult({
      label: 'Out of scope',
      confidence: Math.max(baseConfidence, 0.78),
      reason: makeReason('Out of scope', 'Policy, governance, or strategy scope is present without substantial technical architecture or implementation authority.', ['policy or governance wording'], ['technical architecture or implementation authority']),
      signals,
      leadershipEvaluation,
      dataGap,
      provisional,
    });
  }

  if (relevantLeadershipScope) {
    if (!technicalOwnership) {
      return buildResult({
        label: 'Out of scope',
        confidence: Math.max(baseConfidence, 0.78),
        reason: makeReason('Out of scope', 'Leadership scope is relevant to AI, but the posting does not evidence the required technical-direction or architecture ownership.', ['AI leadership scope'], ['technical direction, architecture quality, engineering standards, or platform strategy']),
        signals,
        leadershipEvaluation,
        dataGap,
        provisional,
      });
    }

    const progression = scope.engineers >= 8 || scope.multipleTeams || scope.organizationalRemit;
    const label = progression ? 'Leadership progression' : 'Leadership lateral';
    const gaps = [];
    if (!scope.evidence.length) gaps.push('team scope is small or not stated');
    if (!growthPath) gaps.push('growth path is not explicit');
    if (leadershipEvaluation.handsOnTransitionRisk === 'high') gaps.push('high hands-on-to-management transition risk');
    const summary = progression
      ? 'AI/engineering leadership owns technical direction with 8+ engineers, multiple teams, or an organizational remit.'
      : 'AI/engineering leadership owns technical direction, but team scope is small or unknown and remains a lateral transition.';
    return buildResult({
      label,
      confidence: baseConfidence,
      reason: makeReason(label, summary, [...technicalEvidence, ...scope.evidence, ...(hybrid ? ['hybrid architecture leadership'] : [])], gaps, {
        teamScope: leadershipEvaluation.teamScope,
        technicalOwnership: leadershipEvaluation.technicalOwnership,
        organizationalInfluence: leadershipEvaluation.organizationalInfluence,
        growthPath: leadershipEvaluation.growthPath,
        handsOnTransitionRisk: leadershipEvaluation.handsOnTransitionRisk,
        hybridArchitectureLeadership: hybrid,
      }),
      signals,
      leadershipEvaluation,
      dataGap,
      provisional,
    });
  }

  if (dataGap.applies && aiCentral && !dataDominated) {
    const dataScopeSummary = dataGap.secondaryEvidence
      ? 'AI architecture is central and specialist data responsibilities are evidenced as secondary; treat the data gap as disclosed stretch risk.'
      : 'AI/data architecture is central, but the posting does not establish the depth or scope of specialist data responsibilities; treat this as a disclosed stretch requiring verification.';
    const dataGaps = [...dataGap.missingSkills];
    if (!dataGap.secondaryEvidence) dataGaps.push('secondary data responsibility scope not evidenced');
    return buildResult({
      label: 'Data-domain stretch',
      confidence: baseConfidence,
      reason: makeReason('Data-domain stretch', dataScopeSummary, ['AI architecture is central', ...dataSignals.map((signal) => `${signal} signal`)], dataGaps),
      signals,
      leadershipEvaluation,
      dataGap,
      provisional,
    });
  }

  if (aiArchitecture) {
    return buildResult({
      label: 'Exact architecture',
      confidence: baseConfidence,
      reason: makeReason('Exact architecture', 'AI architecture is explicit in the title or in the technical responsibilities.', [...titleSignals, ...descriptionSignals], []),
      signals,
      leadershipEvaluation,
      dataGap,
      provisional,
    });
  }

  const adjacentEvidence = !technicalDenial && (
    hasAny(body, ARCHITECTURE_TOKENS)
    || TECHNICAL_AUTHORITY_PATTERN.test(body)
    || /\b(?:system design|production|platform decisions?|technical leadership|technical direction)\b/.test(body)
  );
  if (adjacentTitle && aiCentral && adjacentEvidence) {
    return buildResult({
      label: 'Adjacent technical',
      confidence: baseConfidence,
      reason: makeReason('Adjacent technical', 'The role is an adjacent AI technical-leadership title with evidence of system design, production architecture, platform decisions, or technical leadership.', [...titleSignals, ...descriptionSignals], []),
      signals,
      leadershipEvaluation,
      dataGap,
      provisional,
    });
  }

  return buildResult({
    label: 'Out of scope',
    confidence: Math.max(baseConfidence, title || description || jobFunction ? 0.35 : 0.1),
    reason: makeReason('Out of scope', aiCentral ? 'The role is AI-related but does not evidence the architecture or technical-leadership depth required by the taxonomy.' : 'The role does not make AI architecture central to its title or responsibilities.', aiCentral ? ['AI-related title or responsibilities'] : [], ['explicit AI architecture, production system design, platform decisions, or technical leadership']),
    signals,
    leadershipEvaluation,
    dataGap,
    provisional,
  });
}

const QUERY_EXPANSIONS = [
  'AI Architect',
  'AI/ML Architect',
  'Generative AI Architect',
  'GenAI Architect',
  'Agentic AI Architect',
  'LLM Architect',
  'Enterprise AI Architect',
  'AI Platform Architect',
  'AI Solutions Architect',
  'Applied AI Architect',
  'Forward Deployed Architect',
  'Forward Deployed Engineer',
  'AI Customer Engineer',
  'AI Field Engineer',
  'AI Integration Architect',
  'AI Infrastructure Architect',
  'Principal AI Architect',
  'Principal AI Engineer',
  'Staff AI Engineer',
  'Lead AI Engineer',
  'Applied AI Engineer',
  'AI Technical Lead',
  'AI Engineering Lead',
  'AI Platform Lead',
  'ML Platform Lead',
  'MLOps Architect',
  'AI Enablement Architect',
  'Data & AI Architect',
  'Engineering Manager AI/ML',
  'Engineering Manager AI Platform',
  'Head of AI Engineering',
  'Head of AI Platform',
  'Director of AI Engineering',
  'Solutions Architecture Manager AI',
  'Technical Delivery Manager AI',
  'AI Pre-Sales Solutions Architect',
  'AI Security Specialist',
  'AI Governance Lead',
  'AI Strategy Lead',
];

const QUERY_EXCLUSION_PATTERN = /\bsoftware engineer\b|\bdata scientist\b|\bresearch scientist\b|\b(?:data|data platform|data warehouse|data lakehouse) architect\b|\b(?:building|construction|interior|landscape|civil|structural|mechanical|electrical|bim|revit|autocad)\b|\b(?:account executive|sales executive|sales director|quota[- ](?:led|carrying|bearing)|sales quota|revenue quota)\b|\b(?:product|program|project) manager\b/;

function expandRoleQueries(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const { targetRole, similarRoles, maxQueries = DEFAULT_MAX_QUERIES } = source;
  const limit = Number.isFinite(Number(maxQueries))
    ? Math.min(MAX_QUERIES, Math.max(0, Math.floor(Number(maxQueries))))
    : DEFAULT_MAX_QUERIES;
  if (limit === 0) return [];
  const supplied = [targetRole, ...(Array.isArray(similarRoles) ? similarRoles : [similarRoles])]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map(asText)
    .map((value) => value.trim())
    .filter(Boolean);
  if (!supplied.length) return [];

  const target = normalize(targetRole);
  const candidates = [...supplied];
  if (target.includes('architect') || target.includes('ai') || target.includes('llm') || target.includes('machine learning') || target.includes('lead') || target.includes('manager')) {
    candidates.push(...QUERY_EXPANSIONS);
  } else {
    candidates.push(...QUERY_EXPANSIONS.filter((query) => normalize(query).includes(target)));
  }

  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    const key = normalize(candidate);
    if (!key || seen.has(key) || QUERY_EXCLUSION_PATTERN.test(key)) continue;
    seen.add(key);
    result.push(candidate);
    if (result.length >= limit) break;
  }
  return result;
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
}

function assertArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
}

function assertRoleClassification(result) {
  assertPlainObject(result, 'Role classification');
  if (!ROLE_LABEL_SET.has(result.label)) throw new Error(`Unknown role classification label: ${String(result.label)}`);
  if (typeof result.confidence !== 'number' || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) {
    throw new Error('Role classification confidence must be a finite number between 0 and 1');
  }
  assertPlainObject(result.reason, 'Role classification reason');
  if (typeof result.reason.summary !== 'string' || !result.reason.summary) throw new Error('Role classification reason.summary must be a non-empty string');
  if (result.reason.classification !== result.label) throw new Error('Role classification reason.classification must match label');
  assertArray(result.reason.evidence, 'Role classification reason.evidence');
  assertArray(result.reason.gaps, 'Role classification reason.gaps');
  if (result.reason.queryUsedAsEvidence !== false) throw new Error('Role classification reason must not use query text as evidence');

  assertPlainObject(result.signals, 'Role classification signals');
  for (const field of ['evidenceFields', 'titleSignals', 'descriptionSignals', 'dataSignals', 'exclusions']) assertArray(result.signals[field], `Role classification signals.${field}`);
  for (const field of ['aiCentral', 'aiArchitecture', 'technicalArchitecture', 'leadership', 'technicalOwnership', 'hybridArchitectureLeadership', 'dataDominated', 'queryUsed']) {
    if (typeof result.signals[field] !== 'boolean') throw new Error(`Role classification signals.${field} must be boolean`);
  }
  if (result.signals.queryUsed !== false) throw new Error('Role classification signals.queryUsed must be false');

  assertPlainObject(result.leadershipEvaluation, 'Role classification leadershipEvaluation');
  if (typeof result.leadershipEvaluation.isLeadership !== 'boolean') throw new Error('leadershipEvaluation.isLeadership must be boolean');
  assertPlainObject(result.leadershipEvaluation.teamScope, 'leadershipEvaluation.teamScope');
  assertArray(result.leadershipEvaluation.teamScope.evidence, 'leadershipEvaluation.teamScope.evidence');
  assertPlainObject(result.leadershipEvaluation.technicalOwnership, 'leadershipEvaluation.technicalOwnership');
  if (typeof result.leadershipEvaluation.technicalOwnership.present !== 'boolean') throw new Error('leadershipEvaluation.technicalOwnership.present must be boolean');
  assertArray(result.leadershipEvaluation.technicalOwnership.evidence, 'leadershipEvaluation.technicalOwnership.evidence');
  assertPlainObject(result.leadershipEvaluation.organizationalInfluence, 'leadershipEvaluation.organizationalInfluence');
  assertPlainObject(result.leadershipEvaluation.growthPath, 'leadershipEvaluation.growthPath');
  if (typeof result.leadershipEvaluation.hybridArchitectureLeadership !== 'boolean') throw new Error('leadershipEvaluation.hybridArchitectureLeadership must be boolean');

  assertPlainObject(result.dataGap, 'Role classification dataGap');
  for (const field of ['applies', 'aiCentral', 'dataDominated', 'secondaryEvidence']) {
    if (typeof result.dataGap[field] !== 'boolean') throw new Error(`dataGap.${field} must be boolean`);
  }
  for (const field of ['presentSkills', 'missingSkills', 'requiredInPosting']) assertArray(result.dataGap[field], `dataGap.${field}`);
  if (typeof result.provisional !== 'boolean') throw new Error('Role classification provisional must be boolean');

  try {
    JSON.stringify(result.reason);
  } catch (error) {
    throw new Error(`Role classification reason must be JSON serializable: ${error.message}`);
  }
  return result;
}

export { classifyRole, expandRoleQueries, assertRoleClassification };
