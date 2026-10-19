/**
 * /kemudi — one command for everything Kemudi account-related.
 *
 *   /kemudi                 this month's usage panel
 *   /kemudi 7d              7d | 30d | YYYY-MM | month
 *   /kemudi keys            + per-API-key breakdown
 *   /kemudi cost            rate table
 *   /kemudi cost glm 250k 4k  cost estimate
 *
 * Reads KEMUDI_API_KEY from the environment (never hardcoded).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, TruncatedText } from "@earendil-works/pi-tui";

const BASE_URL = "https://api.kemudi.cloud";
const TIMEOUT_MS = 10_000;

/** Period presets accepted by GET /v1/usage (apps/backend/internal/db/usage_period.go). */
const PERIODS = new Set(["month", "7d", "30d"]);

function resolvePeriod(arg?: string): string {
  const raw = (arg ?? "").trim().toLowerCase();
  if (PERIODS.has(raw)) return raw;
  // YYYY-MM, within the current or previous 11 months.
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  return "month";
}

type ModelUsage = {
  model: string;
  requests: number;
  tokens_in: number;
  cached_tokens_in: number;
  tokens_out: number;
  spend_usd: string;
  campaign_savings_usd?: string;
};

/** Shape of an entry in GET /v1/models. */
type ModelInfo = {
  id: string;
  context_window_tokens?: number;
  max_output_tokens?: number;
  paid?: boolean;
  input_per_m?: number | null;
  cached_input_per_m?: number | null;
  output_per_m?: number | null;
  /** Present when the model follows a time-of-day tariff. */
  pricing_schedule?: {
    id: string;
    timezone: string;
    off_peak_multiplier: string;
    off_peak_input_per_m: number;
    off_peak_cached_input_per_m: number;
    off_peak_output_per_m: number;
    current_period: string;
  } | null;
};

type KeyUsage = {
  key_id: number;
  label: string;
  requests: number;
  tokens_in: number;
  tokens_out: number;
  spend_usd: string;
};

type DailyUsage = {
  day: string;
  requests: number;
  total_tokens: number;
  spend_usd: string;
};

type UsageResponse = {
  period_label?: string;
  period_start?: string;
  period_end?: string;
  authenticated_key_id?: number;
  requests?: number;
  tokens_in?: number;
  cached_tokens_in?: number;
  tokens_out?: number;
  total_tokens?: number;
  spend_usd?: string;
  campaign_savings_usd?: string;
  usage?: KeyUsage[];
  by_model?: ModelUsage[];
  daily?: DailyUsage[];
  free_tier_tokens?: number;
  free_tier_tokens_per_day?: number;
  free_total_tokens?: number;
  free_today_tokens?: number;
  pending_holds_usd?: string;
};

/** A balance bucket in GET /v1/billing. */
type Bucket = {
  available_micro_cents?: number;
  available_usd?: string;
  held_micro_cents?: number;
  held_usd?: string;
};

/** A quota window in GET /v1/billing. */
type Quota = {
  limit_tokens?: number;
  unlimited?: boolean;
  used_tokens?: number;
  reserved_tokens?: number;
  remaining_tokens?: number | null;
  resets_at?: string;
};

/** GET /v1/billing — live wallet, credits and quota. */
type BillingResponse = {
  scope?: string;
  authenticated_key_id?: number;
  as_of?: string;
  currency?: string;
  wallet?: Bucket;
  promotional?: Bucket;
  credit_packs?: Bucket & {
    micro_cents_per_credit?: number;
    available_credits?: string;
    held_credits?: string;
  };
  funds?: Bucket;
  holds?: { count?: number; review_count?: number; oldest_review_at?: string | null };
  free_quota?: {
    timezone?: string;
    daily?: Quota;
    monthly?: Quota;
    effective_remaining_tokens?: number;
  };
  key_limits?: {
    free_monthly?: Quota;
    spend?: {
      pending_debt_micro_cents?: number;
      limit_micro_cents?: number;
      unlimited?: boolean;
      committed_micro_cents?: number | null;
      remaining_micro_cents?: number | null;
      resets_at?: string;
    };
    effective_paid_available_micro_cents?: number;
  };
  credits_expiring?: Array<{
    source?: string;
    expires_at?: string;
    available_micro_cents?: number;
    available_usd?: string;
  }>;
  credits_expiring_has_more?: boolean;
  outstanding_debt?: {
    count?: number;
    amount_usd?: string;
    requires_reconciliation?: boolean;
    blocks_paid_requests?: boolean;
  };
};

function parseTokenCount(raw: string): number {
  const m = raw.trim().toLowerCase().match(/^([0-9]*\.?[0-9]+)\s*([km])?$/);
  if (!m) return Number.NaN;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) return Number.NaN;
  if (m[2] === "k") return Math.round(n * 1_000);
  if (m[2] === "m") return Math.round(n * 1_000_000);
  return Math.round(n);
}

/**
 * Estimate cost from Kemudi's published per-million rates.
 *
 * `input_per_m` / `output_per_m` are PEAK rates; a model with a
 * pricing_schedule bills off-peak at `off_peak_*` rates instead. Pass
 * `offPeak` to bill at the discounted rate.
 *
 * Returns null when the model has no published rates (e.g. kemudi/free).
 */
function estimateCost(
  info: ModelInfo,
  tokensIn: number,
  tokensOut: number,
  cachedIn = 0,
  offPeak = false,
): { total: number; input: number; cached: number; output: number } | null {
  const sched = info.pricing_schedule;
  const useOffPeak = offPeak && !!sched;
  const inRate = useOffPeak ? sched!.off_peak_input_per_m : info.input_per_m;
  const outRate = useOffPeak ? sched!.off_peak_output_per_m : info.output_per_m;
  if (inRate == null || outRate == null) return null;
  const cachedRate = useOffPeak
    ? sched!.off_peak_cached_input_per_m
    : (info.cached_input_per_m ?? inRate);
  const cached = Math.min(Math.max(cachedIn, 0), tokensIn);
  const fresh = Math.max(tokensIn - cached, 0);
  const input = (fresh / 1_000_000) * inRate;
  const cacheCost = (cached / 1_000_000) * cachedRate;
  const output = (tokensOut / 1_000_000) * outRate;
  return { total: input + cacheCost + output, input, cached: cacheCost, output };
}

type ModelsResponse = { data?: ModelInfo[] };

async function fetchModels(apiKey: string): Promise<ModelInfo[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as ModelsResponse;
    return body.data ?? [];
  } finally {
    clearTimeout(timer);
  }
}

function money(v?: string | number | null): string {
  const n = typeof v === "string" ? Number.parseFloat(v) : (v ?? 0);
  if (!Number.isFinite(n)) return "$0.00";
  if (n !== 0 && Math.abs(n) < 0.01) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(2)}`;
}

function compact(n?: number): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function padStart(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

async function fetchUsage(apiKey: string, period = "month"): Promise<UsageResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${BASE_URL}/v1/usage?period=${encodeURIComponent(period)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 200);
      try {
        msg = JSON.parse(text)?.error?.message ?? msg;
      } catch {
        /* keep raw */
      }
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }
    return JSON.parse(text) as UsageResponse;
  } finally {
    clearTimeout(timer);
  }
}

/** GET /v1/billing — wallet, credits and quota (no period parameter). */
async function fetchBilling(apiKey: string): Promise<BillingResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/v1/billing`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 200);
      try {
        msg = JSON.parse(text)?.error?.message ?? msg;
      } catch {
        /* keep raw */
      }
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }
    return JSON.parse(text) as BillingResponse;
  } finally {
    clearTimeout(timer);
  }
}

function renderBilling(b: BillingResponse): string {
  const lines: string[] = [];
  lines.push("Kemudi billing — live balance");
  lines.push("");

  const funds = b.funds?.available_usd ?? "0";
  const wallet = b.wallet?.available_usd ?? "0";
  const promo = b.promotional?.available_usd ?? "0";
  const packs = b.credit_packs?.available_usd ?? "0";
  const held = b.funds?.held_usd ?? "0";

  lines.push(`  Available         ${money(funds)}`);
  const parts: string[] = [`wallet ${money(wallet)}`];
  if (Number.parseFloat(promo) > 0) parts.push(`promo ${money(promo)}`);
  if (Number.parseFloat(packs) > 0) parts.push(`packs ${money(packs)}`);
  lines.push(`  Breakdown         ${parts.join(" · ")}`);
  if (Number.parseFloat(held) > 0) lines.push(`  Held              ${money(held)}`);

  const fq = b.free_quota;
  if (fq) {
    const d = fq.daily;
    const m = fq.monthly;
    if (d) {
      const limit = d.unlimited ? "unlimited" : compact(d.limit_tokens);
      lines.push(`  Free today        ${compact(d.used_tokens)}/${limit}${d.unlimited ? "" : ` tok`}`);
    }
    if (m) {
      const limit = m.unlimited ? "unlimited" : compact(m.limit_tokens);
      lines.push(`  Free this month   ${compact(m.used_tokens)}/${limit}${m.unlimited ? "" : ` tok`}`);
    }
  }

  const expiring = b.credits_expiring ?? [];
  if (expiring.length) {
    const first = expiring[0];
    const when = (first.expires_at ?? "").slice(0, 10);
    lines.push(`  Expiring          ${money(first.available_usd)} on ${when} (${first.source ?? "?"})`);
    if (b.credits_expiring_has_more) lines.push(`  Credits expiring  more than shown`);
  }

  const debt = b.outstanding_debt;
  if (debt && Number.parseFloat(debt.amount_usd ?? "0") > 0) {
    lines.push(`  Outstanding debt  ${money(debt.amount_usd)}${debt.blocks_paid_requests ? " — BLOCKS REQUESTS" : ""}`);
  }
  if (b.holds?.review_count) {
    lines.push(`  Holds in review   ${b.holds.review_count}`);
  }

  return lines.join("\n");
}

function render(u: UsageResponse, showKeys: boolean, full = false): string {
  const lines: string[] = [];
  const period = u.period_label ?? "Current period";
  const start = u.period_start ? ` (${u.period_start} → ${u.period_end ?? "?"})` : "";
  lines.push(`Kemudi usage — ${period}${start}`);
  lines.push("");

  lines.push(`  Requests          ${(u.requests ?? 0).toLocaleString()}`);
  lines.push(`  Tokens            ${compact(u.tokens_in)} in (${compact(u.cached_tokens_in)} cached) · ${compact(u.tokens_out)} out`);
  lines.push(`  Spend             ${money(u.spend_usd)}`);

  const savings = Number.parseFloat(u.campaign_savings_usd ?? "0");
  const holds = Number.parseFloat(u.pending_holds_usd ?? "0");
  if (savings > 0 || holds > 0) {
    const parts: string[] = [];
    if (savings > 0) parts.push(`saved ${money(savings)}`);
    if (holds > 0) parts.push(`holds ${money(holds)}`);
    lines.push(`  Adjustments       ${parts.join(" · ")}`);
  }

  if (u.free_tier_tokens) {
    const used = u.free_total_tokens ?? 0;
    const today = u.free_today_tokens ?? 0;
    const perDay = u.free_tier_tokens_per_day ?? 0;
    lines.push(
      `  Free tier         ${compact(used)}/${compact(u.free_tier_tokens)}` +
        (perDay && today > 0 ? `  · today ${compact(today)}/${compact(perDay)}` : ""),
    );
  }

  const models = [...(u.by_model ?? [])].sort(
    (a, b) => Number.parseFloat(b.spend_usd) - Number.parseFloat(a.spend_usd),
  );
  if (models.length) {
    // Default view: one line naming the top model. `full` expands to a table.
    if (!full) {
      const top = models[0];
      const name = top.model.replace(/^kemudi\//, "");
      lines.push(
        `  Top model         ${name}  (${Math.round(
          (Number.parseFloat(top.spend_usd) / Math.max(Number.parseFloat(u.spend_usd ?? "0"), 1e-9)) * 100,
        )}% of spend)`,
      );
      if (models.length > 1) lines.push(`  Models used       ${models.length}  · add "all" for the table`);
    } else {
      lines.push("");
      lines.push("By model");
      lines.push(
        `  ${pad("MODEL", 30)} ${padStart("REQ", 5)} ${padStart("IN", 7)} ${padStart("OUT", 7)} ${padStart("SPEND", 10)}`,
      );
      for (const m of models) {
        const name = m.model.replace(/^kemudi\//, "");
        lines.push(
          `  ${pad(name, 30)} ${padStart(String(m.requests), 5)} ${padStart(compact(m.tokens_in), 7)} ` +
            `${padStart(compact(m.tokens_out), 7)} ${padStart(money(m.spend_usd), 10)}`,
        );
      }
    }
  }

  if (full) {
    const daily = [...(u.daily ?? [])].slice(-7);
    if (daily.length) {
      lines.push("");
      lines.push("Last days");
      for (const d of daily) {
        lines.push(
          `  ${d.day}  ${padStart(String(d.requests), 5)} req  ` +
            `${padStart(compact(d.total_tokens), 8)} tok  ${padStart(money(d.spend_usd), 9)}`,
        );
      }
    }
  }

  if (showKeys && u.usage?.length) {
    const keys = [...u.usage].sort(
      (a, b) => Number.parseFloat(b.spend_usd) - Number.parseFloat(a.spend_usd),
    );
    lines.push("");
    lines.push("By API key");
    for (const k of full ? keys : keys.slice(0, 10)) {
      const marker = k.key_id === u.authenticated_key_id ? " ← current" : "";
      lines.push(
        `  ${pad(k.label || `key ${k.key_id}`, 34)} ${padStart(String(k.requests), 5)} req  ` +
          `${padStart(money(k.spend_usd), 9)}${marker}`,
      );
    }
    if (!full && keys.length > 10) lines.push(`  … ${keys.length - 10} more key(s)`);
  }

  return lines.join("\n");
}

function totalsOnly(u: UsageResponse): string {
  const savings = Number.parseFloat(u.campaign_savings_usd ?? "0");
  const parts = [
    `${money(u.spend_usd)} spent`,
    `${compact(u.total_tokens)} tok`,
    `${(u.requests ?? 0).toLocaleString()} req`,
  ];
  if (savings > 0) parts.push(`${money(savings)} saved`);
  return `Kemudi ${u.period_label ?? ""}: ${parts.join(" · ")}`.replace("  ", " ");
}

const WIDGET_KEY = "kemudi";

/**
 * Render widget lines.
 *
 * Two pitfalls this avoids:
 *
 * 1. The string-array form of `setWidget` is hard-capped at 10 lines by Pi
 *    (InteractiveMode.MAX_WIDGET_LINES) and appends "... (widget truncated)".
 *    A component factory has no such cap.
 *
 * 2. `Text` WORD-WRAPS rather than clipping. Our lines are pre-padded into
 *    fixed-width columns, so on a narrower terminal each would wrap into extra
 *    rows; the widget then grows and crowds the editor until Pi restarts.
 *    `TruncatedText` clips to the viewport instead, so every entry stays
 *    exactly one row tall.
 */
function widget(ctx: any, lines: string[]): void {
  if (typeof ctx.ui?.setWidget !== "function") {
    for (const line of lines) console.log(line);
    return;
  }

  ctx.ui.setWidget(
    WIDGET_KEY,
    () => {
      const container = new Container();
      for (const line of lines) container.addChild(new TruncatedText(line, 1, 0));
      return container;
    },
    { placement: "aboveEditor" },
  );
}

export default function (pi: ExtensionAPI) {
  let cached: { at: number; period: string; data: UsageResponse } | null = null;
  let modelsCache: ModelInfo[] | null = null;
  const CACHE_MS = 30_000;

  function apiKey(): string | null {
    return process.env.KEMUDI_API_KEY ?? null;
  }

  const NO_KEY = "KEMUDI_API_KEY is not set in this shell. Add it to ~/.zshrc and restart pi.";

  async function getUsage(period: string, force = false): Promise<UsageResponse> {
    const key = apiKey();
    if (!key) throw new Error(NO_KEY);
    if (!force && cached && cached.period === period && Date.now() - cached.at < CACHE_MS) {
      return cached.data;
    }
    const data = await fetchUsage(key, period);
    cached = { at: Date.now(), period, data };
    return data;
  }

  async function getModels(): Promise<ModelInfo[]> {
    const key = apiKey();
    if (!key) throw new Error(NO_KEY);
    modelsCache = modelsCache ?? (await fetchModels(key));
    return modelsCache;
  }

  /** --- usage rendering ------------------------------------------------- */

  async function showUsage(ctx: any, period: string, showKeys: boolean, force: boolean, full: boolean) {
    const u = await getUsage(period, force);
    widget(ctx, render(u, showKeys, full).split("\n"));
    if (typeof ctx.ui?.setStatus === "function") ctx.ui.setStatus(WIDGET_KEY, totalsOnly(u));
    ctx.ui.notify(`Kemudi usage (${u.period_label ?? period}) shown above the editor.`, "info");
  }

  /** --- cost rendering -------------------------------------------------- */

  async function showRateTable(ctx: any) {
    const models = await getModels();
    const usable = models.filter((m) => m.id !== "kemudi/free");
    const lines: string[] = [
      "Kemudi price per 1M tokens",
      "",
      "  MODEL                        INPUT   CACHED   OUTPUT     CONTEXT",
    ];
    for (const m of usable) {
      lines.push(
        `  ${pad(m.id.replace(/^kemudi\//, ""), 26)} ${padStart(money(m.input_per_m), 8)} ` +
          `${padStart(money(m.cached_input_per_m ?? 0), 8)} ${padStart(money(m.output_per_m), 8)} ` +
          `${padStart(compact(m.context_window_tokens), 10)}`,
      );
      const s = m.pricing_schedule;
      if (s) {
        lines.push(
          `  ${pad(`  off-peak (x${s.off_peak_multiplier})`, 26)} ${padStart(money(s.off_peak_input_per_m), 8)} ` +
            `${padStart(money(s.off_peak_cached_input_per_m), 8)} ${padStart(money(s.off_peak_output_per_m), 8)}`,
        );
      }
    }
    lines.push("");
    lines.push("  Listed rates are PEAK. Models with a schedule bill cheaper off-peak.");
    lines.push("  Estimate: /kemudi cost <model> <in> <out> [--cached N] [--offpeak]");
    lines.push("  Tokens accept k/m suffixes: 250k, 1.5m");
    widget(ctx, lines);
    ctx.ui.notify("Kemudi rate table shown above the editor.", "info");
  }

  async function showEstimate(
    ctx: any,
    query: string,
    tokensIn: number,
    tokensOut: number,
    cachedIn: number,
    offPeak: boolean,
  ) {
    const models = await getModels();
    const usable = models.filter((m) => m.id !== "kemudi/free");
    const q = query.toLowerCase();
    const match =
      usable.find((m) => m.id.toLowerCase() === q) ??
      usable.find((m) => m.id.toLowerCase() === `kemudi/${q}`) ??
      usable.find((m) => m.id.toLowerCase().includes(q));

    if (!match) {
      ctx.ui.notify(
        `No Kemudi model matches "${query}". Available: ${usable.map((m) => m.id.replace(/^kemudi\//, "")).join(", ")}`,
        "error",
      );
      return;
    }

    const warnings: string[] = [];
    const ctxWindow = match.context_window_tokens ?? 0;
    const maxOut = match.max_output_tokens ?? 0;
    if (ctxWindow && tokensIn > ctxWindow) warnings.push(`input exceeds ${compact(ctxWindow)} context window`);
    if (maxOut && tokensOut > maxOut) warnings.push(`output exceeds ${compact(maxOut)} max_output_tokens (truncated)`);
    if (cachedIn > tokensIn) warnings.push("cached tokens clamped to input total");

    const cost = estimateCost(match, tokensIn, tokensOut, cachedIn, offPeak);
    const peakCost = estimateCost(match, tokensIn, tokensOut, cachedIn, false);
    const name = match.id.replace(/^kemudi\//, "");
    const lines: string[] = [`Cost estimate — ${name}${offPeak ? " (off-peak)" : ""}`, ""];

    if (!cost) {
      lines.push("  This model has no published per-token rates (free tier).");
      lines.push("  Free allowance: 1M tokens/month, 100K/day.");
    } else {
      const billedCached = Math.min(Math.max(cachedIn, 0), tokensIn);
      const fresh = Math.max(tokensIn - billedCached, 0);
      lines.push(`  Input (fresh)   ${padStart(compact(fresh), 8)} tok  →  ${money(cost.input)}`);
      if (billedCached > 0) {
        lines.push(`  Input (cached)  ${padStart(compact(billedCached), 8)} tok  →  ${money(cost.cached)}`);
      }
      lines.push(`  Output          ${padStart(compact(tokensOut), 8)} tok  →  ${money(cost.output)}`);
      lines.push(`  ${padStart("", 32)}  ──────────`);
      lines.push(`  Total           ${padStart(compact(tokensIn + tokensOut), 8)} tok  →  ${money(cost.total)}`);
      lines.push("");
      if (cost.total > 0) {
        lines.push(`  At this size: 100 requests ≈ ${money(cost.total * 100)} · 1,000 ≈ ${money(cost.total * 1000)}`);
      }
      const fullyCached = estimateCost(match, tokensIn, tokensOut, tokensIn, offPeak);
      if (fullyCached && billedCached < tokensIn) {
        lines.push(`  If fully cached: ${money(fullyCached.total)} (saves ${money(cost.total - fullyCached.total)})`);
      }
      const sched = match.pricing_schedule;
      if (sched && peakCost) {
        const other = offPeak
          ? `peak ${money(peakCost.total)}`
          : `off-peak ${money(estimateCost(match, tokensIn, tokensOut, cachedIn, true)?.total ?? 0)} (x${sched.off_peak_multiplier})`;
        lines.push(`  At ${other} instead.`);
        lines.push("");
        lines.push(`  Time-of-day tariff applies (${sched.timezone}).`);
      }
    }
    if (warnings.length) {
      lines.push("");
      for (const w of warnings) lines.push(`  ⚠ ${w}`);
    }
    lines.push("");
    lines.push("  Published peak list rates; campaign discounts not applied.");
    widget(ctx, lines);

    const summary = cost
      ? `${name}: ${compact(tokensIn + tokensOut)} tok ≈ ${money(cost.total)}`
      : `${name}: free tier`;
    ctx.ui.notify(summary, warnings.length ? "warning" : "info");
  }

  async function showBilling(ctx: any) {
    const key = apiKey();
    if (!key) throw new Error(NO_KEY);
    const b = await fetchBilling(key);
    widget(ctx, renderBilling(b).split("\n"));
    const funds = b.funds?.available_usd ?? "0";
    if (typeof ctx.ui?.setStatus === "function") ctx.ui.setStatus(WIDGET_KEY, `Kemudi ${money(funds)} available`);
    ctx.ui.notify(`Kemudi balance: ${money(funds)} available`, "info");
  }

  /** --- single command -------------------------------------------------- */

  pi.registerCommand("kemudi", {
    description:
      "Kemudi usage, balance and cost. Subcommands: [period] [keys] [all] | billing | cost [model in out]",
    handler: async (args, ctx) => {
      const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);

      try {
        // /kemudi billing
        if (argv[0] === "billing" || argv[0] === "balance") {
          return showBilling(ctx);
        }

        // /kemudi cost ...
        if (argv[0] === "cost") {
          let cachedIn = 0;
          let offPeak = false;
          const positional: string[] = [];
          const rest = argv.slice(1);
          for (let i = 0; i < rest.length; i++) {
            const a = rest[i];
            if (a === "--cached" || a === "-c") {
              cachedIn = parseTokenCount(rest[++i] ?? "0");
              if (!Number.isFinite(cachedIn)) {
                ctx.ui.notify("Invalid --cached value. Try --cached 200k", "error");
                return;
              }
            } else if (a === "--offpeak" || a === "--off-peak") {
              offPeak = true;
            } else if (a.startsWith("-")) {
              // ignore unknown flags
            } else {
              positional.push(a);
            }
          }
          if (positional.length === 0) return showRateTable(ctx);

          const tokensIn = positional.length > 1 ? parseTokenCount(positional[1]) : 0;
          const tokensOut = positional.length > 2 ? parseTokenCount(positional[2]) : 0;
          if (!Number.isFinite(tokensIn) || !Number.isFinite(tokensOut)) {
            ctx.ui.notify("Invalid token counts. Try /kemudi cost glm 250k 4k", "error");
            return;
          }
          return showEstimate(ctx, positional[0], tokensIn, tokensOut, cachedIn, offPeak);
        }

        // /kemudi [period] [keys] [all] [--refresh]
        const showKeys = argv.some((a) => a === "keys" || a === "--keys" || a === "-k");
        const full = argv.some((a) => a === "all" || a === "--all" || a === "-a");
        const force = argv.some((a) => a === "--refresh" || a === "-r");
        const periodArg = argv.find((a) => !a.startsWith("-") && a !== "keys" && a !== "all");
        return showUsage(ctx, resolvePeriod(periodArg), showKeys, force, full);
      } catch (err) {
        ctx.ui.notify(`Kemudi: ${(err as Error).message}`, "error");
      }
    },
  });

  pi.on("session_start", () => {
    cached = null;
    modelsCache = null;
  });
  pi.on("session_shutdown", () => {
    cached = null;
    modelsCache = null;
  });
}
