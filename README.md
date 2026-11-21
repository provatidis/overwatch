# OVER watch

A live tracker for [Overtime](https://www.overtime.io/) ($OVER): treasury stablecoins, the house result, buybacks and buyback yield, supply and free float, DEX liquidity and governance votes, with five thesis checks summed up under the headline.

[overwatch.day](https://overwatch.day/)

## How it works

A GitHub Action (`.github/workflows/snapshot.yml`) runs `scripts/snapshot.mjs` once a day at 04:17 UTC, and whenever the script or `lib/` changes. It collects:

- **House result, buybacks and treasury** from DefiLlama's public API.
- **Betting money** straight from the sportsbook's USDC and OVER pools on Optimism, Arbitrum and Base: every round's pool (current, later and the default pool that takes futures and parlays spanning rounds) plus the house's share of open bets (what each bet holds minus the bettor's stake). Every listed bet is read, in batches through Multicall3. The bankroll, the money reconciliation and the house's OVER all use this figure; history rows from before 21 Nov 2026 counted only the current round's pool and are left out of comparisons.
- **Who controls the pools.** The betting pools are upgradeable (EIP-1967) proxies. Their code and the owner of their upgrade key are read daily.
- **Supply** straight from the OVER contracts on Ethereum, Optimism, Arbitrum and Base through public RPCs, with the top holders from Blockscout to find the Chainlink bridge pool on Ethereum. Blockscout's public explorers now block scripts on some chains (Arbitrum and Base), so the job also takes an optional `BLOCKSCOUT_API_KEY` repo secret (free at dev.blockscout.com) and then uses Blockscout's keyed API first, sending the key in a header and keeping it out of logs. **Overtime's admin multisigs** (the wallets holding each chain's betting-pool upgrade key, found onchain daily) count as the house's OVER alongside the treasury wallets and betting pools: DefiLlama doesn't count them as treasury, but Overtime controls them, so they aren't free float here. The holders table combines each ordinary wallet's OVER across all four chains (read directly from each chain, so Base counts even without Base's holder list), and labels Overtime's admin multisig (read onchain as the owner of the pools' upgrade key), DEX pools and Safe multisigs, and says which chains it covers.
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

Five checks run every day: the house bankroll, the house-result trend, **buyback cover** (the 90-day house result divided by buybacks: Healthy from 1.5×, Alert below 1×, with 30 and 7 days and the weekly record since the method change shown for context, since a sportsbook's week is noisy), the **buyback rate** (last 7 days against the 30 before; a cut or a pause turns it amber or red) and **house OVER** (OVER held by the treasury wallets, Overtime's admin multisigs and the OVER betting pools, over 7 days). OVER moving between the wallets and the pools doesn't count as a change. A line under the headline sums up all five, worst first, and each check opens with one line on why it matters, for readers new to the case.

When a thesis check gets worse (Healthy → Watch → Alert), the job opens an issue in this repo, and it closes that issue when the check is Healthy again. Checks running on stale data, or not yet comparable, never alert. A treasury OVER alert lists the wallets that moved and by how much. A buyback raise of 20% or more gets its own one-off issue. A change to a betting pool's code, or to who holds its upgrade key, opens one issue listing every change that day. It also opens an issue for every new Snapshot vote, saying who votes on it. GitHub emails you about new issues in your own repos, so watching the repo is enough.

## Tuning

- Check thresholds: `THRESHOLDS` in `lib/config.js`.
- Betting pools read onchain: `OVER.bettingPools` (USDC) and `OVER.overPools` (OVER) in `lib/config.js`.
- Treasury wallets counted in the supply panel: `OVER.treasury` in `lib/config.js`. If the panel's note shows a big gap between DefiLlama's own-token value and the treasury figure, a wallet is missing.
- Run the job by hand: Actions → Daily snapshot → Run workflow.

## Tests

```sh
npm test
```

Node's built-in test runner, no dependencies. `test/metrics.test.js` covers the checks, buyback cover's history and the money reconciliation. `test/snapshot.test.js` runs the real snapshot job day by day against a fake world (`test/fake-world.js`) and stages every failure found so far: empty, short or stale replies, a down feed, a bridge mismatch, a failed pool read, an empty proposal list, buyback cuts and raises, OVER leaving the house and alerts closing themselves. Tests run on every push, and the daily job runs them first, so a broken change never publishes data.

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
