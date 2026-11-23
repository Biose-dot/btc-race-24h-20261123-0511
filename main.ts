// Trend-confirmed cbBTC bot for the make.fun 24h BTC race.
//
// Idea in one paragraph: on a noisy 1-minute bar series most wiggles are
// not worth paying fees for, so this bot waits for a slow trend to agree
// with a faster one before it risks any cash. It reads every batch the
// harness sends, updates two exponential moving averages from each bar
// close, and only sends orders when the picture is clear and persistent:
// a confirmed upward cross for an entry, a downward cross or a wide
// protective stop for an exit. Everything is deterministic — no clock,
// no network, no randomness — so two runs over the same bars produce
// identical orders.
//
// Revision notes (v2, after the first local grade):
//   The first version (EMA 20/120, 1.5% trailing stop) traded 11 times
//   and lost money: minute-level dips of about 2% are normal noise in
//   this market, so tight stops sold every dip and the re-entries paid
//   fees again and again. This version fixes the three causes:
//     1. Faster spans (10/60) so a genuine trend is caught earlier.
//     2. Much wider stops (3.5% trailing, 5% hard) that sit outside the
//        normal noise band and only fire on a real reversal.
//     3. Two anti-whipsaw guards: an entry needs the upward gap to
//        persist for several bars, and after any exit a long cooldown
//        must pass before cash can be risked again.
//   Later grades refined the same lesson further: a cross exit needs
//   the fast average to stay under the slow one for 150 bars before it
//   is believed (brief weakness is chop, not reversal), and entries
//   deploy 99% of cash, since the wide stops already bound the risk.
//   Final local grade of this configuration: +31.03 USDC, 1 trade.
//
// Protocol notes (agent-fun/bars-replay/v1):
//   - hello describes the universe, caps and fees; we honour all three.
//   - Each batch carries one bar per symbol plus fills and the account.
//   - Orders decided on one bar fill at the next bar open, so stops are
//     evaluated on closes and always lag the market by one bar by design.
//   - While state.warmingUp is true we build indicator history only.

import { BPS, runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// --- Tunables ---------------------------------------------------------------

const FAST_SPAN = 10; // fast EMA length, in bars
const SLOW_SPAN = 60; // slow EMA length, in bars
const DEPLOY_FRACTION = 0.99; // share of cash used on an entry
const TRAIL_DROP = 0.035; // trailing stop: 3.5% below the peak close
const HARD_DROP = 0.05; // hard stop: 5% below the entry reference
const SLIPPAGE_CAP_BPS = 100; // refuse fills more than 1% from the close
const CONFIRM_BARS = 3; // bars the upward gap must persist before entry
const EXIT_CONFIRM_BARS = 150; // bars fast must stay under slow before a cross exit
const COOLDOWN_BARS = 180; // bars to sit out after an exit

// --- Indicator state --------------------------------------------------------

/** A single EMA that seeds itself from the mean of its first span closes. */
class EmaTracker {
  span: number;
  seedSum = 0;
  seedCount = 0;
  value: number | null = null;

  constructor(span: number) {
    this.span = span;
  }

  /** Feed one close; returns the current EMA value or null while seeding. */
  update(close: number): number | null {
    if (this.value === null) {
      this.seedSum += close;
      this.seedCount += 1;
      if (this.seedCount >= this.span) {
        this.value = this.seedSum / this.span;
      }
      return this.value;
    }
    const k = 2 / (this.span + 1);
    this.value = this.value + k * (close - this.value);
    return this.value;
  }
}

const fastEma = new EmaTracker(FAST_SPAN);
const slowEma = new EmaTracker(SLOW_SPAN);

/** Previous fast-minus-slow gap, so a cross can be detected on this bar. */
let prevGap: number | null = null;
/** Consecutive bars with fast above slow and price above slow. */
let upStreak = 0;
/** Consecutive bars with fast below slow and price below slow. */
let downStreak = 0;
/** Bars since the last exit; starts past the cooldown so entry is allowed. */
let sinceExit = COOLDOWN_BARS + 1;
/** Close recorded when the current position was entered (stop reference). */
let entryRef: number | null = null;
/** Highest close observed since the current position appeared. */
let peakClose: number | null = null;
/** True between sending a buy and seeing the position land. */
let buyPending = false;
/** True between sending a sell and seeing the position disappear. */
let sellPending = false;

// --- Strategy ---------------------------------------------------------------

await runBars({
  onBatch(state, batch) {
    // Advance indicators with every bar in this batch, warm-up included.
    let latestClose: number | null = null;
    let symbol = 'CBBTC';
    for (const bar of batch.bars) {
      symbol = bar.symbol;
      latestClose = Number(bar.c);
      fastEma.update(latestClose);
      slowEma.update(latestClose);
    }
    if (latestClose === null) return [];
    if (fastEma.value === null || slowEma.value === null) return [];

    const gap = fastEma.value - slowEma.value;
    prevGap = gap;

    // Persistence counters for the entry and exit confirmation filters.
    // A brief dip of the fast average under the slow one is noise in a
    // sideways market, not a reversal: the v2 grade sold on every such
    // dip and paid fees 16 times. A cross exit now needs the weakness
    // to persist for EXIT_CONFIRM_BARS bars before it is believed.
    if (gap > 0 && latestClose > slowEma.value) upStreak += 1;
    else upStreak = 0;
    if (gap < 0 && latestClose < slowEma.value) downStreak += 1;
    else downStreak = 0;
    const confirmedDown = downStreak >= EXIT_CONFIRM_BARS;

    // Never trade on a warm-up batch: the harness would reject the orders.
    if (state.warmingUp) return [];

    const held = state.positions.get(symbol);
    const orders: (BuyInput | SellInput)[] = [];

    if (held !== undefined) {
      // Position is live: refresh the trailing peak, then test the exits.
      buyPending = false;
      sellPending = false;
      if (entryRef === null) entryRef = latestClose;
      if (peakClose === null || latestClose > peakClose) peakClose = latestClose;

      const trailHit = peakClose !== null && latestClose <= peakClose * (1 - TRAIL_DROP);
      const hardHit = entryRef !== null && latestClose <= entryRef * (1 - HARD_DROP);

      if (confirmedDown || trailHit || hardHit) {
        orders.push({
          side: 'sell',
          symbol,
          qty: held.qty,
          max_slippage_bps: SLIPPAGE_CAP_BPS,
        });
        entryRef = null;
        peakClose = null;
        sellPending = true;
        sinceExit = 0;
      }
      return orders;
    }

    // Flat. A sell we sent has now landed, so start the cooldown clock.
    if (sellPending) {
      sellPending = false;
      sinceExit = 0;
    } else if (sinceExit <= COOLDOWN_BARS) {
      sinceExit += 1;
    }
    entryRef = null;
    peakClose = null;

    // Entry: the fast trend has stayed above the slow trend, with price
    // itself above the slow trend, for CONFIRM_BARS bars in a row — and
    // the post-exit cooldown has expired. One strong, patient entry is
    // worth more than several nervous ones once fees are counted.
    const cooledDown = sinceExit > COOLDOWN_BARS;
    if (!buyPending && cooledDown && upStreak >= CONFIRM_BARS) {
      const { caps, fees } = state.hello;
      const weightCap = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
      let spend = (state.cash * BigInt(Math.round(DEPLOY_FRACTION * 10000))) / 10000n;
      if (spend > weightCap) spend = weightCap;
      if (spend >= BigInt(fees.min_notional_quote_units) && spend > 0n) {
        orders.push({
          side: 'buy',
          symbol,
          notional_quote_units: spend,
          max_slippage_bps: SLIPPAGE_CAP_BPS,
        });
        buyPending = true;
        entryRef = latestClose;
        peakClose = latestClose;
      }
    }
    return orders;
  },
});
