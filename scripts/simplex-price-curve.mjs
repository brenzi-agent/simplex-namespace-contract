/**
 * The `.simplex` price curve, in the shape `SimplexPriceOracle` takes it: a base
 * price per year for every length without an exception, plus exceptions
 * `(labelLength, priceCentsPerYear)`, each for that exact length only. $50 a
 * year at six characters and above, so $100 for the two-year minimum; below six,
 * $100 a year at five and ten times more for each character lost.
 *
 * One source of truth for deploy-local, deploy-testnet and deploy-mainnet, so
 * the three cannot drift apart.
 *
 * Mind the unit. These are US cents per YEAR. The vendored
 * `ExponentialPremiumPriceOracle` that `.testing` runs takes attoUSD per SECOND,
 * so the two lists are not interchangeable and neither contract rejects a list
 * in the other's unit.
 */
const USD = 100n

/** Every length without an exception, so six characters and up: $50 / yr. */
export const SIMPLEX_PRICE_BASE = 50n * USD

export const SIMPLEX_PRICE_RUNGS = [
  { labelLength: 1n, priceCentsPerYear: 1000000n * USD }, //    $1,000,000 / yr
  { labelLength: 2n, priceCentsPerYear: 100000n * USD }, //       $100,000 / yr
  { labelLength: 3n, priceCentsPerYear: 10000n * USD }, //         $10,000 / yr
  { labelLength: 4n, priceCentsPerYear: 1000n * USD }, //           $1,000 / yr
  { labelLength: 5n, priceCentsPerYear: 100n * USD }, //              $100 / yr
]

/**
 * Chainlink's ETH/USD feeds report 8 decimals, and `DummyOracle` mimics them.
 * `SimplexPriceOracle` cannot read this from the feed (the interface has no
 * `decimals()`), so it has to be told.
 */
export const USD_FEED_DECIMALS = 8

/** Where the artifact lives, relative to `artifacts/contracts`. */
export const SIMPLEX_PRICE_ORACLE_ARTIFACT =
  'simplex/SimplexPriceOracle.sol/SimplexPriceOracle.json'
