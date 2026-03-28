import {
  usePluginData,
  usePluginAction,
  type PluginWidgetProps,
  type PluginPageProps,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { useState } from "react";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type CreditStatus = {
  configured: boolean;
  connected: boolean;
  fetchedAt: string | null;
  error?: string;
  balance: {
    available_usd: number;
    credit_score: number;
    total_available_usd: number;
    chain_credits: Array<{
      chain: string;
      asset: string;
      balance_usd: number;
      source: string;
      expires_at?: string;
    }>;
  } | null;
  repayment: {
    amount_due_usd: number;
    due_at: string | null;
    status: "open" | "paid" | "overdue" | null;
    urgency: string | null;
    days_until_due: number | null;
  } | null;
};

type TransactionHistoryResponse = {
  transactions: Array<{
    id: string;
    tx_hash: string;
    amountCents: number;
    recipient: string;
    chain: string;
    status: string;
    eventKind: string;
    direction: "debit" | "credit";
    description: string;
    occurredAt: string;
  }>;
};

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function scoreColor(score: number): string {
  if (score >= 700) return "#22c55e"; // green
  if (score >= 500) return "#eab308"; // yellow
  return "#ef4444"; // red
}

function urgencyStyle(status: string | null, daysUntilDue: number | null) {
  if (status === "overdue" || (daysUntilDue !== null && daysUntilDue < 0)) {
    return { color: "#ef4444", label: "Overdue", bg: "rgba(239,68,68,0.1)" };
  }
  if (daysUntilDue !== null && daysUntilDue <= 3) {
    return { color: "#eab308", label: "Due Soon", bg: "rgba(234,179,8,0.1)" };
  }
  return { color: "#22c55e", label: "OK", bg: "rgba(34,197,94,0.1)" };
}

// ---------------------------------------------------------------------------
// Dashboard Widget
// ---------------------------------------------------------------------------

export function ClawCreditWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<CreditStatus>("credit-status", {
    companyId: context.companyId,
  });

  // Loading skeleton
  if (loading) {
    return (
      <section aria-label="ClawCredit" style={{ padding: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>ClawCredit</span>
        </div>
        <div style={{ height: 24, background: "rgba(255,255,255,0.06)", borderRadius: 6, marginBottom: 8 }} />
        <div style={{ height: 14, background: "rgba(255,255,255,0.04)", borderRadius: 4, marginBottom: 8, width: "60%" }} />
        <div style={{ height: 14, background: "rgba(255,255,255,0.04)", borderRadius: 4, width: "80%" }} />
      </section>
    );
  }

  // Not configured
  if (!data?.configured) {
    return (
      <section aria-label="ClawCredit" style={{ padding: "16px" }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>ClawCredit</div>
        <div style={{ fontSize: 13, color: "var(--muted-foreground, #888)" }}>
          Not configured. Set up your API token in plugin settings.
        </div>
      </section>
    );
  }

  const bal = data.balance;
  const rep = data.repayment;

  // Disconnected / stale
  const isStale = !data.connected;
  const urgency = rep ? urgencyStyle(rep.status, rep.days_until_due) : null;

  return (
    <section aria-label="ClawCredit" style={{ padding: "16px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>ClawCredit</span>
        {isStale && (
          <span
            style={{
              fontSize: 11,
              color: "#eab308",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#eab308", display: "inline-block" }} />
            as of {formatTime(data.fetchedAt)}
          </span>
        )}
        {!isStale && (
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e", display: "inline-block" }} />
        )}
      </div>

      {/* Primary: available credit */}
      {bal ? (
        <>
          <div
            style={{ fontSize: 24, fontWeight: 700, fontVariantNumeric: "tabular-nums", marginBottom: 2 }}
            aria-label={`${bal.available_usd.toFixed(2)} dollars available credit`}
          >
            {formatUsd(bal.available_usd)}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted-foreground, #888)", marginBottom: 12 }}>
            available credit
          </div>

          {/* Secondary: score + repayment */}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span>
              Score{" "}
              <span style={{ fontWeight: 600, color: scoreColor(bal.credit_score) }}>
                {bal.credit_score}
              </span>
            </span>
            {rep && rep.days_until_due !== null && (
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: 12,
                  fontSize: 11,
                  fontWeight: 500,
                  background: urgency?.bg,
                  color: urgency?.color,
                }}
                aria-label={`Repayment ${urgency?.label}: ${formatUsd(rep.amount_due_usd)} due in ${rep.days_until_due} days`}
              >
                {urgency?.label} {rep.days_until_due > 0 ? `${rep.days_until_due}d` : ""}
              </span>
            )}
          </div>
        </>
      ) : (
        <div style={{ fontSize: 13, color: "var(--muted-foreground, #888)" }}>
          Unable to load credit data.
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Plugin Page
// ---------------------------------------------------------------------------

export function ClawCreditPage({ context }: PluginPageProps) {
  const { data: status, loading: statusLoading } = usePluginData<CreditStatus>("credit-status", {
    companyId: context.companyId,
  });
  const { data: historyData, loading: historyLoading, refresh: refreshHistory } =
    usePluginData<TransactionHistoryResponse>("transaction-history", {
      companyId: context.companyId,
      limit: 20,
    });

  const syncNow = usePluginAction("sync-now");
  const [syncing, setSyncing] = useState(false);

  async function handleSync() {
    setSyncing(true);
    try {
      await syncNow({ companyId: context.companyId });
      refreshHistory();
    } finally {
      setSyncing(false);
    }
  }

  const bal = status?.balance;
  const rep = status?.repayment;
  const txns = historyData?.transactions ?? [];
  const urgency = rep ? urgencyStyle(rep.status, rep.days_until_due) : null;

  return (
    <div style={{ maxWidth: 960, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em", margin: 0 }}>ClawCredit</h1>
          <p style={{ fontSize: 14, color: "var(--muted-foreground, #888)", marginTop: 4 }}>
            Credit, repayment, and agent spending visibility.
          </p>
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          style={{
            padding: "6px 14px",
            fontSize: 13,
            borderRadius: 6,
            border: "1px solid var(--border, #333)",
            background: "transparent",
            color: "inherit",
            cursor: syncing ? "wait" : "pointer",
            opacity: syncing ? 0.6 : 1,
          }}
        >
          {syncing ? "Syncing..." : "Sync Now"}
        </button>
      </div>

      {/* Stale data warning */}
      {status && !status.connected && status.fetchedAt && (
        <div
          style={{
            padding: "8px 12px",
            marginBottom: 16,
            borderRadius: 6,
            border: "1px solid rgba(234,179,8,0.3)",
            background: "rgba(234,179,8,0.05)",
            fontSize: 13,
            color: "#eab308",
          }}
        >
          Showing cached data as of {new Date(status.fetchedAt).toLocaleString()}. ClawCredit API is unreachable.
        </div>
      )}

      {/* Metrics row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
        <MetricTile label="Available Credit" value={bal ? formatUsd(bal.available_usd) : "..."} loading={statusLoading} />
        <MetricTile
          label="Credit Score"
          value={bal ? String(bal.credit_score) : "..."}
          valueColor={bal ? scoreColor(bal.credit_score) : undefined}
          loading={statusLoading}
        />
        <MetricTile label="Credit Limit" value={bal ? formatUsd(bal.total_available_usd) : "..."} loading={statusLoading} />
        <MetricTile
          label={rep?.days_until_due !== null ? `Due in ${rep?.days_until_due}d` : "Repayment"}
          value={rep ? formatUsd(rep.amount_due_usd) : "..."}
          valueColor={urgency?.color}
          badge={urgency?.label}
          badgeBg={urgency?.bg}
          badgeColor={urgency?.color}
          loading={statusLoading}
        />
      </div>

      {/* Transaction History */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Transaction History</h2>
        {historyLoading ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--muted-foreground, #888)", fontSize: 13 }}>
            Loading transactions...
          </div>
        ) : txns.length === 0 ? (
          <div
            style={{
              padding: 32,
              textAlign: "center",
              border: "1px solid var(--border, #333)",
              borderRadius: 8,
              color: "var(--muted-foreground, #888)",
            }}
          >
            <div style={{ fontSize: 14, marginBottom: 4 }}>No transactions yet</div>
            <div style={{ fontSize: 12 }}>Agents will show up here when they spend on credit.</div>
          </div>
        ) : (
          <div style={{ border: "1px solid var(--border, #333)", borderRadius: 8, overflow: "hidden" }}>
            {txns.map((tx, i) => (
              <div
                key={tx.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "10px 14px",
                  borderBottom: i < txns.length - 1 ? "1px solid var(--border, #333)" : "none",
                  fontSize: 13,
                }}
              >
                <div>
                  <span
                    style={{
                      fontSize: 11,
                      padding: "2px 6px",
                      borderRadius: 4,
                      border: "1px solid var(--border, #333)",
                      marginRight: 8,
                    }}
                  >
                    {tx.eventKind}
                  </span>
                  <span style={{ color: "var(--muted-foreground, #888)" }}>{tx.description}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span
                    style={{
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 500,
                      color: tx.direction === "credit" ? "#22c55e" : "inherit",
                    }}
                  >
                    {tx.direction === "credit" ? "+" : "-"}{formatUsd(tx.amountCents / 100)}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--muted-foreground, #888)", minWidth: 48 }}>
                    {formatDate(tx.occurredAt)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bottom row: Repayment + Promotions */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {/* Repayment card */}
        <div style={{ border: "1px solid var(--border, #333)", borderRadius: 8, padding: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, marginTop: 0 }}>Repayment Schedule</h3>
          {rep && rep.amount_due_usd > 0 ? (
            <>
              <div style={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                {formatUsd(rep.amount_due_usd)}
              </div>
              <div style={{ fontSize: 12, color: "var(--muted-foreground, #888)", marginBottom: 8 }}>
                due {rep.due_at ? new Date(rep.due_at).toLocaleDateString() : ""}
              </div>
              {rep.days_until_due !== null && (
                <div
                  style={{
                    height: 6,
                    borderRadius: 3,
                    background: "rgba(255,255,255,0.08)",
                    marginBottom: 12,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${Math.max(0, Math.min(100, ((30 - Math.max(0, rep.days_until_due)) / 30) * 100))}%`,
                      background: urgency?.color,
                      borderRadius: 3,
                      transition: "width 0.3s",
                    }}
                  />
                </div>
              )}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  // getDashboardLink() would open external dashboard
                }}
                style={{ fontSize: 13, color: "var(--primary, #3b82f6)" }}
              >
                Pay Now (opens ClawCredit) ↗
              </a>
            </>
          ) : (
            <div style={{ fontSize: 13, color: "var(--muted-foreground, #888)" }}>
              No repayment scheduled ✓
            </div>
          )}
        </div>

        {/* Promotions card */}
        <div style={{ border: "1px solid var(--border, #333)", borderRadius: 8, padding: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, marginTop: 0 }}>Promotions & Grants</h3>
          {bal && bal.chain_credits.length > 0 ? (
            <div>
              {bal.chain_credits.map((cc, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    padding: "4px 0",
                    fontSize: 13,
                    borderBottom: i < bal.chain_credits.length - 1 ? "1px solid var(--border, #333)" : "none",
                  }}
                >
                  <span>
                    {cc.chain}: {cc.source}
                  </span>
                  <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>
                    {formatUsd(cc.balance_usd)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: "var(--muted-foreground, #888)" }}>
              No active promotions
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metric Tile (reusable)
// ---------------------------------------------------------------------------

function MetricTile({
  label,
  value,
  valueColor,
  badge,
  badgeBg,
  badgeColor,
  loading,
}: {
  label: string;
  value: string;
  valueColor?: string;
  badge?: string;
  badgeBg?: string;
  badgeColor?: string;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div style={{ border: "1px solid var(--border, #333)", borderRadius: 8, padding: 14 }}>
        <div style={{ height: 12, background: "rgba(255,255,255,0.06)", borderRadius: 4, marginBottom: 8, width: "50%" }} />
        <div style={{ height: 20, background: "rgba(255,255,255,0.04)", borderRadius: 4, width: "70%" }} />
      </div>
    );
  }

  return (
    <div style={{ border: "1px solid var(--border, #333)", borderRadius: 8, padding: 14 }}>
      <div style={{ fontSize: 11, color: "var(--muted-foreground, #888)", marginBottom: 4, display: "flex", justifyContent: "space-between" }}>
        <span>{label}</span>
        {badge && (
          <span
            style={{
              fontSize: 10,
              padding: "1px 6px",
              borderRadius: 10,
              background: badgeBg,
              color: badgeColor,
              fontWeight: 500,
            }}
          >
            {badge}
          </span>
        )}
      </div>
      <div style={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: "tabular-nums", color: valueColor }}>
        {value}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings Page
// ---------------------------------------------------------------------------

export function ClawCreditSettings({ context }: PluginSettingsPageProps) {
  const testConnection = usePluginAction("test-connection");
  const [testing, setTesting] = useState(false);
  const [connectionResult, setConnectionResult] = useState<{
    connected: boolean;
    error?: string;
    available_usd?: number;
  } | null>(null);

  async function handleTestConnection() {
    setTesting(true);
    setConnectionResult(null);
    try {
      const result = (await testConnection({})) as {
        connected: boolean;
        error?: string;
        available_usd?: number;
      };
      setConnectionResult(result);
    } catch (err) {
      setConnectionResult({ connected: false, error: String(err) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <p style={{ fontSize: 13, color: "var(--muted-foreground, #888)", marginBottom: 20 }}>
        Connect your ClawCredit account to monitor credit, repayment, and agent spending. The API
        token is resolved from a secret reference at runtime (never stored in plain config).
      </p>

      {/* Connection test button */}
      <div style={{ marginBottom: 24 }}>
        <button
          onClick={handleTestConnection}
          disabled={testing}
          style={{
            padding: "8px 16px",
            fontSize: 13,
            borderRadius: 6,
            border: "1px solid var(--border, #333)",
            background: "transparent",
            color: "inherit",
            cursor: testing ? "wait" : "pointer",
          }}
        >
          {testing ? "Testing..." : "Test Connection"}
        </button>

        {connectionResult && (
          <div
            style={{
              marginTop: 8,
              padding: "8px 12px",
              borderRadius: 6,
              fontSize: 13,
              background: connectionResult.connected ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)",
              color: connectionResult.connected ? "#22c55e" : "#ef4444",
              border: `1px solid ${connectionResult.connected ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)"}`,
            }}
          >
            {connectionResult.connected
              ? `Connected. Available credit: ${formatUsd(connectionResult.available_usd ?? 0)}`
              : `Connection failed: ${connectionResult.error}`}
          </div>
        )}
      </div>

      {/* Info */}
      <div style={{ fontSize: 12, color: "var(--muted-foreground, #888)", lineHeight: 1.6 }}>
        <p style={{ marginBottom: 8 }}>
          <strong>API Token Ref:</strong> A secret reference like <code>env:CLAWCREDIT_TOKEN</code> or{" "}
          <code>vault:clawcredit/token</code>. The actual token is resolved at runtime, never stored in config.
        </p>
        <p style={{ marginBottom: 8 }}>
          <strong>Max Transaction:</strong> Per-transaction spending cap. Agents cannot make
          payments exceeding this amount. Default: $100.
        </p>
        <p>
          <strong>Service URL:</strong> Leave blank to use the default ClawCredit API. Set a custom
          URL for local development or staging environments.
        </p>
      </div>
    </div>
  );
}
