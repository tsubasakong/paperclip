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
};

type RepaymentResponse = {
  repayment_amount_due_usd: number;
  repayment_due_at: string | null;
  repayment_status: "open" | "paid" | "overdue" | null;
  repayment_urgency: string | null;
  repayment_days_until_due: number | null;
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
  amount_usd: number;
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
// In-memory cache (60s TTL for balance/repayment reads)
// ---------------------------------------------------------------------------

type CachedData<T> = { data: T; fetchedAt: number };
const CACHE_TTL_MS = 60_000;

let balanceCache: CachedData<BalanceResponse> | null = null;
let repaymentCache: CachedData<RepaymentResponse> | null = null;

function isFresh<T>(cache: CachedData<T> | null): cache is CachedData<T> {
  return cache !== null && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// ClawCredit API client (raw HTTP, no SDK filesystem side effects)
// ---------------------------------------------------------------------------

async function ccFetch<T>(
  ctx: PluginContext,
  config: ClawCreditConfig,
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
// State helpers
// ---------------------------------------------------------------------------

async function getConfig(ctx: PluginContext): Promise<ClawCreditConfig> {
  const raw = await ctx.config.get();
  return raw as ClawCreditConfig;
}

async function readTransactions(ctx: PluginContext, companyId: string): Promise<StoredTransaction[]> {
  const data = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    namespace: "clawcredit",
    stateKey: "transactions",
  });
  return (data as StoredTransaction[] | null) ?? [];
}

async function writeTransactions(
  ctx: PluginContext,
  companyId: string,
  txns: StoredTransaction[],
): Promise<void> {
  // Keep last 1000 transactions
  const trimmed = txns.slice(0, 1000);
  await ctx.state.set(
    {
      scopeKind: "company",
      scopeId: companyId,
      namespace: "clawcredit",
      stateKey: "transactions",
    },
    trimmed,
  );
}

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

// ---------------------------------------------------------------------------
// Sync logic
// ---------------------------------------------------------------------------

async function syncTransactions(
  ctx: PluginContext,
  config: ClawCreditConfig,
  companyId: string,
): Promise<{ added: number }> {
  const existing = await readTransactions(ctx, companyId);
  const existingHashes = new Set(existing.map((t) => t.tx_hash));

  // Poll all pages
  const newTxns: StoredTransaction[] = [];
  let page = 1;
  const limit = 100;
  let hasMore = true;

  while (hasMore) {
    const history = await ccFetch<{
      transactions: Array<{
        tx_hash: string;
        amount: number;
        recipient: string;
        chain: string;
        asset: string;
        status: string;
        reject_reason?: string;
        created_at: string;
      }>;
      has_more?: boolean;
    }>(ctx, config, "GET", `/v1/transaction/history?page=${page}&limit=${limit}`);

    for (const tx of history.transactions) {
      if (existingHashes.has(tx.tx_hash)) continue;

      newTxns.push({
        id: randomUUID(),
        tx_hash: tx.tx_hash,
        amount_usd: tx.amount,
        amountCents: Math.round(tx.amount * 100),
        recipient: tx.recipient,
        chain: tx.chain,
        asset: tx.asset,
        status: tx.status,
        eventKind: "credit_purchase",
        direction: "debit",
        biller: "clawcredit",
        description: `Payment to ${tx.recipient}`,
        occurredAt: tx.created_at,
      });
    }

    hasMore = history.has_more === true;
    page++;
    // Safety limit to prevent infinite loops
    if (page > 100) break;
  }

  if (newTxns.length > 0) {
    const merged = [...newTxns, ...existing].sort(
      (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    );
    await writeTransactions(ctx, companyId, merged);

    if (newTxns[0]) {
      await setSyncCursor(ctx, companyId, newTxns[0].occurredAt);
    }
  }

  return { added: newTxns.length };
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("clawcredit-connector plugin setup");

    // ------------------------------------------------------------------
    // getData: credit-status
    // ------------------------------------------------------------------
    ctx.data.register("credit-status", async (params) => {
      const config = await getConfig(ctx);
      if (!config.apiToken) {
        return { configured: false, error: "No API token configured" };
      }

      try {
        // Use cache for reads (60s TTL)
        let balance: BalanceResponse;
        if (isFresh(balanceCache)) {
          balance = balanceCache.data;
        } else {
          balance = await ccFetch<BalanceResponse>(ctx, config, "GET", "/v1/credit/balance");
          balanceCache = { data: balance, fetchedAt: Date.now() };
        }

        let repayment: RepaymentResponse;
        if (isFresh(repaymentCache)) {
          repayment = repaymentCache.data;
        } else {
          try {
            repayment = await ccFetch<RepaymentResponse>(
              ctx,
              config,
              "GET",
              "/v1/credit/balance", // repayment fields included in balance response
            );
            repaymentCache = { data: repayment, fetchedAt: Date.now() };
          } catch {
            repayment = {
              repayment_amount_due_usd: 0,
              repayment_due_at: null,
              repayment_status: null,
              repayment_urgency: null,
              repayment_days_until_due: null,
            };
          }
        }

        return {
          configured: true,
          connected: true,
          fetchedAt: new Date().toISOString(),
          balance: {
            available_usd: balance.available_usd,
            credit_score: balance.credit_score,
            total_available_usd: balance.total_available_usd,
            chain_credits: balance.chain_credits,
          },
          repayment: {
            amount_due_usd: repayment.repayment_amount_due_usd,
            due_at: repayment.repayment_due_at,
            status: repayment.repayment_status,
            urgency: repayment.repayment_urgency,
            days_until_due: repayment.repayment_days_until_due,
          },
        };
      } catch (err) {
        const staleBalance = balanceCache?.data;
        return {
          configured: true,
          connected: false,
          fetchedAt: balanceCache ? new Date(balanceCache.fetchedAt).toISOString() : null,
          error: err instanceof ApiError ? `API ${err.status}` : "Connection failed",
          balance: staleBalance
            ? {
                available_usd: staleBalance.available_usd,
                credit_score: staleBalance.credit_score,
                total_available_usd: staleBalance.total_available_usd,
                chain_credits: staleBalance.chain_credits,
              }
            : null,
          repayment: repaymentCache?.data
            ? {
                amount_due_usd: repaymentCache.data.repayment_amount_due_usd,
                due_at: repaymentCache.data.repayment_due_at,
                status: repaymentCache.data.repayment_status,
                urgency: repaymentCache.data.repayment_urgency,
                days_until_due: repaymentCache.data.repayment_days_until_due,
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
      const transactions = await readTransactions(ctx, companyId);
      const limit = Math.min((params.limit as number) || 20, 100);
      return { transactions: transactions.slice(0, limit) };
    });

    // ------------------------------------------------------------------
    // getData: promotions
    // ------------------------------------------------------------------
    ctx.data.register("promotions", async () => {
      const config = await getConfig(ctx);
      if (!config.apiToken) return { promotions: [] };

      try {
        const res = await ccFetch<{ promotions: unknown[] }>(
          ctx,
          config,
          "GET",
          "/v1/credit/balance", // promotions included in dashboard overview
        );
        return { promotions: res.promotions ?? [] };
      } catch {
        return { promotions: [] };
      }
    });

    // ------------------------------------------------------------------
    // performAction: test-connection
    // ------------------------------------------------------------------
    ctx.actions.register("test-connection", async () => {
      const config = await getConfig(ctx);
      if (!config.apiToken) {
        return { connected: false, error: "No API token configured" };
      }
      try {
        const balance = await ccFetch<BalanceResponse>(ctx, config, "GET", "/v1/credit/balance");
        balanceCache = { data: balance, fetchedAt: Date.now() };
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
      const config = await getConfig(ctx);
      const companyId = params.companyId as string;
      if (!config.apiToken || !companyId) {
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
        const config = await getConfig(ctx);
        if (!config.apiToken) {
          return { error: "ClawCredit is not configured. Set up the plugin in Paperclip settings." };
        }

        try {
          const balance = await ccFetch<BalanceResponse>(ctx, config, "GET", "/v1/credit/balance");
          balanceCache = { data: balance, fetchedAt: Date.now() };

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
            amount: { type: "number" },
            chain: { type: "string", enum: ["BASE", "SOLANA", "XRPL"] },
            service_name: { type: "string" },
            description: { type: "string" },
            idempotency_key: { type: "string" },
          },
          required: ["recipient", "amount"],
        },
      },
      async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
        const config = await getConfig(ctx);
        if (!config.apiToken) {
          return { error: "ClawCredit is not configured." };
        }

        const p = params as {
          recipient: string;
          amount: number;
          chain?: string;
          service_name?: string;
          description?: string;
          idempotency_key?: string;
        };

        // Validate amount
        if (!p.amount || p.amount <= 0) {
          return { error: "Amount must be positive." };
        }

        // Spending cap check (static config, no cache dependency)
        const maxUsd = config.maxTransactionUsd ?? 100;
        if (p.amount > maxUsd) {
          return {
            error: `Amount $${p.amount.toFixed(2)} exceeds the per-transaction cap of $${maxUsd.toFixed(2)}. Adjust maxTransactionUsd in plugin settings to increase.`,
          };
        }

        // Live balance check (bypass cache for pay)
        let liveBalance: BalanceResponse;
        try {
          liveBalance = await ccFetch<BalanceResponse>(ctx, config, "GET", "/v1/credit/balance");
          balanceCache = { data: liveBalance, fetchedAt: Date.now() };
        } catch (err) {
          return {
            error: `Cannot verify balance: ${err instanceof ApiError ? `API ${err.status}` : String(err)}`,
          };
        }

        if (liveBalance.available_usd < p.amount) {
          return {
            error: `Insufficient credit. Available: $${liveBalance.available_usd.toFixed(2)}, requested: $${p.amount.toFixed(2)}.`,
            data: { available_usd: liveBalance.available_usd },
          };
        }

        // Generate idempotency key if not provided
        const idempotencyKey =
          p.idempotency_key || `${runCtx.agentId}-${p.recipient}-${p.amount}-${Date.now()}`;

        // Execute payment
        try {
          const result = await ccFetch<PayResponse>(ctx, config, "POST", "/v1/transaction/pay", {
            transaction: {
              recipient: p.recipient,
              amount: p.amount,
              chain: p.chain || "BASE",
              asset: p.chain === "XRPL" ? "RLUSD" : "USDC",
            },
            request_body: {
              service_name: p.service_name || "agent-purchase",
              params: { description: p.description },
            },
            idempotencyKey,
          });

          // Sync-on-write: immediately store the transaction in plugin state
          if (runCtx.companyId) {
            const txn: StoredTransaction = {
              id: randomUUID(),
              tx_hash: result.tx_hash,
              amount_usd: result.amount_charged,
              amountCents: Math.round(result.amount_charged * 100),
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
              const existing = await readTransactions(ctx, runCtx.companyId);
              await writeTransactions(ctx, runCtx.companyId, [txn, ...existing]);
            } catch (stateErr) {
              ctx.logger.error("Failed to write transaction to state (payment succeeded)", {
                tx_hash: result.tx_hash,
                error: String(stateErr),
              });
            }
          }

          await ctx.activity.log({
            companyId: runCtx.companyId,
            message: `ClawCredit payment: $${result.amount_charged.toFixed(2)} to ${p.recipient}`,
            entityType: "agent",
            entityId: runCtx.agentId,
            metadata: { tx_hash: result.tx_hash, chain: result.chain },
          });

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
        } catch (err) {
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
      },
    );

    // ------------------------------------------------------------------
    // Job: sync_transactions
    // ------------------------------------------------------------------
    ctx.jobs.register("sync_transactions", async (job) => {
      ctx.logger.info("sync_transactions job started", { runId: job.runId });
      const config = await getConfig(ctx);
      if (!config.apiToken) {
        ctx.logger.warn("Sync skipped: no API token configured");
        return;
      }

      // Sync for all companies this plugin is installed on
      // For now, use instance-level sync with the configured token
      try {
        const companies = await ctx.companies.list({ limit: 50, offset: 0 });
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
      } catch (err) {
        ctx.logger.error("sync_transactions job failed", { error: String(err) });
      }
    });
  },

  async onHealth() {
    const hasToken = balanceCache !== null;
    return {
      status: "ok",
      message: hasToken ? "ClawCredit connected" : "ClawCredit not yet configured",
    };
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    const c = config as ClawCreditConfig;

    if (!c.apiToken || typeof c.apiToken !== "string" || c.apiToken.trim() === "") {
      errors.push("API token is required");
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
    // Clear cache when config changes (new token, new service URL)
    balanceCache = null;
    repaymentCache = null;
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
