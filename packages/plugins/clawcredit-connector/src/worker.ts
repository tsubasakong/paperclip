import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ClawCreditConfig = {
  apiTokenRef: string;
  serviceUrl?: string;
  maxTransactionUsd?: number;
};

type ResolvedConfig = {
  apiToken: string;
  serviceUrl?: string;
  maxTransactionUsd?: number;
};

type BalanceResponse = {
  available_usd: number;
  credit_score: number;
  pending_bills: number;
  chain_credits: Array<{
    chain: string;
    asset: string;
    balance_usd: number;
    source: string;
    expires_at?: string;
  }>;
  total_available_usd: number;
  // Repayment fields (included in balance response from ClawCredit)
  repayment_amount_due_usd?: number;
  repayment_due_at?: string | null;
  repayment_status?: "open" | "paid" | "overdue" | null;
  repayment_urgency?: string | null;
  repayment_days_until_due?: number | null;
};

type PayResponse = {
  status: string;
  tx_hash: string;
  chain: string;
  amount_charged: number;
  remaining_balance: number;
  merchant_response?: unknown;
};

type StoredTransaction = {
  id: string;
  tx_hash: string;
  amountCents: number;
  recipient: string;
  chain: string;
  asset: string;
  status: string;
  eventKind: string;
  direction: "debit" | "credit";
  biller: "clawcredit";
  description: string;
  occurredAt: string;
  metadataJson?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// FIX #1: Company-scoped in-memory cache (keyed by companyId)
// ---------------------------------------------------------------------------

type CachedData<T> = { data: T; fetchedAt: number };
const CACHE_TTL_MS = 60_000;

const balanceCacheByCompany = new Map<string, CachedData<BalanceResponse>>();

function getCachedBalance(companyId: string): CachedData<BalanceResponse> | null {
  const entry = balanceCacheByCompany.get(companyId);
  if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) return entry;
  return null;
}

function setCachedBalance(companyId: string, data: BalanceResponse): void {
  balanceCacheByCompany.set(companyId, { data, fetchedAt: Date.now() });
  // Evict stale entries to prevent unbounded growth
  if (balanceCacheByCompany.size > 100) {
    const now = Date.now();
    for (const [key, val] of balanceCacheByCompany) {
      if (now - val.fetchedAt > CACHE_TTL_MS) balanceCacheByCompany.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// FIX #5: Cents-based money helpers
// ---------------------------------------------------------------------------

function validateAmountCents(cents: unknown): { valid: true; cents: number } | { valid: false; error: string } {
  if (typeof cents !== "number" || !Number.isInteger(cents)) {
    return { valid: false, error: "amount_cents must be an integer" };
  }
  if (cents <= 0) {
    return { valid: false, error: "amount_cents must be positive" };
  }
  if (cents > 999_999_99) {
    return { valid: false, error: "amount_cents exceeds maximum ($999,999.99)" };
  }
  return { valid: true, cents };
}

function centsToUsd(cents: number): number {
  return cents / 100;
}

// ---------------------------------------------------------------------------
// ClawCredit API client (raw HTTP, no SDK filesystem side effects)
// ---------------------------------------------------------------------------

async function ccFetch<T>(
  ctx: PluginContext,
  config: ResolvedConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const baseUrl = config.serviceUrl || "https://api.clawcredit.com";
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiToken}`,
    "Content-Type": "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body) init.body = JSON.stringify(body);

  const res = await ctx.http.fetch(url, init);
  if (!res.ok) {
    const text = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
    throw new ApiError(res.status, text);
  }
  return (typeof res.body === "string" ? JSON.parse(res.body) : res.body) as T;
}

class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`ClawCredit API ${status}: ${body}`);
    this.name = "ApiError";
  }
}

// ---------------------------------------------------------------------------
// FIX #3: Secret-resolved config
// ---------------------------------------------------------------------------

async function resolveConfig(ctx: PluginContext): Promise<ResolvedConfig | null> {
  const raw = (await ctx.config.get()) as ClawCreditConfig;
  if (!raw.apiTokenRef) return null;

  const apiToken = await ctx.secrets.resolve(raw.apiTokenRef);
  if (!apiToken) return null;

  return {
    apiToken,
    serviceUrl: raw.serviceUrl,
    maxTransactionUsd: raw.maxTransactionUsd,
  };
}

// ---------------------------------------------------------------------------
// FIX #6: Per-transaction state writes (upsert by tx_hash, not array blob)
// ---------------------------------------------------------------------------

function txnStateKey(txHash: string): string {
  return `txn:${txHash}`;
}

async function storeTxn(ctx: PluginContext, companyId: string, txn: StoredTransaction): Promise<void> {
  await ctx.state.set(
    {
      scopeKind: "company",
      scopeId: companyId,
      namespace: "clawcredit",
      stateKey: txnStateKey(txn.tx_hash),
    },
    txn,
  );
}

async function readTxnIndex(ctx: PluginContext, companyId: string): Promise<string[]> {
  const data = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    namespace: "clawcredit",
    stateKey: "txn-index",
  });
  return (data as string[] | null) ?? [];
}

async function appendTxnIndex(ctx: PluginContext, companyId: string, txHash: string): Promise<void> {
  // Retry loop to handle concurrent read-modify-write on the index.
  // Individual txn records (keyed by tx_hash) are safe because they're
  // idempotent upserts. The index is the only shared mutable structure.
  for (let attempt = 0; attempt < 3; attempt++) {
    const index = await readTxnIndex(ctx, companyId);
    if (index.includes(txHash)) return; // already indexed
    const updated = [txHash, ...index].slice(0, 1000);
    try {
      await ctx.state.set(
        {
          scopeKind: "company",
          scopeId: companyId,
          namespace: "clawcredit",
          stateKey: "txn-index",
        },
        updated,
      );
      return; // success
    } catch {
      // Likely concurrent write — retry with fresh read
      if (attempt === 2) throw new Error(`Failed to append txn ${txHash} to index after 3 attempts`);
    }
  }
}

async function readTransactions(ctx: PluginContext, companyId: string, limit: number): Promise<StoredTransaction[]> {
  const index = await readTxnIndex(ctx, companyId);
  const txns: StoredTransaction[] = [];
  for (const hash of index.slice(0, limit)) {
    const data = await ctx.state.get({
      scopeKind: "company",
      scopeId: companyId,
      namespace: "clawcredit",
      stateKey: txnStateKey(hash),
    });
    if (data) txns.push(data as StoredTransaction);
  }
  return txns;
}

// ---------------------------------------------------------------------------
// FIX #7: Incremental sync using cursor
// ---------------------------------------------------------------------------

async function getSyncCursor(ctx: PluginContext, companyId: string): Promise<string | null> {
  return (await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    namespace: "clawcredit",
    stateKey: "sync-cursor",
  })) as string | null;
}

async function setSyncCursor(ctx: PluginContext, companyId: string, cursor: string): Promise<void> {
  await ctx.state.set(
    {
      scopeKind: "company",
      scopeId: companyId,
      namespace: "clawcredit",
      stateKey: "sync-cursor",
    },
    cursor,
  );
}

async function syncTransactions(
  ctx: PluginContext,
  config: ResolvedConfig,
  companyId: string,
): Promise<{ added: number }> {
  const cursor = await getSyncCursor(ctx, companyId);
  const existingIndex = new Set(await readTxnIndex(ctx, companyId));

  let added = 0;
  let page = 1;
  const limit = 100;
  let hasMore = true;
  let newestTimestamp: string | null = null;
  let seenOnPageCount = 0;

  while (hasMore) {
    const query = cursor
      ? `/v1/transaction/history?page=${page}&limit=${limit}&since=${encodeURIComponent(cursor)}`
      : `/v1/transaction/history?page=${page}&limit=${limit}`;

    const history = await ccFetch<{
      transactions: Array<{
        tx_hash: string;
        amount: number;
        recipient: string;
        chain: string;
        asset: string;
        status: string;
        created_at: string;
      }>;
      has_more?: boolean;
    }>(ctx, config, "GET", query);

    seenOnPageCount = 0;
    for (const tx of history.transactions) {
      if (existingIndex.has(tx.tx_hash)) {
        seenOnPageCount++;
        continue; // skip but don't break — same-timestamp txns may follow
      }

      const amountCents = Math.round(tx.amount * 100);
      const txn: StoredTransaction = {
        id: randomUUID(),
        tx_hash: tx.tx_hash,
        amountCents,
        recipient: tx.recipient,
        chain: tx.chain,
        asset: tx.asset,
        status: tx.status,
        eventKind: "credit_purchase",
        direction: "debit",
        biller: "clawcredit",
        description: `Payment to ${tx.recipient}`,
        occurredAt: tx.created_at,
      };

      await storeTxn(ctx, companyId, txn);
      await appendTxnIndex(ctx, companyId, tx.tx_hash);
      added++;

      if (!newestTimestamp || tx.created_at > newestTimestamp) {
        newestTimestamp = tx.created_at;
      }
    }

    // Stop paginating if entire page was already seen (we've caught up)
    hasMore = history.has_more === true && seenOnPageCount < history.transactions.length;
    page++;
    if (page > 100) break; // safety limit
  }

  if (newestTimestamp) {
    await setSyncCursor(ctx, companyId, newestTimestamp);
  }

  return { added };
}

// ---------------------------------------------------------------------------
// FIX #8: Response validation helper
// ---------------------------------------------------------------------------

function extractBalance(raw: unknown): BalanceResponse | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.available_usd !== "number") return null;
  if (typeof r.credit_score !== "number") return null;
  if (typeof r.total_available_usd !== "number") return null;
  // Default chain_credits to empty array if missing/invalid
  const chainCredits = Array.isArray(r.chain_credits) ? r.chain_credits : [];
  return { ...r, chain_credits: chainCredits } as BalanceResponse;
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("clawcredit-connector plugin setup");

    // ------------------------------------------------------------------
    // FIX #1: getData uses companyId from params for cache scoping
    // ------------------------------------------------------------------
    ctx.data.register("credit-status", async (params) => {
      const companyId = params.companyId as string;
      const config = await resolveConfig(ctx);
      if (!config) {
        return { configured: false, error: "No API token configured" };
      }

      try {
        let balance: BalanceResponse;
        const cached = companyId ? getCachedBalance(companyId) : null;
        if (cached) {
          balance = cached.data;
        } else {
          const raw = await ccFetch<unknown>(ctx, config, "GET", "/v1/credit/balance");
          const validated = extractBalance(raw);
          if (!validated) {
            return { configured: true, connected: false, error: "Invalid response from ClawCredit API" };
          }
          balance = validated;
          if (companyId) setCachedBalance(companyId, balance);
        }

        return {
          configured: true,
          connected: true,
          fetchedAt: new Date().toISOString(),
          balance: {
            available_usd: balance.available_usd,
            credit_score: balance.credit_score,
            total_available_usd: balance.total_available_usd,
            chain_credits: balance.chain_credits ?? [],
          },
          repayment: {
            amount_due_usd: balance.repayment_amount_due_usd ?? 0,
            due_at: balance.repayment_due_at ?? null,
            status: balance.repayment_status ?? null,
            urgency: balance.repayment_urgency ?? null,
            days_until_due: balance.repayment_days_until_due ?? null,
          },
        };
      } catch (err) {
        const stale = companyId ? balanceCacheByCompany.get(companyId) : undefined;
        return {
          configured: true,
          connected: false,
          fetchedAt: stale ? new Date(stale.fetchedAt).toISOString() : null,
          error: err instanceof ApiError ? `API ${err.status}` : "Connection failed",
          balance: stale
            ? {
                available_usd: stale.data.available_usd,
                credit_score: stale.data.credit_score,
                total_available_usd: stale.data.total_available_usd,
                chain_credits: stale.data.chain_credits ?? [],
              }
            : null,
          repayment: stale
            ? {
                amount_due_usd: stale.data.repayment_amount_due_usd ?? 0,
                due_at: stale.data.repayment_due_at ?? null,
                status: stale.data.repayment_status ?? null,
                urgency: stale.data.repayment_urgency ?? null,
                days_until_due: stale.data.repayment_days_until_due ?? null,
              }
            : null,
        };
      }
    });

    // ------------------------------------------------------------------
    // getData: transaction-history
    // ------------------------------------------------------------------
    ctx.data.register("transaction-history", async (params) => {
      const companyId = params.companyId as string;
      if (!companyId) return { transactions: [] };
      const limit = Math.min((params.limit as number) || 20, 100);
      const transactions = await readTransactions(ctx, companyId, limit);
      return { transactions };
    });

    // ------------------------------------------------------------------
    // getData: promotions
    // ------------------------------------------------------------------
    ctx.data.register("promotions", async (params) => {
      const config = await resolveConfig(ctx);
      if (!config) return { promotions: [] };

      try {
        const raw = await ccFetch<Record<string, unknown>>(ctx, config, "GET", "/v1/credit/balance");
        const promotions = Array.isArray(raw.promotions) ? raw.promotions : [];
        return { promotions };
      } catch {
        return { promotions: [] };
      }
    });

    // ------------------------------------------------------------------
    // performAction: test-connection
    // ------------------------------------------------------------------
    ctx.actions.register("test-connection", async (params) => {
      const config = await resolveConfig(ctx);
      if (!config) {
        return { connected: false, error: "No API token configured or secret resolution failed" };
      }
      try {
        const raw = await ccFetch<unknown>(ctx, config, "GET", "/v1/credit/balance");
        const balance = extractBalance(raw);
        if (!balance) {
          return { connected: false, error: "Invalid response from ClawCredit API" };
        }
        const companyId = params.companyId as string;
        if (companyId) setCachedBalance(companyId, balance);
        return { connected: true, available_usd: balance.available_usd };
      } catch (err) {
        return {
          connected: false,
          error: err instanceof ApiError ? `Authentication failed (${err.status})` : "Connection failed",
        };
      }
    });

    // ------------------------------------------------------------------
    // performAction: sync-now
    // ------------------------------------------------------------------
    ctx.actions.register("sync-now", async (params) => {
      const config = await resolveConfig(ctx);
      const companyId = params.companyId as string;
      if (!config || !companyId) {
        return { error: "Not configured" };
      }
      try {
        const result = await syncTransactions(ctx, config, companyId);
        return { synced: true, ...result };
      } catch (err) {
        ctx.logger.error("Manual sync failed", { error: String(err) });
        return { synced: false, error: String(err) };
      }
    });

    // ------------------------------------------------------------------
    // Tool: clawcredit_check_balance
    // ------------------------------------------------------------------
    ctx.tools.register(
      "clawcredit_check_balance",
      {
        displayName: "Check ClawCredit Balance",
        description: "Returns the company's available credit, score, and repayment status.",
        parametersSchema: { type: "object", properties: {} },
      },
      async (_params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
        const config = await resolveConfig(ctx);
        if (!config) {
          return { error: "ClawCredit is not configured. Set up the plugin in Paperclip settings." };
        }

        try {
          const raw = await ccFetch<unknown>(ctx, config, "GET", "/v1/credit/balance");
          const balance = extractBalance(raw);
          if (!balance) {
            return { error: "Invalid response from ClawCredit API. Balance fields missing." };
          }
          if (runCtx.companyId) setCachedBalance(runCtx.companyId, balance);

          return {
            content: `Available credit: $${balance.available_usd.toFixed(2)} | Score: ${balance.credit_score} | Total (incl. chain grants): $${balance.total_available_usd.toFixed(2)}`,
            data: {
              available_usd: balance.available_usd,
              credit_score: balance.credit_score,
              total_available_usd: balance.total_available_usd,
              chain_credits: balance.chain_credits,
            },
          };
        } catch (err) {
          return {
            error:
              err instanceof ApiError
                ? `ClawCredit API error ${err.status}: ${err.body}`
                : `Connection failed: ${String(err)}`,
          };
        }
      },
    );

    // ------------------------------------------------------------------
    // Tool: clawcredit_pay
    // FIX #2: Stable idempotency, separated error paths
    // FIX #5: Cents-based amount handling
    // ------------------------------------------------------------------
    ctx.tools.register(
      "clawcredit_pay",
      {
        displayName: "Pay via ClawCredit",
        description: "Make a payment on credit through ClawCredit.",
        parametersSchema: {
          type: "object",
          properties: {
            recipient: { type: "string" },
            amount_cents: { type: "integer" },
            chain: { type: "string", enum: ["BASE", "SOLANA", "XRPL"] },
            service_name: { type: "string" },
            description: { type: "string" },
            idempotency_key: { type: "string" },
          },
          required: ["recipient", "amount_cents"],
        },
      },
      async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
        const config = await resolveConfig(ctx);
        if (!config) {
          return { error: "ClawCredit is not configured." };
        }

        const p = params as {
          recipient: string;
          amount_cents: number;
          chain?: string;
          service_name?: string;
          description?: string;
          idempotency_key?: string;
        };

        // FIX #5: Validate cents (integer, positive, bounded)
        const amountCheck = validateAmountCents(p.amount_cents);
        if (!amountCheck.valid) {
          return { error: amountCheck.error };
        }
        const amountUsd = centsToUsd(amountCheck.cents);

        // Spending cap check (static config, no cache dependency)
        const maxUsd = config.maxTransactionUsd ?? 100;
        if (amountUsd > maxUsd) {
          return {
            error: `Amount $${amountUsd.toFixed(2)} exceeds the per-transaction cap of $${maxUsd.toFixed(2)}. Adjust maxTransactionUsd in plugin settings to increase.`,
          };
        }

        // Live balance check (bypass cache for pay)
        let liveBalance: BalanceResponse;
        try {
          const raw = await ccFetch<unknown>(ctx, config, "GET", "/v1/credit/balance");
          const validated = extractBalance(raw);
          if (!validated) {
            return { error: "Cannot verify balance: invalid API response." };
          }
          liveBalance = validated;
          if (runCtx.companyId) setCachedBalance(runCtx.companyId, liveBalance);
        } catch (err) {
          return {
            error: `Cannot verify balance: ${err instanceof ApiError ? `API ${err.status}` : String(err)}`,
          };
        }

        if (liveBalance.available_usd < amountUsd) {
          return {
            error: `Insufficient credit. Available: $${liveBalance.available_usd.toFixed(2)}, requested: $${amountUsd.toFixed(2)}.`,
            data: { available_usd: liveBalance.available_usd },
          };
        }

        // FIX #2: Stable idempotency key (no Date.now())
        const idempotencyKey =
          p.idempotency_key || `${runCtx.agentId}:${runCtx.runId}:${p.recipient}:${p.amount_cents}`;

        // Execute payment
        let result: PayResponse;
        try {
          result = await ccFetch<PayResponse>(ctx, config, "POST", "/v1/transaction/pay", {
            transaction: {
              recipient: p.recipient,
              amount: amountUsd,
              chain: p.chain || "BASE",
              asset: p.chain === "XRPL" ? "RLUSD" : "USDC",
            },
            request_body: {
              service_name: p.service_name || "agent-purchase",
              params: { description: p.description },
            },
            idempotencyKey,
          });
        } catch (err) {
          // FIX #2: Only API errors here, no post-payment side effects in this catch
          if (err instanceof ApiError) {
            const msg =
              err.status === 402
                ? "Insufficient balance or overdue payments."
                : err.status === 403
                  ? "Pre-qualification not complete or trustline rejected."
                  : `Payment failed (${err.status}).`;
            return { error: `${msg} ${err.body}` };
          }
          return { error: `Payment failed: ${String(err)}` };
        }

        // FIX #2: Post-payment side effects are fire-and-forget, never mask the success
        // FIX #6: Per-transaction state write (upsert by tx_hash)
        if (runCtx.companyId) {
          const chargedCents = Math.round(result.amount_charged * 100);
          const txn: StoredTransaction = {
            id: randomUUID(),
            tx_hash: result.tx_hash,
            amountCents: chargedCents,
            recipient: p.recipient,
            chain: result.chain,
            asset: p.chain === "XRPL" ? "RLUSD" : "USDC",
            status: result.status,
            eventKind: "credit_purchase",
            direction: "debit",
            biller: "clawcredit",
            description: p.description || `Payment to ${p.recipient}`,
            occurredAt: new Date().toISOString(),
            metadataJson: {
              agentId: runCtx.agentId,
              service_name: p.service_name,
              idempotency_key: idempotencyKey,
            },
          };

          try {
            await storeTxn(ctx, runCtx.companyId, txn);
            await appendTxnIndex(ctx, runCtx.companyId, result.tx_hash);
          } catch (stateErr) {
            ctx.logger.error("Failed to write transaction to state (payment succeeded)", {
              tx_hash: result.tx_hash,
              error: String(stateErr),
            });
          }

          try {
            await ctx.activity.log({
              companyId: runCtx.companyId,
              message: `ClawCredit payment: $${result.amount_charged.toFixed(2)} to ${p.recipient}`,
              entityType: "agent",
              entityId: runCtx.agentId,
              metadata: { tx_hash: result.tx_hash, chain: result.chain },
            });
          } catch (logErr) {
            ctx.logger.error("Activity log failed (payment succeeded)", {
              tx_hash: result.tx_hash,
              error: String(logErr),
            });
          }
        }

        return {
          content: `Payment successful. $${result.amount_charged.toFixed(2)} charged on ${result.chain}. Remaining balance: $${result.remaining_balance.toFixed(2)}. TX: ${result.tx_hash}`,
          data: {
            status: result.status,
            tx_hash: result.tx_hash,
            amount_charged: result.amount_charged,
            remaining_balance: result.remaining_balance,
            chain: result.chain,
          },
        };
      },
    );

    // ------------------------------------------------------------------
    // FIX #1, #4: Job syncs per-company using companies.read
    // FIX #7: Incremental sync via cursor
    // ------------------------------------------------------------------
    ctx.jobs.register("sync_transactions", async (job) => {
      ctx.logger.info("sync_transactions job started", { runId: job.runId });
      const config = await resolveConfig(ctx);
      if (!config) {
        ctx.logger.warn("Sync skipped: no API token configured");
        return;
      }

      try {
        let offset = 0;
        const pageSize = 50;
        let hasMore = true;
        while (hasMore) {
          const companies = await ctx.companies.list({ limit: pageSize, offset });
          for (const company of companies) {
            try {
              const result = await syncTransactions(ctx, config, company.id);
              if (result.added > 0) {
                ctx.logger.info(`Synced ${result.added} transactions for company ${company.id}`);
              }
            } catch (err) {
              ctx.logger.error(`Sync failed for company ${company.id}`, { error: String(err) });
            }
          }
          hasMore = companies.length === pageSize;
          offset += pageSize;
        }
      } catch (err) {
        ctx.logger.error("sync_transactions job failed", { error: String(err) });
      }
    });
  },

  async onHealth() {
    return {
      status: "ok",
      message: balanceCacheByCompany.size > 0 ? "ClawCredit connected" : "ClawCredit not yet configured",
    };
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    const c = config as ClawCreditConfig;

    if (!c.apiTokenRef || typeof c.apiTokenRef !== "string" || c.apiTokenRef.trim() === "") {
      errors.push("API token secret reference is required (e.g. env:CLAWCREDIT_TOKEN)");
    }

    if (c.serviceUrl && typeof c.serviceUrl === "string") {
      try {
        new URL(c.serviceUrl);
      } catch {
        errors.push("Service URL must be a valid URL");
      }
    }

    if (c.maxTransactionUsd !== undefined) {
      if (typeof c.maxTransactionUsd !== "number" || c.maxTransactionUsd <= 0) {
        errors.push("Max transaction must be a positive number");
      }
    }

    return { ok: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  },

  async onConfigChanged() {
    balanceCacheByCompany.clear();
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
