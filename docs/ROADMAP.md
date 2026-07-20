# Promoter Program Roadmap — P1 and beyond

Boundary map, build order, interface architecture, and paste-ready prompts for
the work that lives outside this repo.

Doctrine: Magnetic Marketing (list → offer → follow-up → media), brand-as-story,
behavioral marketing (design for System 1 — measured, never faked).

---

## 1. Boundary map

| Capability                                                        | Home                           | Why                                                    |
| ----------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------ |
| Herd graph (contact, consent, event stream, segment, RFM, ladder) | **Promoter**                   | The list is the asset; every decision keys off it      |
| Sequence engine (follow-up state machines, scheduler)             | **Promoter**                   | The money is in the follow-up; needs herd + deadlines  |
| Deadline & claims registry (real scarcity, evidence-linked)       | **Promoter**                   | Single source of truth that other systems only render  |
| Tactic taxonomy, persuasion profiles, habituation curves          | **Promoter**                   | Learned from the append-only outcome ledger            |
| Experiments (variants, bandit allocation, holdouts)               | **Promoter**                   | Allocation is a promotion decision                     |
| Offer variants + economics-aware scoring                          | **Promoter** (reads Monetizer) | The offer is the #1 lever; margins come from Monetizer |
| Channel adapters (email/ESP, ads, SMS, direct mail)               | **Promoter** (`src/channels/`) | Mirrors the provider-adapter seam; send + track        |
| War-room daily loop, lesson store, decision provenance            | **Promoter**                   | The compounding brain                                  |
| Read API for the cockpit                                          | **Promoter** (`src/server/`)   | Same data, HTTP surface                                |
| Landing / offer / advertorial rendering                           | **CMS + publishing engine**    | Presentation layer                                     |
| Live deadline components                                          | **CMS**                        | Truth lives in Promoter, pixels live in CMS            |
| Personalization slots (variant blocks by assignment)              | **CMS**                        | Promoter allocates, CMS renders                        |
| Proof / UGC media library (consent-referenced)                    | **CMS**                        | Assets live with content; evidence records in Promoter |
| Event beacon on published pages                                   | **CMS ships it**               | Posts to Promoter `/events`                            |
| Signal collectors (trends, ad-library miner, review/VOC scraping) | **Independent: Scout**         | Crawler ops ≠ decision engine; feeds `signal_create`   |
| Swipe + VOC embedding corpus                                      | **Independent: Corpus**        | Serves both Promoter copy and CMS content generation   |
| Persona simulator / creative pre-scoring                          | **Independent: Twin**          | Eval harness, calibrated from outcome exports          |
| Cockpit UI                                                        | **Independent: Bridge**        | Frontend over Promoter read API + MCP                  |
| Offers, revenue truth, tenant tracking                            | **Monetizer** (exists)         | Promoter consumes, never duplicates                    |

Rule of thumb: **Promoter decides and remembers. CMS shows. Scout sees. Corpus
recalls. Twin rehearses. Bridge reveals. Monetizer counts the money.**

---

## 2. Interface architecture — general at the top, detail at the bottom

Four altitudes. Everything drills down; nothing starts detailed. Applies to the
Bridge UI **and** to the MCP tool surface.

- **L0 — Today.** One screen: three numbers (revenue, spend, LTV:CAC), the
  approval queue (each card = recommendation + expected impact + the _why_ +
  one-tap approve/park), the autonomy dial, the kill switch. Kennedy vocabulary
  throughout — Herd, Offers, Sequences, Deadlines — never adtech jargon.
- **L1 — Boards.** Herd (list health, ladder flow, segment map) · Campaigns
  (live bandit allocations) · Sequences (state machines, open loops) · Offers
  (variants + winners) · Signals (what Scout sees) · Story (bible + consistency
  scores).
- **L2 — Object detail.** One campaign: brief, story frame, tactic mix,
  placements, live outcomes, "ran under policy vX" provenance.
- **L3 — Forensics.** Append-only ledgers, experiment posteriors, habituation
  curves, AI cost ledger, raw JSON. The bottom is fully inspectable.

MCP mirror: summary tools (`herd_overview`, `war_room_report`,
`campaign_explain(id)`) layered over the forensic tools that already exist.
Every automated action must be able to answer "why" with: inputs, policy
versions, expected vs. realized outcome.

---

## 3. Build order (in this repo)

### P1 — The Herd

- Tables: `contact`, `consent`, `event` (append-only), `segment`,
  `segment_member`; RFM scoring + ascension-ladder stage per contact.
- `/events` ingest endpoint (page beacon + ESP webhooks), keyed by tracking
  code; unique tracking code enforced per placement.
- MCP: `contact_upsert`, `event_ingest`, `segment_list`, `herd_overview`.
- Accept: event roundtrip; RFM/ladder computed from fixture events; duplicate
  tracking code rejected.

### P2 — The Follow-up Machine

- pg-boss on the existing Postgres (queues + cron, no new infra).
- Sequences defined as `policy_version` rows (`kind: sequence:<name>`) —
  versioned, append-only, diffable; `sequence_state` per contact per sequence.
- First channel adapter: email/ESP under `src/channels/` (same seam pattern as
  `src/agents/adapters/`).
- **Deadline registry**: deadlines are rows; sequences and pages reference
  them; expiry enforced in code — no deadline row, no countdown, no send.
- Deliverability guardrails: bounce/complaint monitors that auto-pause.
- Seed sequences: lost-lead ×3, cart-abandon, post-purchase ascension,
  win-back.
- Accept: a contact advances through a sequence end-to-end against docker
  postgres; an expired deadline blocks the send; a complaint spike pauses the
  sequence.

### P3 — The Offer Lab

- `offer_variant` (price frame, guarantee strength, bonus stack, deadline
  length); `experiment`, `variant`, `assignment` tables.
- Thompson-sampling allocator; automatic holdout carve per campaign.
- Monetizer economics read (margin/LTV → `opportunity.score_breakdown`).
- MCP: `experiment_create`, `assignment_get` (CMS calls this at render),
  `experiment_report`.
- Accept: bandit reallocates on simulated outcomes; holdout contacts are never
  assigned; unknown offer economics → typed error (no fallback, same doctrine
  as pricing).

### P4 — The Persuasion Ledger

- Tactic taxonomy seeded as policy (`kind: tactics`); every placement stamps
  `ext.tactics[]`.
- Persuasion-profile job: tactic × segment × channel response rates
  materialized from the outcome ledger; habituation curves (response decay per
  stimulus, rotation trigger).
- `lesson` store (append-only); nightly war-room job: ingest → rescore →
  retro → reallocate → draft next actions (flag or auto per autonomy policy).
- Accept: profile materializes from fixture outcomes; a decayed tactic triggers
  a rotation recommendation; war-room run emits a report row.

### P5 — Read API for Bridge

- `/api/*` read-only JSON (same shared-secret auth pattern), plus the summary
  MCP tools from §2. Ship a minimal approval-queue endpoint right after P2 so
  flag-mode is usable before the full cockpit exists.

Parallel tracks outside this repo: **Stagecraft** (CMS) after P1 · **Scout**
after P1 · **Corpus** before P4's copy work · **Twin** after P4 · **Bridge**
after P5.

---

## 4. Schema deltas (names only)

- P1: `contact`, `consent`, `event`\*, `segment`, `segment_member`
- P2: `sequence_state`, `deadline`, `send_log`\*
- P3: `experiment`, `variant`, `assignment`, `offer_variant`
- P4: `lesson`\*; persuasion profiles as materialized views

\* append-only — same `BEFORE UPDATE OR DELETE` trigger pattern as `outcome` /
`policy_version`.

---

## 5. Policy kinds registry

`story_bible` · `tactics` · `sequence:<name>` · `compliance_rules` ·
`scoring_weights` · `autonomy_thresholds`

All flow through the existing `policy_publish` / `policy_get_active` tools.
Every agent run records the policy versions it executed under — that is the
provenance chain that makes `autonomy_mode: auto` trustworthy.

---

## 6. Hard rules (encoded in schema and code, not aspirational)

1. **No fabricated scarcity.** Every countdown binds to a `deadline` row that
   actually expires. Burned deadlines burn the list — deadline credibility is a
   response-rate asset.
2. **Every factual claim links to an evidence record** (consented testimonial,
   spec, study). The compliance critic blocks placements otherwise.
3. **Consent gates sends at the DB layer**, not in prompt text.
4. **Autonomy is earned.** Auto-mode only under `autonomy_thresholds`;
   refund/complaint anomalies drop a campaign back to flag automatically.

---

## 7. Paste-ready prompts for work outside this repo

### 7.1 Stagecraft — CMS + publishing engine

```
STAGECRAFT — promotion-aware publishing components for the CMS/publishing
engine (Netlify, TS).

CONTEXT (self-contained)
* A separate "promoter" service (Cloud Run) owns promotion truth: deadlines,
  experiment assignments, contacts/events, claims evidence. It exposes MCP +
  HTTP, auth = X-Promoter-Key header. The CMS renders; it never invents
  promotion state.
* placement.cms_refs on the promoter side stores stable IDs of CMS artifacts.

BUILD
1. Deadline component: renders countdown/offer state fetched from promoter's
   deadline API at build/edge time. Expired => automatic fallback content.
   Client JS may tick the clock but NEVER invents or extends a deadline.
2. Personalization slot: a block type that calls promoter assignment_get with
   the visitor's tracking code and renders the assigned variant. Cache-safe
   (edge/SSR), deterministic per visitor.
3. Advertorial template: pre-frame article type (story-first, soft CTA,
   disclosure line included by default).
4. Proof library: reviews/UGC assets with consent_ref + evidence_ref fields
   (IDs from promoter's claims registry). Render blocks for proof walls,
   inline testimonials. Assets without consent_ref cannot be published.
5. Event beacon: tiny snippet on published pages posting page_view / scroll /
   cta_click + tracking code to promoter POST /events. Consent-aware (no
   consent, no beacon). Batched, non-blocking.
6. cms_refs contract: every published artifact returns stable IDs + URLs the
   promoter can store in placement.cms_refs.

OUT OF SCOPE: deciding variants, computing deadlines, storing contacts,
sending anything. All decisions live in promoter.

ACCEPT
* Expired deadline flips to fallback within one rebuild/edge TTL.
* Same visitor gets a stable variant; different assignment => different block.
* Beacon events land in promoter's event table in local integration test.
* Every component degrades gracefully (static fallback) if promoter is
  unreachable — pages never break because promotion is down.
```

### 7.2 Scout — independent signal-collector fleet

```
SCOUT — standalone attention-signal collector service feeding the promoter
module. New repo, own deploy (Cloud Run jobs/scheduler fine).

CONTEXT (self-contained)
* Promoter (separate service) exposes MCP with signal_create
  {source, raw, topic, velocity, observedAt} and auth X-Promoter-Key.
* An independent Corpus service (pgvector) ingests voice-of-customer phrases.
* Scout only observes and normalizes. It never scores, never decides.

BUILD
1. Collector framework: scheduled pulls, per-source rate limits, retries,
   content-hash dedupe, raw payload preserved in signal.raw.
2. Collectors: (a) Google Trends topics; (b) Reddit subreddit velocity;
   (c) Meta Ad Library LONGEVITY MINER — competitor ads running 90+ days are
   validated angles, emit as high-value signals with creative text captured;
   (d) review-site scraper for target markets.
3. Velocity math: z-score vs trailing window per topic/source; stamp into
   signal.velocity.
4. VOC extraction: from reviews/threads, extract verbatim pain/desire/
   objection/identity phrases; ship to Corpus ingest with source refs.
5. Config per tenant/market as checked-in YAML.

OUT OF SCOPE: scoring, campaign logic, LLM-heavy analysis (light extraction
only), anything that writes to promoter besides signal_create.

ACCEPT
* Each collector emits normalized signals against a mocked promoter endpoint.
* Duplicate story across sources collapses via content hash.
* Longevity miner flags a fixture ad set correctly; VOC phrases arrive in
  Corpus with source attribution.
```

### 7.3 Corpus — swipe file + VOC retrieval service

```
CORPUS — independent retrieval memory for marketing language. New repo.
Postgres + pgvector, small HTTP/MCP surface, same shared-secret auth pattern.

CONTEXT (self-contained)
* Consumers: promoter (copy agents), CMS-Agent (content generation), Twin
  (persona building). Producers: Scout (VOC phrases), manual ingest (classic
  direct-response ads, own past winners, competitor creative).
* Doctrine: copy must "enter the conversation in the prospect's head" — use
  mined language, not invented language. Swipe discipline includes deliberate
  CROSS-INDUSTRY retrieval to avoid marketing incest.

BUILD
1. Tables: swipe {text, industry, format, source, rights, embedding},
   voc_phrase {market, type: pain|desire|objection|identity, phrase,
   source_ref, consented, embedding}.
2. Ingest endpoints with near-duplicate collapse (embedding distance).
3. Retrieval MCP: swipe_search(query, {cross_industry: bool}),
   voc_search(market, type, query). cross_industry=true EXCLUDES the caller's
   home industry.
4. Rights filtering: rights-restricted swipes are retrievable for study but
   flagged never-for-generation; voc phrases without consent are excluded
   from generation calls.
5. Retrieval eval harness with a small labeled set; record baseline quality.

OUT OF SCOPE: generation, scoring, campaign logic.

ACCEPT
* cross_industry search provably excludes home industry.
* Rights/consent filters enforced at the API layer, covered by tests.
* Near-duplicates collapse; retrieval eval baseline committed.
```

### 7.4 Twin — persona simulator / creative pre-scoring

```
TWIN — independent synthetic-panel service that pre-scores creative before
spend. New repo. Calibration-first: it must know when it doesn't know.

CONTEXT (self-contained)
* Inputs: VOC phrases from Corpus (retrieval API), persuasion-profile and
  outcome exports from promoter (segment-level response rates by tactic).
* Consumers: promoter's war room (rank variants pre-spend), CMS-Agent
  (content checks).

BUILD
1. panel_build(segment_ref): construct LLM persona panels from VOC language +
   persuasion profile of that segment. Panels are versioned artifacts.
2. creative_score(panel_id, creative, offer): predicted response, ranked
   objections, which tactic each persona reacted to. Multi-provider via a thin
   adapter seam; log model usage + cost per call.
3. Calibration loop: ingest promoter outcome exports, compare predictions vs
   realized outcomes (Brier score, rank correlation) per panel; persist.
4. HARD RULE: if a panel's calibration is below threshold or stale, refuse to
   score with a typed error {code:"uncalibrated"}. No fallback confidence.

OUT OF SCOPE: making spend decisions (promoter's job), collecting data
(Scout's job).

ACCEPT
* Score roundtrip on fixture creative; calibration metrics persist and update
  from an outcome export; uncalibrated panel => typed refusal, never a guess.
```

### 7.5 Bridge — cockpit UI

```
BRIDGE — the human interface for the promoter machine. New repo, TS,
Next.js or Vite+React. Consumes promoter's read API + MCP (X-Promoter-Key).

CONTEXT (self-contained)
* Promoter (separate service) exposes: approval queue, herd/campaign/
  sequence/offer/signal/story data, decision provenance (every automated
  action stores inputs + policy versions + expected impact), append-only
  ledgers, AI cost ledger.
* Interface doctrine: GENERAL AT THE TOP, DETAIL AT THE BOTTOM. Magnetic-
  marketing vocabulary (Herd, Offers, Sequences, Deadlines) — no adtech
  jargon at L0/L1.

BUILD — four altitudes
L0 "Today": three numbers (revenue, spend, LTV:CAC); approval queue as cards
   (recommendation, expected impact, the WHY, one-tap approve/park);
   autonomy dial; kill switch. Mobile-first — approvals happen from a phone.
L1 Boards: Herd (list health, ladder flow, segments), Campaigns (live bandit
   allocations), Sequences (state machines + open loops), Offers (variants +
   winners), Signals, Story (bible + consistency scores).
L2 Object detail: campaign => brief, story frame, tactic mix, placements,
   live outcomes, "ran under policy vX" provenance chain.
L3 Forensics: append-only ledgers, experiment posteriors, habituation curves,
   AI cost per campaign, raw JSON viewer.
Every automated item at every level answers "why" in one tap.

OUT OF SCOPE: any decision logic or writes beyond approve/park/autonomy-dial
calls into promoter's API.

ACCEPT
* Approve/park roundtrip against a local promoter.
* Provenance chain renders end-to-end for one campaign.
* L0 fully usable on a phone; every board drills to raw JSON.
```

---

_This roadmap is the contract between the four systems. Promoter phases P1–P5
land in this repo in milestone commits, same discipline as P0._
