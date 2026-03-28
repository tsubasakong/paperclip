# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. Purpose

Paperclip is a control plane for AI-agent companies.
The current implementation target is V1 and is defined in `doc/SPEC-implementation.md`.

## 2. Read This First

Before making changes, read in this order:

1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md`
4. `doc/DEVELOPING.md`
5. `doc/DATABASE.md`

`doc/SPEC.md` is long-horizon product context.
`doc/SPEC-implementation.md` is the concrete V1 build contract.

## 3. Repo Map

- `server/`: Express REST API and orchestration services
- `ui/`: React + Vite board UI
- `packages/db/`: Drizzle schema, migrations, DB clients
- `packages/shared/`: shared types, constants, validators, API path constants
- `packages/adapters/`: agent adapter implementations (Claude, Codex, Cursor, etc.)
- `packages/adapter-utils/`: shared adapter utilities
- `packages/plugins/`: plugin system packages
- `doc/`: operational and product docs

## 4. Dev Setup (Auto DB)

Use embedded PGlite in dev by leaving `DATABASE_URL` unset.

```sh
pnpm install
pnpm dev
```

This starts:

- API: `http://localhost:3100`
- UI: `http://localhost:3100` (served by API server in dev middleware mode)

Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Reset local dev DB:

```sh
rm -rf data/pglite
pnpm dev
```

## 5. Core Engineering Rules

1. Keep changes company-scoped.
Every domain entity should be scoped to a company and company boundaries must be enforced in routes/services.

2. Keep contracts synchronized.
If you change schema/API behavior, update all impacted layers:
- `packages/db` schema and exports
- `packages/shared` types/constants/validators
- `server` routes/services
- `ui` API clients and pages

3. Preserve control-plane invariants.
- Single-assignee task model
- Atomic issue checkout semantics
- Approval gates for governed actions
- Budget hard-stop auto-pause behavior
- Activity logging for mutating actions

4. Do not replace strategic docs wholesale unless asked.
Prefer additive updates. Keep `doc/SPEC.md` and `doc/SPEC-implementation.md` aligned.

5. Keep plan docs dated and centralized.
New plan documents belong in `doc/plans/` and should use `YYYY-MM-DD-slug.md` filenames.

## 6. Database Change Workflow

When changing data model:

1. Edit `packages/db/src/schema/*.ts`
2. Ensure new tables are exported from `packages/db/src/schema/index.ts`
3. Generate migration:

```sh
pnpm db:generate
```

4. Validate compile:

```sh
pnpm -r typecheck
```

Notes:
- `packages/db/drizzle.config.ts` reads compiled schema from `dist/schema/*.js`
- `pnpm db:generate` compiles `packages/db` first

## 7. Verification Before Hand-off

Run this full check before claiming done:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

If anything cannot be run, explicitly report what was not run and why.

## 8. API and Auth Expectations

- Base path: `/api`
- Board access is treated as full-control operator context
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys must not access other companies

When adding endpoints:

- apply company access checks
- enforce actor permissions (board vs agent)
- write activity log entries for mutations
- return consistent HTTP errors (`400/401/403/404/409/422/500`)

## 9. UI Expectations

- Keep routes and nav aligned with available API surface
- Use company selection context for company-scoped pages
- Surface failures clearly; do not silently ignore API errors

## 10. Definition of Done

A change is done when all are true:

1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build pass
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change

---

## 11. ClawCredit Plugin — Integration Status & Roadmap

### What Was Built (v0.2.0)

The ClawCredit financial connector plugin at `packages/plugins/clawcredit-connector/` gives Paperclip board operators visibility into agent credit lines, spending, and repayment obligations. ClawCredit is a credit and payment service for AI agents — think "Ramp for autonomous companies."

**Shipped components:**

| Component | What it does |
|-----------|-------------|
| Dashboard widget | Shows available credit, score, repayment urgency at a glance on the company dashboard |
| Plugin page | Full financial view: metric tiles, transaction history, repayment schedule, promotions/grants |
| Settings page | API token config (raw for dev, secret ref for prod), service URL, spending cap, test connection |
| `clawcredit_check_balance` tool | Agent tool returning balance, score, repayment status |
| `clawcredit_pay` tool | Agent payment tool with cents-based amounts, spending cap, idempotency, live balance check |
| `sync_transactions` job | Every 4h polls ClawCredit for transaction history, incremental cursor, per-txn dedup |

**Key design decisions:**

- **Raw HTTP client**, not the ClawCredit Node SDK. The SDK has filesystem side effects (cron scheduling, integrity checks, credential file writes) that conflict with the plugin worker sandbox. The plugin calls ClawCredit's REST API directly.
- **Two-tier storage.** Tier 1 (current): transactions stored in plugin state (`ctx.state`). Tier 2 (next): add `finance_events.write` plugin capability to Paperclip so ClawCredit payments appear in the Costs page alongside inference charges.
- **Company-scoped caches.** Balance cache is a `Map<companyId, cache>` with 60s TTL. Never a global variable.
- **Cents-based money.** `amount_cents: integer` everywhere. `validateAmountCents()` enforces integer, positive, bounded. No floating point in the payment path.
- **Stable idempotency.** Payment keys use `agentId:runId:recipient:cents` (no `Date.now()`). Post-payment side effects (state write, activity log) are in separate try/catch blocks so they never mask a successful payment.
- **SSRF bypass for local dev.** `ctx.http.fetch()` blocks private IPs. The plugin detects local URLs and uses `globalThis.fetch` for those.

**PRs:**
- PR #1: Initial implementation + codex review fixes (13 issues fixed across 2 rounds)
- PR #2: Follow-up fixes from local integration testing (settings page, token handling, HTTP parsing, SSRF, tsx path)

### What's Next — Tier 2: Finance Events Integration

**Goal:** ClawCredit payments appear in Paperclip's Costs page (`finance_events` table with `biller = "clawcredit"`).

**What needs to happen:**
1. Add `finance_events.write` as a plugin capability in `packages/plugins/sdk/src/types.ts`
2. Add host service handler in `server/src/services/plugin-host-services.ts` (~50 LOC) that delegates to `finance.createEvent()`
3. Update the ClawCredit plugin worker to call `ctx.financeEvents.create()` instead of writing to plugin state
4. Migration path: backfill Tier 1 plugin state transactions into finance_events on first Tier 2 sync

### What's Next — Real SDK Integration

The current plugin uses raw HTTP calls. Switching to the `@t54-labs/clawcredit-sdk` would give richer functionality (trace capture, `wrapOpenAI`, x402 quote handling) but requires SDK changes:

**SDK changes needed:**
1. **Skip filesystem side effects in headless mode.** Add a constructor option like `{ headless: true }` that disables `_verifySkillIntegrityOrDie()`, credential file writes to `~/.openclaw/`, cron job scheduling, and OpenClaw directory auto-detection.
2. **Accept explicit credentials.** The SDK already accepts `apiToken` and `serviceUrl` in the constructor, but many methods still read from the filesystem credential file as a fallback. In headless mode, filesystem reads should be skipped entirely.
3. **Export a lightweight client.** Consider splitting the SDK into `@t54-labs/clawcredit-sdk` (full SDK with OpenClaw integration) and `@t54-labs/clawcredit-sdk/client` (pure HTTP client with no side effects). The plugin would use the lightweight client.
4. **Add webhook support.** The plugin currently polls every 4 hours. If the ClawCredit service emits webhooks on payment/repayment events, the plugin can register a webhook endpoint and get real-time transaction sync.

### What's Next — Ramp for Autonomous Companies

If ClawCredit is the "Ramp for AI companies," the product roadmap maps naturally from Ramp's core features to agent-native equivalents:

**Phase 1 — Per-Agent Financial Controls (next)**
- Per-agent spending limits configurable from the Paperclip board (not just a global `maxTransactionUsd`)
- Per-agent credit sub-accounts or budget allocation within the company credit line
- Agent spending breakdown on the plugin page: which agent spent how much, on what
- Merchant category controls: restrict which services/APIs an agent can pay for

**Phase 2 — Real-Time Visibility & Alerts**
- Webhook-driven real-time transaction sync (no more 4h polling)
- Spending alerts: notify board operators when an agent exceeds a threshold, when repayment is due, when credit utilization is high
- Spending anomaly detection: flag unusual patterns (agent spending 10x normal, new merchant, burst of transactions)
- Live transaction feed on the dashboard widget (streaming via plugin SSE)

**Phase 3 — Automated Financial Governance**
- Approval workflows: agent requests to spend above a threshold go to the board for approval before executing (integrates with Paperclip's existing approval gates)
- Budget-linked auto-pause: when a project or agent exhausts its allocated credit, Paperclip pauses the agent's heartbeat until the board approves more budget (mirrors Paperclip's existing budget hard-stop behavior)
- Automated repayment: schedule repayments via Stripe or on-chain transfers directly from the plugin page
- Receipt/audit collection: every agent payment automatically stores the merchant response, reasoning trace, and task context for compliance

**Phase 4 — Multi-Provider & Platform**
- Support multiple credit providers (not just ClawCredit) via a standard plugin interface
- Cross-company credit history: agents that work across multiple Paperclip companies build a portable credit reputation
- Credit marketplace: companies with good payment history get better rates, higher limits
- Agent financial identity as a primitive: credit score, payment history, and spending patterns become part of the agent's profile alongside their capabilities and role

**Phase 5 — Cash Back & Incentives**
- Chain-specific credit grants (XRPL, Base, Solana ecosystem incentives) surfaced as promotions on the plugin page
- Volume discounts: companies spending above thresholds get reduced fees
- Referral credits: agents that onboard other agents to ClawCredit earn credit
- Merchant partnerships: preferred rates at specific API providers for ClawCredit users
