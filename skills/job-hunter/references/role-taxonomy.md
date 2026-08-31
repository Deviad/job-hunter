# Role Taxonomy

Role **lists** are machine-read from `~/.job-hunter/personal-info-cache.json` under `rolePreferences` (per-user and editable). Classification **logic** is implemented in `scripts/role-taxonomy.mjs` and shared across search, discovery, scoring, and reporting. This document is the narrative policy rationale.

`ROLE_TAXONOMY_VERSION` identifies the deterministic rules used when a job is classified. New or refreshed rows store the current version; null means the row predates versioned classification and needs audit or reclassification before its label is treated as current.

## Direction

Broaden the AI Architect search into two legitimate career paths:

1. **Architecture progression** — deeper principal, enterprise, platform, and AI architecture ownership.
2. **Leadership progression** — people-management roles with meaningful AI/engineering scope and credible growth toward Head, Director, or VP responsibility.

Do not reject people-management roles solely because they are less hands-on. Treat them as a separate progression category and evaluate actual scope, organizational influence, and growth opportunity. Pure people management is acceptable when the role remains in a relevant AI/platform domain and represents a clear increase in responsibility; label it as a leadership transition rather than an exact architecture match.

## Classification labels

Every role receives exactly one of these labels:

- **Exact architecture** — AI architecture roles, including AI/ML, generative AI, agentic AI/LLM, enterprise AI, solutions, platform, infrastructure, integration, security/governance, chief/principal/lead/senior AI architect, and principal AI/ML architect roles.
- **Adjacent technical** — principal/staff/lead AI or applied-AI engineering, AI technical or engineering leadership, principal/staff/lead AI-platform engineering, ML platform lead, MLOps architect, and AI enablement architect roles. The work must demonstrate system design, architecture ownership, production AI delivery, platform decisions, or technical leadership—not only feature implementation.
- **Leadership progression** — AI/ML or AI-platform engineering management, senior engineering management, Head/Director of AI Engineering or AI Platform, AI Engineering Director, AI solutions-architecture management, and technical delivery management where architecture and engineering scope is substantial. Apply the hard requirement and scope floor below.
- **Leadership lateral** — otherwise qualifying people-management roles below the progression scope floor. Score them for transition risk, growth potential, team scope, and loss of hands-on responsibility.
- **Conditional** — commercial or governance roles included only when they own substantial technical architecture, implementation governance, or enterprise technology decisions. This includes AI pre-sales solutions architect, AI solutions architecture manager, principal AI security specialist, Responsible AI lead, AI governance lead, and AI strategy lead.
- **Data-domain stretch** — a `Data & AI Architect` role only when AI architecture is central and specialist data requirements are secondary. Explicitly disclose missing data-architecture skills.
- **Out of scope** — roles that fail the taxonomy, including the Always exclude categories below.

## Leadership requirement and scope

Leadership roles have a hard requirement: the role must own **technical direction, architecture quality, engineering standards, or platform strategy**. Reject delivery management dressed as engineering leadership—roles owning headcount and roadmap ceremonies but no technical authority—regardless of title. This technical authority keeps a management move reversible: an engineering manager who still owns technical direction can move back toward Principal or Distinguished Architect; a pure delivery manager generally cannot.

Beyond that hard requirement, people-management roles qualify when most of these criteria are present:

- The team owns AI products, AI platforms, ML infrastructure, or enterprise AI integration.
- Scope includes hiring, mentoring, organizational design, roadmap ownership, budgeting, or cross-team influence.
- The position is a genuine increase in scope from the user's current architect role.
- The company provides a credible path toward Head, Director, VP, Distinguished Architect, or equivalent responsibility.
- The role remains in the AI/cloud/enterprise-technology domain.

**Scope floor:** label a role **Leadership progression** only when scope reaches roughly 8+ engineers, multiple teams or workstreams, or an organizational remit such as a platform group, practice, or department. First-line management of a small 4–5-person feature team is usually lateral or downward from a senior architect role; below the floor, use **Leadership lateral**.

**Preference ordering:** hybrid architecture-plus-leadership roles are preferred over progression-qualifying pure management, which is preferred over leadership lateral: **hybrid > progression-qualifying pure management > leadership lateral**. Hybrid roles compound both tracks instead of trading architecture for management. Pure management can still qualify, but evaluate its transition risk, growth potential, team scope, and loss of hands-on responsibility.

## Conditional commercial and governance roles

Consider these roles only when they own substantial technical architecture, implementation governance, or enterprise technology decisions:

- AI Pre-Sales Solutions Architect
- AI Solutions Architecture Manager
- Principal AI Security Specialist
- Responsible AI Lead
- AI Governance Lead
- AI Strategy Lead

Exclude quota-led sales, policy-only governance, and strategy roles without delivery authority.

## Discovery query families

Search queries improve recall but never count as classification evidence. The shared expansion includes AI and applied-AI architecture, Forward Deployed Architect/Engineer, AI solutions/customer/field engineering, principal/staff/lead AI engineering, AI platform/MLOps, and AI engineering leadership families. A broad or unfamiliar title is still accepted only when its title and responsibilities satisfy the deterministic taxonomy.

### Explicit LinkedIn refresh

`--refresh-job-ids` is a bounded stale-data repair path, not a classifier signal or an unbounded recrawl. It accepts at most 50 numeric LinkedIn IDs, prioritizes those IDs for detail refresh, and leaves normal deduplication intact for every other job. Refreshed title and description text are reclassified with the current taxonomy version, and the row must be rescored before an application decision.

### Semantic shadow boundary

`jh-semantic-shadow.mjs` compares local embedding results with this deterministic taxonomy only in shadow mode. Its reports may identify disagreements or unfamiliar-title recovery, but they cannot update taxonomy rules, `jobs`, `match_results`, visible shortlists, fit scores, or application state. Local LLM adjudication and model-driven taxonomy mutation are outside the current policy.

## Non-software architecture boundary

Construction exclusion requires construction-domain evidence such as BIM, Revit, AutoCAD, civil or structural engineering, interior or landscape design, architectural design, or real estate responsibilities. The ordinary software verb “building” is not construction evidence: phrases such as “building and presenting demos” or “building production AI systems” must remain eligible when technical AI architecture evidence is present. Construction titles such as `AI Building Architect` and postings with BIM or construction duties remain out of scope.

## Data architecture boundary

The user's system-design, software and cloud architecture, DDD, microservices, event-driven architecture, APIs, SQL/NoSQL, migration, and enterprise-integration experience is transferable, but it does **not** equal professional Data Architect experience.

Therefore:

- Exclude generic `Data Architect`, `Principal Data Architect`, `Data Warehouse Architect`, and similar data-specialist titles by default.
- Do not treat Data Architect as an exact or ordinary adjacent match.
- Consider `Data & AI Architect` only when AI architecture is central and the role does not primarily require data modelling, data governance, lakehouse, warehouse, BI, Spark, Databricks, Snowflake, or equivalent specialist depth.
- Label accepted Data & AI roles **Data-domain stretch** and list missing data-architecture requirements explicitly.
- Never infer data-modelling, data-governance, warehouse, lakehouse, or analytics-platform expertise from general system-design or DDD experience.
- Run the data-specialist gap check on **responsibilities, not just the title**. An `AI Architect` posting dominated by lakehouse, pipelines, or warehousing is a data-platform role and must be classified by its real content, not its inflated title.
- Do not score **Data-domain stretch** as a pure negative. When the AI core is strong and data requirements are secondary, treat the stretch as disclosed risk with upside—the role may be a practical way to close the data-architecture gap—rather than as a disqualifier.

## Always exclude

- Any title containing `Software Engineer`, including Lead or Principal Software Engineer — AI.
- Generic architect roles without AI central to the title or responsibilities.
- Pure Data Architect and Data Warehouse Architect roles.
- AI Product, Program, or Project Manager roles without engineering ownership.
- Data Scientist and Research Scientist roles.
- Sales executives and quota-led commercial roles.
- Building, construction, interior, BIM, and similar non-software architecture.
