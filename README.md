# dsh-assembler — Vibe Assembly for DeepSeek Harness

English | [中文](README.zh.md)

**Assemble a working AI agent from one sentence — and be able to hand it over.**

`dsh-assembler` is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin. You describe the agent you want in plain language ("build me a support bot that can look up orders, open tickets, and hand off to a human"); the assembler matches parts from a **capability catalog**, emits an **agent preset**, and then **proves it works by running it in a real session**. New sessions pick that preset from the roster and go.

The catalog grows through an **induction pipeline**: open-source libraries, public APIs, a client's own HTTP interfaces, and a client's documents all enter through one command each — and only past a quality gate. No glue code, only configuration.

---

## Scale today

| | Measured | Where to verify |
|---|---|---|
| Catalog | **79 MCP servers / 215 registered tools / 237 assemblable entries** (229 federated + 8 static) | `index/catalog.yml` |
| Part mix | 61 library-backed + 13 service-backed + 4 first-party | same |
| Assembly wall time | median **56s** (single-turn 52s / scenario 182s) | ledgers in `bench/results/` |

---

## What it does

- **Two entry points** — the `/assemble <requirement>` command (human shortcut) and an `assemble` tool (agent-native: the whole call renders in the conversation).
- **Assemble-then-verify** — after emitting a preset, the assembler derives an acceptance probe, runs it in a **real session bound to that preset**, and judges the reply against content-bearing marks. A FAIL triggers one re-selection with the failure fed back, then re-probes. `find → assemble → **verify**`, on by default.
- **Multi-turn scenario probes** — the deriver picks the probe shape itself: one turn for pure-compute agents, a 2–4 turn scenario when the requirement implies work that outlives a turn (bookkeeping, filing, tracking). Scenario turns run in **one session**, and a later turn queries what an earlier turn wrote. Judgement stays black-box: replies only, never the trajectory.
- **Solution packs (the FDE unit of delivery)** — `solutions/<name>/solution.yml` declares an entire engagement: which agents, which catalog, deployment parameters, client knowledge. `solution apply` assembles them all, each through verification; `solution handover` **grows a delivery report out of the artifacts themselves**. Multi-tenant is `--param` plus a different credential set — never a forked manifest.
- **Knowledge packs (`via: knowledge`)** — a client's manuals, SOPs and product catalogues enter as **static teaching material**, past a **retrieval-hit gate** (a probe question whose expected snippet cannot be found is refused), and are **copied into the preset's `kb/`** at assembly time. The handover is one self-contained directory.
- **Credential contract (interface first, key later)** — parts **declare** the environment variable they need and what it is for; the **value never enters a preset**. Unconfigured, a part still starts, `listTools` still succeeds, and a call returns an **actionable error** (which variable, what for, where to get it). On the assembly side: assembly succeeds, the probe degrades to **SKIPPED** with configuration guidance. Optional credentials (GitHub public reads, polite-pool mailtos) take the anonymous path and do not hold verification back.
- **Client-private catalogs** — `catalogs/<client>/` carries its own `generated/`, `index/`, `capabilities.yml` and `knowledge/`. One client's parts **cannot** surface in another's assembly, because isolation is by **separate files**, not by a filter someone can forget.
- **Service-backed parts** — 13 live data services are wired in (weather, FX, geocoding, holidays, macro data, SEC filings, scholarly search, wiki facts, research graph, package intel, Feishu, Slack, GitHub Issues). A library part pins `repo@rev`; a service has no bytes to pin, so it pins **terms + rate limit + data licence** instead — and those travel into the BOM, because a client's compliance desk asks about them first.
- **Parts BOM** — every assembly emits `parts.lock.yml` beside the preset: per part its origin, licence, verified status and the serverName actually mounted, plus knowledge sources with versions and the pending-credential list.
- **Federation cache** — each part's tool list is cached under (connection config + adapter file fingerprint): cold ~5s, **warm 0.002s**.
- **persona lint** — mechanical checks on the persona text: every tool it names must be in the mounted surface, step-numbered choreography is rejected, length is bounded.
- **Design notes** — [DESIGN.md](DESIGN.md) (Chinese) states what the assembler does, what it deliberately does not, and where the boundary sits.

---

## Architecture

```
┌───────── Induction pipeline (supply chain) ────────────────────────────┐
│ OSS library / public API / client OpenAPI / client documents           │
│   → slice capabilities → MCP adapter → gate (smoke / retrieval) → catalog │
└───────────────────────────────────────────────────────────────────────┘
                              ↓
┌───────── Assembly (capability consumption) ───────────────────────────┐
│ capabilities.yml (public or client) + parallel federation → LLM match  │
│   → emit preset + BOM + copy knowledge into kb/                       │
│   → verify: derive probe (single-turn or scenario) → real session → PASS/FAIL │
└───────────────────────────────────────────────────────────────────────┘
                              ↓
┌───────── Delivery (FDE) ──────────────────────────────────────────────┐
│ solution apply (assemble every agent in the manifest)                 │
│   → solution handover: report (verdicts / params / pending secrets /  │
│     knowledge / BOM / rebuild command)                                │
└───────────────────────────────────────────────────────────────────────┘
                              ↓
┌───────── Runtime (the harness's territory) ───────────────────────────┐
│ session picks the preset → DSH mounts each row → agent calls the parts │
└───────────────────────────────────────────────────────────────────────┘
```

The assembler is a Cordis plugin and its output is a Cordis composition manifest (one preset row = one plugin instance); parts are external MCP server processes bridged by `@deepseek-ai/dsh-mcp-client`. **The assembler exists only at assembly time** — once a session is running its process is gone and nothing changes.

---

## Quick start

### 1. Install

Add the plugin to a DSH profile's patch layer (e.g. `~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- insert:
    - id: dsh-assembler
      name: '@dsh-external/dsh-assembler'
```

Dependency: `"@dsh-external/dsh-assembler": "link:/path/to/dsh-assembler"`.

Some service parts need the operator's contact details (SEC mandates a contactable User-Agent; Crossref/OpenAlex polite pools want a mailto). Copy `.env.example` to `.env` and fill in your own — **not credentials, but not anyone else's address either**.

### 2. Assemble one agent

```
/assemble build a support bot that looks up customers, opens tickets, and hands off to a human [--name customer-service-bot] [--param timezone=Asia/Shanghai]
```

Or simply say it in any session — the agent calls the `assemble` tool on its own, and reasoning, tool card and result all render inline.

### 3. Deliver a solution (the FDE path)

```bash
npm run solution -- init acme-service --client acme     # manifest skeleton
# edit the agents list in solutions/acme-service/solution.yml
npm run solution -- apply solutions/acme-service/solution.yml --port 3096
npm run solution -- handover solutions/acme-service/solution.yml
```

`HANDOVER.md` lists what was delivered with each verdict, the deployment parameters, the **pending-credential checklist**, knowledge packs with source and version, the supply-chain BOM, and the rebuild command — assembled from the artifacts, with **nothing hand-filled**. Anything that can be forgotten does not belong in a handover.

---

## Layout

```
dsh-assembler/
├── src/
│   ├── index.ts            # assembly core: catalog, matching, emission, BOM, params, secrets, knowledge
│   ├── verify.ts           # assemble-then-verify: probe derivation (single/scenario) + real-session driver
│   ├── persona-lint.ts     # mechanical persona checks
│   └── assemble-tool.ts    # the assemble agent tool
├── capabilities.yml        # ★ public catalog: capability entries + mcp-servers + requiredSecrets
├── index/                  # ★ public part index (origin/licence/terms) + smoke reports
├── generated/              # ★ part library: 78 MCP adapter servers, one directory each
├── catalogs/<client>/      # ★ client-private catalog: its own generated/ index/ capabilities.yml knowledge/
├── solutions/<name>/       # ★ solution pack: solution.yml + last-apply.json + HANDOVER.md
├── bench/results/          # assembly-quality ledgers (run-tagged, committed)
├── presets/
│   └── agent-template.yml  # preset template ({{persona}}/{{packageRows}}/{{extraRows}}/{{param:k}})
└── scripts/
    ├── index-add.mjs       # ★ induction pipeline CLI
    ├── solution.mjs        # ★ solution pack CLI
    ├── assembly-bench.mjs  # 45-item assembly benchmark
    └── link-dsh.mjs        # link DSH peer packages
```

---

## The capability catalog

Four kinds of capability:

| `via` | Source | Example |
|---|---|---|
| `package` | a tool from this repo / an own plugin package | `crm-query` |
| `harness` | a DSH built-in tool | `content-search` |
| `mcp` | MCP server tools (federated at assembly time) | `mcp-weather-forecast-current-weather`, 229 of them |
| `knowledge` | client teaching material (copied into `kb/`) | `acme-policies-kb` |

**78 parts / 215 tools** — 61 library-backed, 13 service-backed, 4 first-party.

### Service-backed parts — live data and external systems

| Part | Tools | Source | Licence / terms | Credentials |
|---|---|---|---|---|
| **package-registry** | `package-info` `package-versions` `check-license` | npm + PyPI registries | registry ToS | none |
| **weather-forecast** | `current-weather` `daily-forecast` | Open-Meteo | CC-BY-4.0 | none |
| **currency-rates** | `latest-rates` `historical-rate` `convert-amount` | Frankfurter (ECB data) | Public-Domain-ECB | none |
| **geocode** | `geocode-address` `reverse-geocode` | OpenStreetMap Nominatim | ODbL-1.0 | none |
| **public-holidays** | `list-holidays` `is-workday` `available-countries` | Nager.Date | MIT | none |
| **worldbank-data** | `country-indicator` `common-indicators` | World Bank Open Data | CC-BY-4.0 | none |
| **sec-filings** | `lookup-cik` `company-filings` | U.S. SEC EDGAR | Public-Domain-US-Gov | none |
| **scholar-search** | `search-published` `search-preprints` `doi-lookup` | Crossref + arXiv | CC0-1.0 / arXiv terms | none |
| **wiki-facts** | `page-summary` `search-entity` `entity-facts` | Wikimedia (Wikipedia + Wikidata) | CC-BY-SA-4.0 | none |
| **research-graph** | `search-works` `work-citations` `author-works` | OpenAlex | CC0-1.0 | none |
| **feishu-messaging** | `send-message` `list-chats` `feishu-capabilities` | 飞书开放平台 | Feishu API ToS | `FEISHU_APP_ID` `FEISHU_APP_SECRET` |
| **slack-messaging** | `post-message` `list-channels` `slack-capabilities` | Slack API | Slack API ToS | `SLACK_BOT_TOKEN` |
| **github-issues** | `list-issues` `get-issue` `create-issue` `github-capabilities` | GitHub REST API | GitHub ToS | `GITHUB_TOKEN` (optional) |

### First-party parts — thin shells over Node built-ins, zero third-party deps

`binary-write`(write-binary-file) · `crypto-hash`(hash-text, hmac-sign, generate-uuid) · `compress-gzip`(compress, decompress) · `dns-lookup`(resolve-domain, reverse-lookup)

### Library-backed parts, by domain

| Domain | Parts (tool count) |
|---|---|
| **Documents & office** | `pdf-generate`(4) · `pdf-extract`(3) · `pdf-report`(1) · `docx-generate`(3) · `docx-extract`(2) · `pptx-generate`(1) · `excel-read-write`(4) · `zip-archive`(4) |
| **Data formats** | `csv-parse`(3) · `yaml-convert`(2) · `toml-parse`(2) · `xml-parse`(3) · `json-query`(2) · `json-schema-validate`(2) · `html-parse`(4) · `html-to-text`(4) |
| **Text processing** | `markdown-render`(3) · `html-to-markdown`(1) · `readability-extract`(2) · `text-diff`(3) · `template-render`(4) · `fuzzy-search`(4) · `text-encoding`(2) |
| **Chinese language** | `pinyin-convert`(2) · `chinese-convert`(2) · `word-segment`(2) · `num-to-chinese`(2) |
| **Computation** | `math-eval`(2) · `currency-calc`(4) · `number-format`(4) · `semver-check`(3) · `geo-distance`(3) · `color-convert`(2) |
| **Time & calendars** | `date-format`(4) · `cron-parse`(2) · `calendar-parse`(3) · `calendar-generate`(4) · `rrule-expand`(2) |
| **Databases** | `sqlite-query`(3) · `mysql-query`(4) · `postgres-query`(4) |
| **Network & messaging** | `http-request`(4) · `email-send`(4) · `email-fetch`(4) · `rss-parse`(4) |
| **Media & recognition** | `image-process`(4) · `ocr-parse`(3) · `qrcode-generate`(4) · `barcode-generate`(2) · `exif-read`(1) · `file-type-detect`(1) |
| **Security & validation** | `jwt-decode`(2) · `ip-utils`(2) · `string-validate`(2) · `fake-data`(2) · `phone-parse`(2) |
| **Engineering tools** | `github-api`(4) · `browser-automate`(4) · `url-slugify`(3) · `transliterate`(2) · `safe-filename`(2) |

<details>
<summary><b>Full tool-level inventory</b></summary>

- **email-send** — `send-email`, `verify-smtp-config`, `parse-email-addresses`, `create-test-account`
  <br/><sub>nodemailer/nodemailer@v6.9.13 · MIT</sub>
- **email-fetch** — `list-mailboxes`, `search-messages`, `fetch-message`, `list-message-summaries`
  <br/><sub>postalsys/imapflow@v1.0.162 · MIT</sub>
- **http-request** — `http-request`, `http-get`, `http-post`, `build-url`
  <br/><sub>axios/axios@v1.7.2 · MIT</sub>
- **html-parse** — `extract-text`, `extract-attributes`, `query-elements`, `serialize-html`
  <br/><sub>cheeriojs/cheerio@v1.0.0-rc.12 · MIT</sub>
- **csv-parse** — `parse-csv`, `unparse-csv`, `validate-csv`
  <br/><sub>papaparse/papaparse@5.4.1 · MIT</sub>
- **pdf-generate** — `create-pdf`, `merge-pdfs`, `extract-pages`, `pdf-info`
  <br/><sub>Hopding/pdf-lib@v1.17.1 · MIT</sub>
- **date-format** — `format-date`, `parse-date`, `date-diff`, `date-manipulate`
  <br/><sub>iamkun/dayjs@v1.11.11 · MIT</sub>
- **sqlite-query** — `query`, `execute`, `list-tables`
  <br/><sub>WiseLibs/better-sqlite3@v11.1.2 · MIT</sub>
- **github-api** — `get-user`, `get-repo`, `list-org-repos`, `search-repositories`
  <br/><sub>octokit/rest.js@v20.1.1 · MIT</sub>
- **markdown-render** — `render-markdown`, `render-markdown-inline`, `tokenize-markdown`
  <br/><sub>markedjs/marked@v12.0.2 · MIT</sub>
- **pdf-extract** — `get-pdf-text`, `get-pdf-info`, `search-pdf-text`
  <br/><sub>pdf-parse/pdf-parse@1.1.1 · MIT</sub>
- **excel-read-write** — `read-xlsx-file`, `write-xlsx-file`, `read-csv-file`, `write-csv-file`
  <br/><sub>exceljs/exceljs@v4.4.0 · MIT</sub>
- **docx-generate** — `docx-generate-text`, `docx-generate-table`, `docx-patch-document`
  <br/><sub>dolanmiu/docx@8.5.0 · MIT</sub>
- **zip-archive** — `zip-list-entries`, `zip-read-file`, `zip-create-archive`, `zip-update-archive`
  <br/><sub>cthackers/adm-zip@v0.5.12 · MIT</sub>
- **fuzzy-search** — `fuzzy-search`, `fuse-create-index`, `fuse-search-with-index`, `fuse-config`
  <br/><sub>krisk/Fuse@v7.0.0 · Apache-2.0</sub>
- **template-render** — `render-template`, `precompile-template`, `render-precompiled`, `validate-template`
  <br/><sub>handlebars-lang/handlebars.js@v4.7.8 · MIT</sub>
- **html-to-text** — `html-to-text`, `html-to-text-batch`, `html-to-text-table`, `html-to-text-links`
  <br/><sub>html-to-text/node-html-to-text@9.0.5 · MIT</sub>
- **xml-parse** — `xml-validate`, `xml-parse`, `xml-build`
  <br/><sub>NaturalIntelligence/fast-xml-parser@v4.4.0 · MIT</sub>
- **image-process** — `image-info`, `image-resize`, `image-convert`, `image-thumbnail`
  <br/><sub>lovell/sharp@v0.33.4 · Apache-2.0</sub>
- **rss-parse** — `parse-rss-string`, `parse-rss-url`, `extract-feed-items`, `parse-feed-metadata`
  <br/><sub>rbren/rss-parser@v3.13.0 · MIT</sub>
- **calendar-parse** — `parse-ics`, `parse-ics-file`, `fetch-ics-url`
  <br/><sub>jens-maus/node-ical@0.19.0 · Apache-2.0</sub>
- **calendar-generate** — `create-calendar`, `create-event`, `create-all-day-event`, `create-recurring-event`
  <br/><sub>sebbo2002/ical-generator@v7.1.0 · MIT</sub>
- **mysql-query** — `mysql-query`, `mysql-list-tables`, `mysql-describe-table`, `mysql-test-connection`
  <br/><sub>sidorares/node-mysql2@v3.10.0 · MIT</sub>
- **number-format** — `format-number`, `unformat-number`, `arithmetic`, `validate-number`
  <br/><sub>adamwdraper/Numeral-js@2.0.6 · MIT</sub>
- **qrcode-generate** — `qr-generate-png`, `qr-generate-data-url`, `qr-generate-svg`, `qr-generate-terminal`
  <br/><sub>soldair/node-qrcode@v1.5.3 · MIT</sub>
- **postgres-query** — `postgres-test-connection`, `postgres-list-tables`, `postgres-describe-table`, `postgres-query`
  <br/><sub>brianc/node-postgres@pg@8.12.0 · MIT</sub>
- **browser-automate** — `browser-open`, `browser-extract`, `browser-click`, `browser-screenshot`
  <br/><sub>microsoft/playwright@v1.45.0 · Apache-2.0</sub>
- **ocr-parse** — `ocr-languages`, `ocr-psm-modes`, `ocr-recognize`
  <br/><sub>naptha/tesseract.js@v5.1.0 · Apache-2.0</sub>
- **currency-calc** — `currency-calc`, `currency-format`, `currency-distribute`, `currency-parse`
  <br/><sub>scurker/currency.js@v2.0.4 · MIT</sub>
- **readability-extract** — `extract-article`, `extract-batch`
  <br/><sub>mozilla/readability@0.5.0 · MIT</sub>
- **pdf-report** — `create-report-pdf`
  <br/><sub>Hopding/pdf-lib@v1.17.1 · MIT</sub>
- **binary-write** — `write-binary-file`
  <br/><sub>first-party@- · BSD-3-Clause</sub>
- **text-diff** — `create-patch`, `apply-patch`, `diff-words`
  <br/><sub>kpdecker/jsdiff@v9.0.0 · BSD-3-Clause</sub>
- **crypto-hash** — `hash-text`, `hmac-sign`, `generate-uuid`
  <br/><sub>first-party@v- · BSD-3-Clause</sub>
- **math-eval** — `evaluate`, `unit-convert`
  <br/><sub>josdejong/mathjs@v15.2.0 · Apache-2.0</sub>
- **cron-parse** — `next-runs`, `describe-fields`
  <br/><sub>harrisiirak/cron-parser@v5.10.0 · MIT</sub>
- **semver-check** — `compare`, `satisfies`, `coerce-valid`
  <br/><sub>npm/node-semver@v7.8.5 · ISC</sub>
- **yaml-convert** — `yaml-to-json`, `json-to-yaml`
  <br/><sub>eemeli/yaml@v2.9.0 · ISC</sub>
- **pinyin-convert** — `to-pinyin`, `multi-tone`
  <br/><sub>zh-lx/pinyin-pro@v3.29.2 · MIT</sub>
- **chinese-convert** — `s2t`, `t2s`
  <br/><sub>nk2028/opencc-js@v1.4.1 · MIT AND Apache-2.0</sub>
- **html-to-markdown** — `html-to-markdown`
  <br/><sub>mixmark-io/turndown@v7.2.4 · MIT</sub>
- **text-encoding** — `decode-base64`, `encode-to-base64`
  <br/><sub>ashtuchkin/iconv-lite@v0.7.3 · MIT</sub>
- **phone-parse** — `parse-phone`, `format-phone`
  <br/><sub>catamphetamine/libphonenumber-js@v1.13.11 · MIT</sub>
- **compress-gzip** — `compress`, `decompress`
  <br/><sub>first-party@v- · BSD-3-Clause</sub>
- **dns-lookup** — `resolve-domain`, `reverse-lookup`
  <br/><sub>first-party@v- · BSD-3-Clause</sub>
- **json-query** — `query`, `query-multi`
  <br/><sub>jmespath/jmespath.js@v0.16.0 · Apache-2.0</sub>
- **json-schema-validate** — `validate`, `check-schema`
  <br/><sub>ajv-validator/ajv@v8.20.0 · MIT</sub>
- **toml-parse** — `toml-to-json`, `json-to-toml`
  <br/><sub>squirrelchat/smol-toml@v1.8.0 · BSD-3-Clause</sub>
- **docx-extract** — `docx-to-text`, `docx-to-html`
  <br/><sub>mwilliamson/mammoth.js@v1.12.1 · BSD-2-Clause</sub>
- **pptx-generate** — `create-pptx`
  <br/><sub>gitbrent/pptxgenjs@v4.0.1 · MIT</sub>
- **barcode-generate** — `barcode-png`, `barcode-types`
  <br/><sub>metafloor/bwip-js@v4.11.2 · MIT</sub>
- **string-validate** — `validate-string`, `sanitize-string`
  <br/><sub>validatorjs/validator.js@v13.15.35 · MIT</sub>
- **fake-data** — `fake-records`, `fake-text`
  <br/><sub>faker-js/faker@v10.6.0 · MIT</sub>
- **num-to-chinese** — `to-chinese`, `from-chinese`
  <br/><sub>cnwhy/nzh@v1.0.14 · BSD-2-Clause</sub>
- **jwt-decode** — `decode-jwt`, `verify-jwt-hs256`
  <br/><sub>panva/jose@v6.2.9 · MIT</sub>
- **ip-utils** — `parse-ip`, `cidr-match`
  <br/><sub>whitequark/ipaddr.js@v2.5.0 · MIT</sub>
- **transliterate** — `transliterate-text`, `make-slug`
  <br/><sub>dzcpy/transliteration@v2.6.1 · MIT</sub>
- **rrule-expand** — `expand-rrule`, `describe-rrule`
  <br/><sub>jkbrzt/rrule@v2.8.1 · BSD-3-Clause</sub>
- **exif-read** — `read-exif`
  <br/><sub>MikeKovarik/exifr@v7.1.3 · MIT</sub>
- **file-type-detect** — `detect-file-type`
  <br/><sub>sindresorhus/file-type@v22.0.2 · MIT</sub>
- **color-convert** — `convert-color`, `contrast-check`
  <br/><sub>Evercoder/culori@v4.0.2 · MIT</sub>
- **word-segment** — `segment-text`, `extract-keywords`
  <br/><sub>linonetwo/segmentit@v2.0.3 · MIT</sub>
- **geo-distance** — `distance`, `bearing`, `center-and-bounds`
  <br/><sub>manuelbieh/geolib@v3.3.14 · MIT</sub>
- **url-slugify** — `slugify`, `slugify-unique`, `slugify-custom`
  <br/><sub>sindresorhus/slugify@v3.0.0 · MIT</sub>
- **safe-filename** — `sanitize`, `sanitize-path`
  <br/><sub>sindresorhus/filenamify@v7.0.2 · MIT</sub>
- **package-registry** — `package-info`, `package-versions`, `check-license`
  <br/><sub>https://registry.npmjs.org · registry ToS</sub>
- **weather-forecast** — `current-weather`, `daily-forecast`
  <br/><sub>https://api.open-meteo.com/v1 · CC-BY-4.0</sub>
- **currency-rates** — `latest-rates`, `historical-rate`, `convert-amount`
  <br/><sub>https://api.frankfurter.dev/v1 · Public-Domain-ECB</sub>
- **geocode** — `geocode-address`, `reverse-geocode`
  <br/><sub>https://nominatim.openstreetmap.org · ODbL-1.0</sub>
- **public-holidays** — `list-holidays`, `is-workday`, `available-countries`
  <br/><sub>https://date.nager.at/api/v3 · MIT</sub>
- **worldbank-data** — `country-indicator`, `common-indicators`
  <br/><sub>https://api.worldbank.org/v2 · CC-BY-4.0</sub>
- **sec-filings** — `lookup-cik`, `company-filings`
  <br/><sub>https://data.sec.gov · Public-Domain-US-Gov</sub>
- **scholar-search** — `search-published`, `search-preprints`, `doi-lookup`
  <br/><sub>https://api.crossref.org · CC0-1.0 / arXiv terms</sub>
- **wiki-facts** — `page-summary`, `search-entity`, `entity-facts`
  <br/><sub>https://en.wikipedia.org/api/rest_v1 · CC-BY-SA-4.0</sub>
- **research-graph** — `search-works`, `work-citations`, `author-works`
  <br/><sub>https://api.openalex.org · CC0-1.0</sub>
- **feishu-messaging** — `send-message`, `list-chats`, `feishu-capabilities`
  <br/><sub>https://open.feishu.cn/open-apis · Feishu API ToS</sub>
- **slack-messaging** — `post-message`, `list-channels`, `slack-capabilities`
  <br/><sub>https://slack.com/api · Slack API ToS</sub>
- **github-issues** — `list-issues`, `get-issue`, `create-issue`, `github-capabilities`
  <br/><sub>https://api.github.com · GitHub ToS</sub>

</details>

### Licences

**Wrapped code** (library + first-party parts): MIT 46 · Apache-2.0 7 · BSD-3-Clause 7 · ISC 2 · BSD-2-Clause 2 · MIT AND Apache-2.0 1

**Data licence / terms** (service-backed parts): CC-BY-4.0 2 · registry ToS 1 · Public-Domain-ECB 1 · ODbL-1.0 1 · MIT 1 · Public-Domain-US-Gov 1 · CC0-1.0 / arXiv terms 1 · CC-BY-SA-4.0 1 · CC0-1.0 1 · Feishu API ToS 1 · Slack API ToS 1 · GitHub ToS 1

All permissive — no copyleft exposure in code. Service parts additionally record the **data** licence, which is a different obligation: Nominatim is ODbL and Wikipedia is CC-BY-SA (attribution / share-alike duties), so both are recorded per entry and travel into each assembly's BOM.

Machine-readable inventory with every `repo@rev`, licence, terms, rate limit and tool description: [`index/catalog.yml`](index/catalog.yml).

---

## Induction pipeline (the CLI)

The design premise is that **the caller is an agent**. The CLI does the deterministic half — fetch the source, inventory it, write a work order, install, gate, register — and leaves "which capabilities to slice, and how to write the adapter" to the caller. Every subcommand ends with one machine-readable JSON verdict.

```bash
# an OSS library
npm run index:add -- kpdecker/jsdiff --pkg diff --id text-diff
npm run index:verify -- text-diff        # install → smoke (exit 0 required) → independent listTools → report
npm run index:register -- text-diff      # idempotent; federation picks it up on the next assembly

# a public API (pins terms/rate-limit/data-licence instead of a version)
node scripts/index-add.mjs scaffold - --service https://api.open-meteo.com/v1 --id weather-forecast \
  --provider 'Open-Meteo' --license CC-BY-4.0 --terms https://open-meteo.com/en/terms --rate-limit 'free for non-commercial'

# a client's own system (the FDE day-one move): OpenAPI → endpoint work order → client catalog
node scripts/index-add.mjs from-spec <spec-url|file> --id <id> --client acme \
  --requires-secret "TOKEN:what it is for, commas allowed;OTHER:second one"

# a client's documents (past the retrieval gate)
node scripts/index-add.mjs knowledge <docs-dir> --id acme-policies --client acme --version 2026-08
# write probes.json (questions + expected snippets), then:
node scripts/index-add.mjs knowledge-verify acme-policies --client acme

# hands-free: one command, start to finish (needs a running web profile)
npm run index:auto -- sindresorhus/slugify --pkg @sindresorhus/slugify --id url-slugify

npm run index:check     # full regression: every part's smoke (network parts recorded SKIPPED when offline)
node scripts/index-add.mjs coverage   # capability map, for semantic dedup
```

**The gate lives in the pipeline**: if verify fails, register refuses. **Dedup has two layers** — a mechanical gate (same id / same npm package / same upstream repo), and capability-level judgement against the `coverage` map: the catalog holds capabilities, not libraries.

---

## Sample output

### Assemble-then-verify, multi-turn

For "a bookkeeping assistant that records income and expenses locally and can query and total them later", the deriver judged the work to outlive a turn and produced a 3-turn scenario:

```
自动验证:PASS — 多轮场景「prove the assistant persists entries to SQLite and can query/total them in later turns」共 3 轮,逐轮通过
  turn 1 ✓ "record income: project payment 8899, memo INV-7781…"      marks [INV-7781, 8899]
  turn 2 ✓ "record expense: office supplies 1200, memo OFFICE-2201…"  marks [OFFICE-2201, 1200]
  turn 3 ✓ "query the ledger, list every entry and total them"        marks [INV-7781, OFFICE-2201, 8899]
```

Turn 3 reads what turns 1 and 2 wrote, which is what makes state continuity provable rather than assumed. A pure-compute requirement gets a single-turn probe instead.

### The four credential states

```
# required credential missing: assembly succeeds, probe SKIPPED, guidance given
自动验证:跳过(pending credential: SLACK_BOT_TOKEN — the assembly is correct but cannot reach the service;
              configure it and re-run the assembly to verify)
所需凭证:SLACK_BOT_TOKEN(pending) — Slack Bot User OAuth Token (xoxb-…)

# optional credential: the anonymous path is exercised and verification PASSes
自动验证:PASS — probe "inspect the public repo octocat/Hello-World…" passed
所需凭证:GITHUB_TOKEN(optional; degrades to anonymous when unset)
```

### Parts BOM — `parts.lock.yml` (excerpt)

```yaml
preset: currency-qr-assistant
parts:
  - capability: mcp-qrcode-generate-qr-generate-png
    server: qrcode-generate
    serverName: qrcode-generate-d0fb25cc   # read back from the preset bytes, always matches what mounts
    repo: soldair/node-qrcode
    rev: v1.5.3
    license: MIT
    verified: true
  - capability: mcp-weather-forecast-current-weather
    kind: service
    service: https://api.open-meteo.com/v1
    terms: https://open-meteo.com/en/terms
    rateLimit: free for non-commercial; commercial needs a subscription
knowledge:
  - id: acme-policies
    docs: 2
    source: ACME support knowledge base export
    version: 2026-08
```

---

## Development

```bash
npm run link:dsh   # link DSH peer packages (needs DSH_SOURCE or ~/.dsh/source/current)
npm run build      # tsc → lib/
npm test           # build + three suites (generation invariants / verdicts & BOM / federation cache)
npm run index:check   # full part-smoke regression
npm run bench      # 45-item assembly benchmark
```

Changes under `lib/` need a DSH web restart; changes to `capabilities.yml` do not (the catalog is read at assembly time).

Two environment facts to know when writing a network part: Node's global `fetch` ignores `HTTP(S)_PROXY` unless `NODE_USE_ENV_PROXY=1`, and the MCP SDK's `StdioClientTransport` **only forwards a whitelist of environment variables**, so proxy settings do not reach a part process by themselves. The pipeline handles both; a hand-written smoke must pass the environment down itself.

---

## Licence

BSD-3-Clause. Upstream licences for the wrapped libraries are recorded per entry in `index/catalog.yml`; service-backed parts record their data licence and terms in their catalog entry the same way.
