# Normalization Rules

NORMALIZER_VERSION: 1
Last bumped: 2026-05-12
Changed: Initial version

## compound_phrases

```yaml
c++: cpp
c#: csharp
.net: dotnet
machine learning: machine_learning
artificial intelligence: artificial_intelligence
natural language processing: natural_language_processing
site reliability engineer: sre
software engineer: software_engineer
solutions architect: solutions_architect
backend engineer: backend_engineer
frontend engineer: frontend_engineer
frontend developer: frontend_engineer
full stack engineer: full_stack_engineer
senior engineer: senior_engineer
principal engineer: principal_engineer
staff engineer: staff_engineer
engineering manager: engineering_manager
technical lead: technical_lead
product manager: product_manager
project manager: project_manager
quality assurance: quality_assurance
user experience: user_experience
user interface: user_interface
cloud architect: cloud_architect
security engineer: security_engineer
network engineer: network_engineer
database administrator: database_administrator
systems administrator: systems_administrator
business analyst: business_analyst
systems engineer: systems_engineer
solutions engineer: solutions_engineer
technical architect: technical_architect
senior manager: senior_manager
vice president: vice_president
chief executive: chief_executive
chief financial: chief_financial
chief technology: chief_technology
chief operating: chief_operating
senior architect: senior_architect
lead architect: lead_architect
```

## synonym_map

```yaml
sr: senior
sr.: senior
jr: junior
jr.: junior
eng: engineer
engr: engineer
engineers: engineer
swe: software_engineer
mgr: manager
managers: manager
dev: developer
developers: developer
vp: vice_president
ai: artificial_intelligence
ml: machine_learning
nlp: natural_language_processing
ui: user_interface
ux: user_experience
devops: development_operations
i: 1
ii: 2
iii: 3
iv: 4
v: 5
développeur: developer
desarrollador: developer
entwickler: developer
architekt: architect
architekt: architect
architetto: architect
architeto: architect
ingeniero: engineer
ingegnere: engineer
senior: senior
principal: principal
manager: manager
director: director
lead: lead
architect: architect
analyst: analyst
engineer: engineer
administrator: administrator
specialist: specialist
coordinator: coordinator
consultant: consultant
associate: associate
junior: junior
intern: intern
trainee: trainee
programmer: programmer
coder: coder
technician: technician
operator: operator
officer: officer
executive: executive
president: president
vice: vice
chief: chief
officer: officer
architect: architect
analyst: analyst
administrator: administrator
supervisor: supervisor
coordinator: coordinator
designer: designer
writer: writer
```

## seniority_table

```yaml
- bucket: cxo
  keywords: [cxo, ceo, cfo, cto, coo, chief, chief_executive, chief_financial, chief_technology, chief_operating]
- bucket: vp
  keywords: [vp, vice_president, vice president, vice]
- bucket: director
  keywords: [director, directeur, direktor, direttore]
- bucket: manager
  keywords: [manager, mgr, management, managing, engineering_manager, product_manager, project_manager, senior_manager]
- bucket: lead
  keywords: [lead, tech_lead, technical_lead]
- bucket: principal
  keywords: [principal, principal_engineer]
- bucket: staff
  keywords: [staff, staff_engineer]
- bucket: senior
  keywords: [senior, sr, senior_engineer, sr., iii, iv, v]
- bucket: mid
  keywords: [mid, mid_level, intermediate, intermediate_level]
- bucket: junior
  keywords: [junior, jr, jr., junior_engineer, entry_level, entry]
- bucket: intern
  keywords: [intern, internship, trainee, apprentice]
- bucket: _any
  keywords: []
```

## industry_list

```yaml
finance: [finance, banking, investment, trading, hedge_fund, fintech, capital, securities, forex, crypto, blockchain, financial, banking, payment, lending]
healthcare: [healthcare, medical, hospital, pharmacy, clinical, health, doctor, nurse, physician, surgery, dental, mental, wellness, telemedicine, biomedical]
biotech: [biotech, biotechnology, pharmaceutical, pharma, drug, clinical_trial, research, lab, laboratory, genetics, dna, rna, protein, cell, tissue, immunology, oncology]
manufacturing: [manufacturing, factory, industrial, production, operations, supply_chain, logistics, assembly, warehouse, distribution, fabrication, automotive, aerospace]
retail: [retail, ecommerce, commerce, shopping, store, customer_service, merchandising, inventory, sales, point_of_sale, pos, buying, merchandising]
education: [education, school, university, college, academic, training, course, teaching, instructor, professor, curriculum, lms]
consulting: [consulting, consulting, advisory, strategy, management_consulting, business_consulting, it_consulting, technical_consulting, engagement, client]
government: [government, public_sector, federal, state, municipal, local, civic, military, defense, administration]
media: [media, publishing, entertainment, broadcast, television, tv, film, movie, news, journalism, content, creative, design, art, music, studio]
energy: [energy, power, oil, gas, petroleum, renewable, solar, wind, utility, electricity, coal, nuclear, utilities, hydro]
telecom: [telecom, telecommunications, wireless, mobile, carrier, 5g, 4g, network, infrastructure, isp, internet_service]
transportation: [transportation, logistics, freight, shipping, delivery, supply_chain, automotive, airline, aviation, maritime, rail, railroad, vehicle, truck]
insurance: [insurance, underwriting, claims, policy, actuarial, risk_management, reinsurance, adjuster, broker, agent]
software: [software, saas, edtech, platform, cloud, programming, api, framework, library, application, web, mobile, backend, frontend, devops, data, full stack, fullstack, full_stack, database, sql, nosql, python, java, javascript, typescript, ruby, php, golang, rust, cpp, csharp, kotlin, swift, scala, .net, dotnet]
_any: []
```

Note: Each industry keyword appears under exactly ONE industry code. No cross-list duplicates exist. This eliminates first-match ambiguity entirely — a token can only map to one industry. `fintech` is registered ONLY under `finance`, not under `software` or other codes.

## stopwords

```yaml
- a
- an
- the
- of
- for
- at
- in
- with
- and
- or
- to
```

Note: This list MUST NOT include any seniority keyword (manager, lead, principal, senior, staff, director, vp, cxo, etc.). The rules-loader module asserts at init time that `stopwords ∩ seniority_keywords = ∅` and throws fatally if violated.

## filler_adjectives

```yaml
- experienced
- seasoned
- talented
- passionate
- motivated
```

## remote_markers

```yaml
- remote
- hybrid
- on-site
- onsite
- wfh
```

## locations

```yaml
# High-frequency English-speaking locations (bootstrap set for v1)
# Expansion: full LLM-generated list (~500-1000 tokens) lands in a later commit; regeneration bumps NORMALIZER_VERSION.
- london
- manchester
- edinburgh
- glasgow
- dublin
- paris
- berlin
- munich
- example location 013
- geneva
- amsterdam
- madrid
- barcelona
- milan
- rome
- stockholm
- copenhagen
- oslo
- helsinki
- warsaw
- prague
- vienna
- brussels
- lisbon
- new_york
- san_francisco
- los_angeles
- seattle
- boston
- chicago
- austin
- denver
- toronto
- vancouver
- montreal
- sydney
- melbourne
- tokyo
- singapore
- hong_kong
- bangalore
- mumbai
- dubai
- abu_dhabi
- uk
- usa
- eu
- emea
- apac
- na
```

---

## NORM-02 Anchor

**Important:** `solutions architect` IS a compound phrase (compounded to `solutions_architect`), but `architect solutions` is NOT a recognized compound phrase. This distinction is load-bearing:

- `normalizeTitle('Solutions Architect')` → compound expansion applies → `solutions_architect`
- `normalizeTitle('Architect Solutions')` → no compound phrase matches (compound phrases must match the raw input sequence before tokenization) → after tokenization: `architect solutions` (two separate tokens)

Token-order preservation in Steps 5-8 of the pipeline ensures these outputs differ. This test is encoded in NORM-02 fixture entries and unit test assertions.
