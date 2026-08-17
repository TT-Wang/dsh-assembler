# dsh-assembler — Vibe Assembly for DeepSeek Harness

English | [中文](README.zh.md)

**Assemble a working AI agent from one sentence — and be able to hand it over.**

`dsh-assembler` is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin. You describe the agent you want in plain language ("build me a support bot that can look up orders, open tickets, and hand off to a human"); the assembler matches parts from a **capability catalog**, emits an **agent preset**, and then **proves it works by running it in a real session**. New sessions pick that preset from the roster and go.

The catalog grows through an **induction pipeline**: open-source libraries, public APIs, a client's own HTTP interfaces, and a client's documents all enter through one command each — and only past a quality gate. No glue code, only configuration.

**Built for FDEs (forward-deployed engineers).** The deliverable is not a preset; it is a **solution pack** — several agents plus the client's knowledge, deployment parameters, a credential checklist, a supply-chain BOM, and an acceptance record. Delivering to the next client means changing parameters and credentials, not forking anything.

---

## Where it stands

| | Measured | Where to verify |
|---|---|---|
| Catalog | **79 MCP servers / 215 registered tools / 237 assemblable entries** (229 federated + 8 static) | `index/catalog.yml` |
| Part mix | 65 library-backed + 13 service-backed + 4 first-party | same |
| Part gate | **80/80 smokes pass** (including 2 client parts) | `npm run index:check` |
| Assembly quality | **44/45 (98%)**; multi-turn process items **5/5** | `bench/results/2026-08-17-*.json` |
| Selection stability | catalog 137 → 227 entries (+47%), baseline items **did not degrade** | three bench ledgers |
| Assembly wall time | median **56s** (single-turn 52s / scenario 182s) | same |
| Unit tests | 3 suites green (generation invariants / verdicts + BOM / federation cache) | `npm test` |

Every row names the artifact that proves it. That is a house rule, not a flourish — see [DESIGN.md](DESIGN.md) (design charter, Chinese).

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

Current coverage: email send/fetch, HTTP, HTML, CSV/YAML/TOML/XML, Excel, PDF generation and extraction, Word/PowerPoint, ZIP, fuzzy search, templating, image processing, RSS, calendars and RRULE, SQLite/PostgreSQL/MySQL, GitHub API, Markdown, OCR, barcodes and QR, decimal-safe currency maths, browser automation, binary-to-disk, text diff/patch, expression evaluation and unit conversion, cron, phone numbers, semver, Chinese pinyin/simplified-traditional/segmentation/numeral spelling, character encodings, hashing/HMAC/UUID, JMESPath, JSON Schema, string validation, fake data, colour conversion, geodistance, EXIF, file-type sniffing, JWT, IP/CIDR, transliteration slugs, gzip/brotli, DNS — plus **13 live data services** (Open-Meteo, ECB/Frankfurter, OSM Nominatim, Nager.Date, World Bank, SEC EDGAR, Crossref + arXiv, Wikipedia + Wikidata, OpenAlex, npm + PyPI, Feishu, Slack, GitHub Issues).

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

**The gate lives in the pipeline**: if verify fails, register refuses. **Dedup has two layers** — a mechanical gate (same id / same npm package / same upstream repo) and semantic judgement against the coverage map. Recorded rejections: moment/cheerio/axios/fast-diff/papaparse (same capability as an existing part), convert-units (subsumed by mathjs), ua-parser-js (v2 relicensed AGPL — licence risk).

---

## Measured output

### Assemble-then-verify, multi-turn

For "a bookkeeping assistant that records income and expenses locally and can query and total them later", the deriver **chose a 3-turn scenario on its own**:

```
自动验证:PASS — 多轮场景「prove the assistant persists entries to SQLite and can query/total them in later turns」共 3 轮,逐轮通过
  turn 1 ✓ "record income: project payment 8899, memo INV-7781…"      marks [INV-7781, 8899]
  turn 2 ✓ "record expense: office supplies 1200, memo OFFICE-2201…"  marks [OFFICE-2201, 1200]
  turn 3 ✓ "query the ledger, list every entry and total them"        marks [INV-7781, OFFICE-2201, 8899]
```

Turn 3 reads what turns 1 and 2 wrote — that is what makes state continuity *proven* rather than assumed. The control ("a maths assistant") correctly stayed single-turn at 26s.

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

### Parts BOM (excerpt)

```yaml
preset: p2-bom-probe
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

## Benchmark: assembly-bench

```bash
npm run bench     # 45 items end to end (needs a running web profile); criterion PASS ≥ 80%; ledger in bench/results/
```

**Three ledgers, all committed and recomputable:**

| Run | Items | Result | Catalog size |
|---|---|---|---|
| 08-16 | 20 | 19/20 (95%) | 137 entries |
| 08-17 #1 | 40 | 35/40 (88%) | 196 entries |
| **08-17 #2** | **45** | **44/45 (98%)** | **227 entries** |

- **Baseline items 1–20 scored 19–20/20 throughout**: a 47% larger catalog cost no selection accuracy, so the trigger for domain tiering stays unmet — on two data points, stated as such.
- **Process items 5/5**, and all five were judged multi-turn by the deriver itself.
- Scoring discipline: **the first run's score is never edited**; re-verification after a fix is recorded separately. All 5 first-run failures were root-caused and turned PASS — three were probe-design noise (over-precise marks, the deriver embedding stale world knowledge, a large payload blowing the time budget), one was a genuine part-design class (binary returned inline as base64 made the agent retype it between calls: 720s → 76s), and one was a misdiagnosis I corrected in the ledger.

---

## Known limits

1. **Unfamiliar phrasing is untested.** Every bench item was written by the maintainer and therefore leans on the catalog's own vocabulary. Real users' vaguer asks ("make me something to handle complaints") have not been tested as a set — the likeliest place for problems to surface.
2. **The L3 sample is small**: five multi-turn process items, all at bookkeeping complexity. Enterprise processes (cross-system, domain rules, multi-step judgement) are an order of magnitude harder and there is no evidence yet.
3. **Catalog scale beyond 227 entries is extrapolation.** No degradation up to 227 is measured; 400+ is an inference.
4. **Verification needs the webServer.** In a headless assembly the probe has nowhere to run, so it degrades to "skipped"; the assembly itself is unaffected.
5. **Hand-editing a preset can collide within one host process.** The host never releases a superseded generation's serverNames while it lives. The assembler's own re-emission is fixed at the root (serverName suffix hashes the file bytes; byte-identical re-emits skip the write), but a manual edit needs a host restart.
6. **A structural ceiling.** The assembler handles capability acquisition and verification; **judgement always belongs to the model**. It can guarantee "a refund always leaves a ticket". It cannot guarantee "the refund decision was wise" — and claiming otherwise would be a lie.

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

Two environment facts network parts must respect (learned the hard way, now in the work-order template): Node's global `fetch` ignores `HTTP(S)_PROXY` unless `NODE_USE_ENV_PROXY=1`, and the MCP SDK's `StdioClientTransport` **only forwards a whitelist of environment variables** — so the flag never reaches the part process on its own. The pipeline handles both; if you write a smoke by hand, pass `NETWORK_ENV`.

---

## Licence

BSD-3-Clause. Upstream licences for the wrapped libraries are recorded per entry in `index/catalog.yml`; service-backed parts record their data licence and terms the same way.
