# OVER watch

A small live tracker for [Overtime](https://www.overtime.io/) ($OVER): treasury stablecoins, the house result, buybacks and buyback yield, with three threshold checks.

[provatidis.com/overwatch](https://provatidis.com/overwatch/)

The page loads its figures in the browser from the DefiLlama and CoinGecko public APIs each time it opens. There's no backend and nothing to update.

The check thresholds sit at the top of the script in `index.html`.

## Local preview

Plain HTML, CSS, and JavaScript; no build step or dependencies.

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

Open http://127.0.0.1:8765. The favicon and home links point at the main site, so they only resolve once deployed.

Not financial advice.
