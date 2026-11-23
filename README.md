# cbBTC Trend Bot — make.fun 24h BTC Race

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/Biose-dot/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/Biose-dot/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

Bounty: [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261123-0511) on make.fun.

## Strategy

A patient trend-follower for Coinbase Wrapped BTC (CBBTC) on 1-minute bars, long only, starting from $1,000 of paper USDC.

- **Indicators:** EMA(10) and EMA(60), each seeded from the mean of its first span of closes, updated on every bar (warm-up bars included, though no orders are sent while warming up).
- **Entry (flat only):** the fast EMA must stay above the slow EMA with the close itself above the slow EMA for 3 consecutive bars — a persistent, price-confirmed uptrend, not a one-bar cross. The bot then deploys ~99% of available cash, capped by `caps.max_weight_bps` and floored by `fees.min_notional_quote_units` from the hello message.
- **Exits (holding):** sell the entire position when weakness is *confirmed* — the fast EMA stays below the slow EMA with price below it for 150 bars — or on protective stops that sit outside normal minute-level noise: a trailing stop 3.5% below the highest close since entry, or a hard stop 5% below the entry reference.
- **Anti-whipsaw:** after any exit, a 180-bar cooldown must pass before a new entry. On the dev window this discipline turned a fee-bleeding crossover bot into a single-trade entry: **+$31.03 net PnL, 1 trade, ~1.96% max drawdown** in local grading.
- **Orders:** every order caps slippage at 100 bps. The bot is fully deterministic — no clock, no network, no randomness — so repeated runs over the same bars produce identical orders.

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit SDK shim for the `agent-fun/bars-replay/v1` protocol.

## License

MIT — see `LICENSE`.
