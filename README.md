# OVER watch

A live tracker for [Overtime](https://www.overtime.io/) ($OVER): treasury stablecoins, the house result, buybacks and buyback yield, supply and free float, DEX liquidity and governance votes, with three thesis checks.

[provatidis.com/overwatch](https://provatidis.com/overwatch/)

## How it works

A GitHub Action (`.github/workflows/snapshot.yml`) runs `scripts/snapshot.mjs` once a day at 04:17 UTC, and whenever the script or `lib/` changes. It collects:

- **House result, buybacks and treasury** from DefiLlama's public API.
- **Supply** straight from the OVER contracts on Ethereum, Optimism, Arbitrum and Base through public RPCs, with the top holders from Blockscout to find the Chainlink bridge pool on Ethereum.
- **Liquidity** from DexScreener.
- **Governance** from the `thalesgov.eth` space on Snapshot.
- **Price and market cap** from CoinGecko.

It writes `data/latest.json` and adds a row to `data/history.json`, then commits both. The page reads those files and fetches a live price on load. If the snapshot is missing, it falls back to DefiLlama for the core charts.

## Alerts

When a thesis check gets worse (Healthy → Watch → Alert), the job opens an issue in this repo, and it closes that issue when the check is Healthy again. It also opens an issue for every new Snapshot vote. GitHub emails you about new issues in your own repos, so watching the repo is enough.

## Tuning

- Check thresholds: `THRESHOLDS` in `lib/config.js`.
- Treasury wallets counted in the supply panel: `OVER.treasury` in `lib/config.js`. If the panel's note shows a big gap between DefiLlama's own-token value and the treasury figure, a wallet is missing.
- Run the job by hand: Actions → Daily snapshot → Run workflow.

## Local preview

Plain HTML, CSS and JavaScript modules; no build step or dependencies.

```sh
python3 -m http.server 8765 --bind 127.0.0.1   # page
node scripts/snapshot.mjs                       # refresh data/ (Node 20+)
```

Open http://127.0.0.1:8765. The favicon and home links point at the main site, so they only resolve once deployed.

Not financial advice.
