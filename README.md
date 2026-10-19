# pi-kemudi

A [Pi](https://pi.dev) extension that puts your Kemudi **usage, balance, and cost
estimates** one slash command away — without leaving the terminal.

```
/kemudi                # this month's usage
/kemudi billing        # live balance and credits
/kemudi cost glm 250k 4k   # estimate a request before sending it
```

> **Unofficial.** This is a community extension. It is not published, endorsed,
> or supported by Kemudi Labs. It talks to Kemudi's public HTTP API using your own
> API key.

---

## Install

```sh
pi install git:github.com/kemudilabs/pi-kemudi
```

Or load it for a single run without installing:

```sh
pi -e ./src/index.ts
```

### Credentials

The extension reads your key from the environment — **it never hardcodes or
stores a credential**:

```sh
export KEMUDI_API_KEY="sk-kemudi-..."
```

Put that in your shell profile (`~/.zshrc`, `~/.bashrc`) and restart Pi. Pi's
own `models.json` provider config can reference the same variable:

```json
{
  "providers": {
    "kemudi": {
      "baseUrl": "https://api.kemudi.cloud/v1",
      "api": "openai-completions",
      "apiKey": "$KEMUDI_API_KEY"
    }
  }
}
```

## Commands

Everything lives under a single `/kemudi` command.

### Usage

| Command | Shows |
| --- | --- |
| `/kemudi` | Current month: requests, tokens, spend, top model |
| `/kemudi 7d` | Last 7 days |
| `/kemudi 30d` | Last 30 days |
| `/kemudi 2026-09` | A specific month (current or previous 11) |
| `/kemudi all` | Full model table + daily breakdown |
| `/kemudi keys` | Per-API-key attribution, current key marked |
| `/kemudi --refresh` | Bypass the 30-second cache |

### Balance

| Command | Shows |
| --- | --- |
| `/kemudi billing` | Available funds, wallet/promo/pack split, free quota, expiring credits |
| `/kemudi balance` | Alias for `billing` |

The footer status line mirrors your available balance after running it.

### Cost estimation

| Command | Shows |
| --- | --- |
| `/kemudi cost` | Rate table for every model (peak and off-peak) |
| `/kemudi cost glm 250k 4k` | Estimate for that request size |
| `/kemudi cost deepseek-v4.1 250k 4k --offpeak` | Estimate at off-peak rates |
| `/kemudi cost glm 250k 4k --cached 200k` | Estimate with prefix-cache hits |

Token counts accept `k` and `m` suffixes (`250k`, `1.5m`). Model names fuzzy-match:
`glm`, `v4.1`, `120b` all resolve.

The estimator reports the input/output/cached breakdown, extrapolates to 100 and
1,000 requests, and warns when your input exceeds the model's context window or
your output exceeds `max_output_tokens`.

## Notes on pricing

Kemudi's published `input_per_m` / `output_per_m` rates are **peak** rates. Models
with a time-of-day tariff bill cheaper off-peak; the extension reads the
`pricing_schedule` block when the API exposes it and shows both figures.

Estimates use published list rates and **do not apply campaign discounts**. Actual
billed spend will often come in lower than the estimate — treat `/kemudi cost` as
an upper bound and `/kemudi` as ground truth.

## How it works

| Endpoint | Used for |
| --- | --- |
| `GET /v1/usage` | Requests, tokens, spend, per-model and daily breakdown. Accepts `period=month\|7d\|30d\|YYYY-MM`. |
| `GET /v1/billing` | Point-in-time snapshot: wallet, promotional credit, credit packs, free quota, expiring credits, outstanding debt. Rejects `period`. |
| `GET /v1/models` | Per-model rates, context window, `max_output_tokens`, pricing schedule. |

All responses are treated as optional on a per-field basis, so the extension
degrades gracefully if the API adds or omits fields.

### Rendering

The panel is drawn through `ctx.ui.setWidget()` with a component factory using
`TruncatedText`. Two Pi behaviours make this necessary:

- The string-array form of `setWidget` is capped at 10 lines and appends
  `... (widget truncated)`.
- `Text` **word-wraps**; pre-padded column output would then grow every render and
  crowd the editor. `TruncatedText` clips to the viewport instead.

## Requirements

- Pi `1.3.0` or newer
- Node 20+
- A Kemudi API key with access to the usage and billing endpoints

## Development

```sh
npm install
npm run typecheck
```

Then point Pi at your working copy:

```sh
pi -e ./src/index.ts
```

## License

MIT — see [LICENSE](LICENSE).
