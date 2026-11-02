/**
 * The `.simplex` price curve, in the shape `SimplexPriceOracle` takes it: a base
 * price per year for every length without an exception, plus exceptions
 * `(labelLength, priceCentsPerYear)`, each for that exact length only. $50 a
 * year, so $100 for the two-year minimum, with no exceptions: names shorter than
 * six characters cannot be registered.
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

/** Every length: $50 / yr. */
export const SIMPLEX_PRICE_BASE = 50n * USD

export const SIMPLEX_PRICE_RUNGS = []

/**
 * Chainlink's ETH/USD feeds report 8 decimals, and `DummyOracle` mimics them.
 * `SimplexPriceOracle` cannot read this from the feed (the interface has no
 * `decimals()`), so it has to be told.
 */
export const USD_FEED_DECIMALS = 8

/** Where the artifact lives, relative to `artifacts/contracts`. */
export const SIMPLEX_PRICE_ORACLE_ARTIFACT =
  'simplex/SimplexPriceOracle.sol/SimplexPriceOracle.json'
