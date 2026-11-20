# OVER watch

A live tracker for [Overtime](https://www.overtime.io/) ($OVER): treasury stablecoins, the house result, buybacks and buyback yield, supply and free float, DEX liquidity and governance votes, with three thesis checks.

[provatidis.com/overwatch](https://provatidis.com/overwatch/)

## How it works

A GitHub Action (`.github/workflows/snapshot.yml`) runs `scripts/snapshot.mjs` once a day at 04:17 UTC, and whenever the script or `lib/` changes. It collects:

- **House result, buybacks and treasury** from DefiLlama's public API.
- **Betting-pool capital** straight from the USDC sportsbook pools on Optimism, Arbitrum and Base.
- **Supply** straight from the OVER contracts on Ethereum, Optimism, Arbitrum and Base through public RPCs, with the top holders from Blockscout to find the Chainlink bridge pool on Ethereum.
- **Liquidity** from DexScreener.
- **Governance** from the `thalesgov.eth` space on Snapshot.
- **Price and market cap** from CoinGecko.

It writes `data/latest.json` and adds a row to `data/history.json`, then commits both. The page reads those files and fetches a live price on load. If the snapshot is missing, it falls back to DefiLlama for the core charts.

### How the numbers are kept honest

- **Completed days only.** DefiLlama pulls Overtime hourly and files each day under its UTC start, so the newest entry is today so far. Headline figures and checks stop at the last full day, and the cards say which day that is.
- **One measure at a time.** On 21 Jul 2026 (OIP-265) DefiLlama switched from counting fees and the SafeBox share of profitable pool rounds to the full betting result. The house-result trend check stays “Not comparable yet” until a 90-day window and the 90 days before it both fall after the switch (17 Jan 2027). Bars that mix both measures are starred.
- **Failures never look like events.** Every onchain read must succeed (a failed balance read never counts as zero), the Ethereum bridge balance must match the supply on the other chains, and circulating supply must stay under the maximum. A source that fails is carried over from the last good snapshot with its own “as of” date, the page says so, and checks that depend on it are marked stale and never alert.
- **Who voted.** Each governance row says whether the vote was cast with the council’s TC-NFTs or with OVER.
- **Replies are checked, not trusted.** A daily series that comes back empty, shorter than before or more than three days old counts as a failed read. So does an empty proposal list, and new-vote alerts only fire for proposals created after the last good governance read.

### Where the money went

Since OIP-265 the house's money sits in two places: the treasury wallets (DefiLlama) and the betting pools, where the treasury is the only liquidity provider. The job reads each pool's current round contract onchain (`round()` → `roundPools(round)` → its USDC balance), so bettors' stakes in open bets are never counted; the house's own share of open bets isn't either. Each day's reading goes into `history.json`.

The reconciliation compares, over up to 30 days of those readings, what the house made minus buybacks with what actually happened to treasury + pool stablecoins. The difference is "other flows": running costs, DEX incentives, swaps into other tokens, and the timing of open bets. It shows once there are seven days of readings. The bankroll check adds pool capital once there are 30 days of them, and until then grades the treasury alone, so the comparison is always like for like.

## Alerts

Five checks run every day: the house bankroll, the house-result trend, the share of the result bought back, the **buyback rate** (last 7 days against the 30 before; a cut or a pause turns it amber or red) and **treasury OVER** (OVER held by the treasury wallets plus the OVER betting pools, over 7 days). OVER moving between the wallets and the pools doesn't count as a change.

When a thesis check gets worse (Healthy → Watch → Alert), the job opens an issue in this repo, and it closes that issue when the check is Healthy again. Checks running on stale data, or not yet comparable, never alert. A treasury OVER alert lists the wallets that moved and by how much. A buyback raise of 20% or more gets its own one-off issue. It also opens an issue for every new Snapshot vote, saying who votes on it. GitHub emails you about new issues in your own repos, so watching the repo is enough.

## Tuning

- Check thresholds: `THRESHOLDS` in `lib/config.js`.
- Betting pools read onchain: `OVER.bettingPools` (USDC) and `OVER.overPools` (OVER) in `lib/config.js`.
- Treasury wallets counted in the supply panel: `OVER.treasury` in `lib/config.js`. If the panel's note shows a big gap between DefiLlama's own-token value and the treasury figure, a wallet is missing.
- Run the job by hand: Actions → Daily snapshot → Run workflow.

## Tests

```sh
npm test
```

Node's built-in test runner, no dependencies. `test/metrics.test.js` covers the checks and the money reconciliation. `test/snapshot.test.js` runs the real snapshot job day by day against a fake world (`test/fake-world.js`) and stages every failure found so far: empty, short or stale replies, a down feed, a bridge mismatch, a failed pool read, an empty proposal list, buyback cuts and raises, OVER leaving the house and alerts closing themselves. Tests run on every push, and the daily job runs them first, so a broken change never publishes data.

## Local preview

Plain HTML, CSS and JavaScript modules; no build step or dependencies.

```sh
python3 -m http.server 8765 --bind 127.0.0.1   # page
node scripts/snapshot.mjs                       # refresh data/ (Node 20+)
```

Open http://127.0.0.1:8765. The home links point at provatidis.com, so they only resolve once deployed.

## Brand

The mark is a stopwatch drawn as the O of OVER, its hand just past twelve. Colors: night ink `#0e1511`, chalk `#f2f3ec`, floodlight lime `#c6f05b` (deep lime `#4f7a16` on light backgrounds). Type: Inter Tight, with Instrument Serif italic for *watch*, both served from `assets/fonts` under the SIL Open Font License. Charts keep a separate blue and orange pair that passes colorblind checks.

## License

Code: [MIT](LICENSE), © 2026 Apostolos Provatidis.

Data in `data/` comes from DefiLlama, CoinGecko, DexScreener, Snapshot and public blockchain reads, and stays under those sources' own terms. Fonts in `assets/fonts` are under the SIL Open Font License (`assets/fonts/LICENSE.txt`).

I hold a small OVER position. Not financial advice.
