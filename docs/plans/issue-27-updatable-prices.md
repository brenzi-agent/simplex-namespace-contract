# Issue #27: prices updatable by call

`simplex-network/ens-contracts` [#27](https://github.com/simplex-network/ens-contracts/issues/27):
*"For maximum flexibility the price definition should not be per exact name length
but like this: 1. base price per year for all lengths, 2. sparse map
(length -> price) with increasing prices for decreasing lengths."*

Amended by holder-only renewal: only the holder renews, so "permissionless renewal" below
describes the design before it.

## 1. Table of contents

1. Table of contents
2. Executive summary
3. Where prices live today
4. Decisions taken
5. The contract
6. Worked example
7. Implementation steps
8. Test plan
9. Documentation and governance updates
10. Risks and accepted exposure
11. Out of scope, and follow-ups this uncovered

## 2. Executive summary

Prices are currently six `immutable` fields in `StablePriceOracle`
(`price1Letter` .. `price6Letter`), fixed at construction, denominated in attoUSD
*per second*. Changing a price means deploying a whole new oracle and calling
`SimplexController.setPriceOracle`, which is what `scripts/deploy-oracle.mjs`
automates. The rung positions are also hard-wired: exactly six, at lengths 1 to 6.

This plan adds **one new contract**, `contracts/simplex/SimplexPriceOracle.sol`,
implementing `IPriceOracleUSD` and owned via `Ownable2Step`. It holds:

- a **base price per year** in attoUSD, applied to every length not covered by a rung;
- a **sparse list of rungs** `(maxLength, priceUSDPerYear)`, at arbitrary lengths up
  to 64, replaced atomically by `setPrices`. A rung at `K` means "names of at most
  `K` characters cost this". Gaps are the point: every length between two rungs
  inherits the rung above it, so a curve with rungs at 13 and 32 needs no
  enumeration of 1..12;
- the exponential Dutch-auction premium, decay math copied verbatim from
  `ExponentialPremiumPriceOracle`, with `startPremium` and `totalDays` behind a setter;
- the Chainlink feed behind a setter, so no future price or feed change ever needs
  another oracle deployment.

Nothing in the vendored ENS tree changes. `SimplexController` does not change: the
new oracle is activated through the `setPriceOracle` call that already exists and
already survives `freeze()`. The three new setters are all strictly weaker than
`setPriceOracle`, which the admin key already holds, so the governance argument in
`names-v2-launch-to-freeze-plan.md` §5 stands unaltered and only the power table
needs the new function names.

Target is **`.simplex` only**. The live `.testing` deployment keeps oracle
`0x8237865c...` and its inherited premium settings; see §11.

## 3. Where prices live today

| Concern | Location |
|---|---|
| Length to price | `StablePriceOracle.sol:19-28`, six `immutable` slots |
| Lookup | `StablePriceOracle._priceUSD`, `:72-99`, `if/else` chain on `strlen` |
| Unit | attoUSD per second (`basePrice = priceNLetter * duration`) |
| ETH conversion | `attoUSDToWei`, `:119`, feed at `usdOracle` (`immutable`, `:31`) |
| Premium | `ExponentialPremiumPriceOracle._premium`, `:40-56` |
| Activation | `SimplexController.setPriceOracle`, `:376`, `onlyOwner`, survives `freeze()` |
| Consumption | `SimplexController._rentPrice` `:691` (wei) and `_rentPriceUSD` `:484` (attoUSD, for the registrar allowance) |
| Ops workflow | `scripts/deploy-oracle.mjs`, deploy then `setPriceOracle` |

Two facts that shape the design:

- `_priceUSD` is `internal` and **not** `virtual`; `price` and `priceUSD` are
  `external` and not `virtual`. The vendored contract cannot be extended without
  editing it, which the repo's binding minimal-diff rule forbids.
- Nothing outside the contract reads `priceNLetter`. The dApp derives everything
  from `controller.rentPrice` (`ens-app-v3/src/utils/utils.ts:33`), so dropping
  those getters costs nothing.

## 4. Decisions taken

| # | Decision | Rationale |
|---|---|---|
| D1 | New `contracts/simplex/SimplexPriceOracle.sol`, vendored oracles untouched | Matches the binding minimal-diff rule and the existing SNRC pattern (`SimplexResolver`, `MetadataRenderer`, `SubnameRegistrar`). Costs about 110 lines of copied decay math. |
| D2 | Threshold rungs `(maxLength, price)`, monotonicity enforced on set | A length shorter than the shortest rung inherits that rung, so no short name can ever be cheaper than a longer one, without enumerating every length. Rejects a fat-fingered inverted curve. |
| D3 | attoUSD **per year** | The issue's own wording. `1e18` means $1/yr instead of `31688087814`. Multiply before divide, so the loss is sub-attoUSD. |
| D4 | Expanded mapping, O(1) read | `register`/`renew` read the curve on every call. One flat lookup beats a scan whose worst case (a long name falling through to base) is also the common case. Cost moves to the admin call, which is rare. Requires a ceiling on rung length; 64 chosen. |
| D5 | Premium kept, `startPremium`/`totalDays` settable | Retuning the auction without a redeploy. Same risk class as the price curve, strictly weaker than `setPriceOracle`. |
| D6 | `usdOracle` settable | Today its immutability is the stated reason `setPriceOracle` must survive `freeze()` (`names-v2-launch-to-freeze-plan.md` §4). Making it settable grants no power the admin lacks. |
| D7 | `.simplex` only | `.testing` is live and free; swapping its oracle is a separate mainnet change with its own review. |
| D8 | Not upgradeable, no proxy | Like `SubnameRegistrar` and `MetadataRenderer`. `setPriceOracle` remains the escape hatch of last resort. |
| D9 | One combined setter, not one per field | `setPrices(base, rungs)` replaces the whole curve atomically. Separate `setBasePrice` and `setLengthPrices` would have an ordering hazard: raising the base above the lowest rung is only reachable if both move in one transaction. |

## 5. The contract

```solidity
//SPDX-License-Identifier: MIT
pragma solidity ~0.8.26;

import {IPriceOracle} from "../ethregistrar/IPriceOracle.sol";
import {IPriceOracleUSD} from "../ethregistrar/IPriceOracleUSD.sol";
import {AggregatorInterface} from "../ethregistrar/StablePriceOracle.sol";
import {StringUtils} from "../utils/StringUtils.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

contract SimplexPriceOracle is IPriceOracleUSD, Ownable2Step {
    using StringUtils for *;

    /// @notice "Names of at most `maxLength` characters cost `priceUSDPerYear`."
    struct Rung {
        uint256 maxLength;
        uint256 priceUSDPerYear;
    }

    uint256 public constant SECONDS_PER_YEAR = 365 days;
    /// @dev Ceiling on where a rung may sit. Bounds `setPrices` at 64 storage
    ///      writes; every longer name pays the base price, which is the floor.
    uint256 public constant MAX_RUNG_LENGTH = 64;
    /// @dev Must equal `BaseRegistrarImplementation.GRACE_PERIOD`. The auction
    ///      opens exactly when the name becomes registrable.
    uint256 private constant GRACE_PERIOD = 90 days;

    AggregatorInterface public usdOracle;

    /// @dev attoUSD per year for every length above `topRung`.
    uint256 public basePriceUSDPerYear;
    /// @dev The tallest configured rung. 0 means the base price applies to all lengths.
    uint256 public topRung;
    /// @dev The rung list, expanded. Authoritative for lengths 1..topRung.
    mapping(uint256 => uint256) public priceUSDPerYearByLength;

    uint256 public startPremium;
    uint256 public totalDays;
    uint256 public endValue;

    event PricesChanged(uint256 basePriceUSDPerYear, Rung[] rungs);
    event UsdOracleChanged(address indexed usdOracle);
    event PremiumChanged(uint256 startPremium, uint256 totalDays);

    error InvalidPriceFeed(int256 answer);
    error ZeroAddress();
    error RungLengthOutOfRange(uint256 maxLength);
    error RungLengthsNotAscending(uint256 index);
    error RungPricesNotDescending(uint256 index);
    error BasePriceExceedsLowestRung(uint256 basePrice, uint256 lowestRungPrice);
}
```

### Lookup

```solidity
function _priceUSD(string calldata name, uint256 expires, uint256 duration)
    internal view returns (IPriceOracle.Price memory)
{
    uint256 len = name.strlen();
    // The empty label is unregistrable (`valid()` needs strlen >= minCharLength,
    // and minCharLength is never 0), but `rentPrice("")` is a public view the app
    // can reach, and index 0 of the map is never written. Quote it as the shortest.
    if (len == 0) len = 1;

    uint256 perYear = len > topRung
        ? basePriceUSDPerYear
        : priceUSDPerYearByLength[len];

    return IPriceOracle.Price({
        base: (perYear * duration) / SECONDS_PER_YEAR,
        premium: _premium(expires)
    });
}
```

Two cold `SLOAD`s for the length lookup (`topRung`, then one of the two price
slots), about 4.2k gas, independent of how many rungs the curve has. `_premium`
returns before touching storage while the name is inside its grace period, which
is every registration of a name that has not lapsed.

### ETH conversion

Unchanged in substance from `StablePriceOracle`, except that the feed is read once
for the pair rather than once per component:

```solidity
function price(string calldata name, uint256 expires, uint256 duration)
    external view returns (IPriceOracle.Price memory)
{
    IPriceOracle.Price memory usd = _priceUSD(name, expires, duration);
    uint256 ethPrice = _ethPrice();
    return IPriceOracle.Price({
        base: (usd.base * 1e8) / ethPrice,
        premium: (usd.premium * 1e8) / ethPrice
    });
}

function priceUSD(string calldata name, uint256 expires, uint256 duration)
    external view returns (IPriceOracle.Price memory)
{
    return _priceUSD(name, expires, duration);
}

/// @dev Zero would panic the division; a negative answer would wrap the cast and
///      floor every quote to zero, handing out free names. Both fail loudly.
function _ethPrice() internal view returns (uint256) {
    int256 answer = usdOracle.latestAnswer();
    if (answer <= 0) revert InvalidPriceFeed(answer);
    return uint256(answer);
}
```

`priceUSD` never touches the feed, which is what keeps the sponsored path
(`registerWithCredit`, spending a registrar allowance denominated in attoUSD)
running when the feed is dead.

### The setter

```solidity
function setPrices(uint256 newBasePriceUSDPerYear, Rung[] calldata rungs)
    external onlyOwner
{
    _setPrices(newBasePriceUSDPerYear, rungs);
}

function _setPrices(uint256 newBasePriceUSDPerYear, Rung[] memory rungs) internal {
    uint256 previousLength;
    uint256 previousPrice = type(uint256).max;

    for (uint256 i; i < rungs.length; ++i) {
        Rung memory rung = rungs[i];
        if (rung.maxLength == 0 || rung.maxLength > MAX_RUNG_LENGTH)
            revert RungLengthOutOfRange(rung.maxLength);
        if (rung.maxLength <= previousLength) revert RungLengthsNotAscending(i);
        if (rung.priceUSDPerYear > previousPrice) revert RungPricesNotDescending(i);

        for (uint256 len = previousLength + 1; len <= rung.maxLength; ++len) {
            priceUSDPerYearByLength[len] = rung.priceUSDPerYear;
        }
        previousLength = rung.maxLength;
        previousPrice = rung.priceUSDPerYear;
    }

    if (rungs.length != 0 && newBasePriceUSDPerYear > previousPrice)
        revert BasePriceExceedsLowestRung(newBasePriceUSDPerYear, previousPrice);

    basePriceUSDPerYear = newBasePriceUSDPerYear;
    // Entries above the new `topRung` are left as they are. The lookup gates on
    // `topRung`, so they are unreadable, and the next `setPrices` overwrites
    // 1..topRung unconditionally. Clearing them would cost gas and buy nothing.
    topRung = previousLength;

    emit PricesChanged(newBasePriceUSDPerYear, rungs);
}
```

The invariants, stated once: lengths strictly ascend, prices never rise as length
grows, and the base never exceeds the lowest (longest, cheapest) rung. Together
they make the whole curve non-increasing in length by construction, including the
region below the shortest rung and the region above the tallest.

`rungs` is passed `calldata` from the external setter and `memory` from the
constructor; Solidity copies calldata to memory implicitly, so one internal
function serves both.

### The other setters

```solidity
function setUsdOracle(AggregatorInterface newOracle) external onlyOwner {
    if (address(newOracle) == address(0)) revert ZeroAddress();
    int256 answer = newOracle.latestAnswer();
    if (answer <= 0) revert InvalidPriceFeed(answer);  // refuse to install a dead feed
    usdOracle = newOracle;
    emit UsdOracleChanged(address(newOracle));
}

function setPremium(uint256 newStartPremium, uint256 newTotalDays) external onlyOwner {
    startPremium = newStartPremium;
    endValue = newStartPremium >> newTotalDays;
    totalDays = newTotalDays;
    emit PremiumChanged(newStartPremium, newTotalDays);
}
```

`setPremium(x, 0)` sets `endValue == startPremium`, which makes `_premium` return
zero at every elapsed time. That is how the auction is switched off, and it needs
no separate flag.

`supportsInterface` follows `StablePriceOracle.sol:133-140`, true for `IERC165`,
`IPriceOracle` and `IPriceOracleUSD`. `IPriceOracleUSD` does not extend `IERC165`,
so it is declared here rather than inherited.

### The premium

`decayedPremium`, `addFractionalPremium` and the sixteen `bit1..bit16` constants
are copied verbatim from `ExponentialPremiumPriceOracle.sol:21-127`. Only the
entry point differs, reading `startPremium`/`endValue` from storage rather than
from `immutable`s:

```solidity
function _premium(uint256 expires) internal view returns (uint256) {
    uint256 auctionStart = expires + GRACE_PERIOD;
    if (auctionStart > block.timestamp) return 0;
    uint256 decayed = decayedPremium(startPremium, block.timestamp - auctionStart);
    return decayed >= endValue ? decayed - endValue : 0;
}
```

Note the premium is a flat per-name fee: it does not scale with `duration` and does
not depend on length, so it is orthogonal to the length curve. It is charged only
on `register` (`SimplexController.sol:512`); `renew` pays base only, which is
correct because a name can only be renewed while inside grace, where the premium
is zero.

### Constructor and ownership

```solidity
constructor(
    AggregatorInterface _usdOracle,
    uint256 _basePriceUSDPerYear,
    Rung[] memory _rungs,
    uint256 _startPremium,
    uint256 _totalDays
)
```

The constructor runs the same `_setPrices` and the same feed and premium
assignments, so a fresh deployment and a later reconfiguration cannot diverge.
Ownership starts at the deployer (OZ 4.9 `Ownable`), which lets the deploy key
configure the curve, then moves to the admin key with `transferOwnership` plus
`acceptOwnership`. That is one more handover pair than today, and it belongs in
the launch runbook.

### Deliberate omissions

- No standalone `premium(name, expires, duration)` view. `StablePriceOracle` has
  one, it is in neither `IPriceOracle` nor `IPriceOracleUSD`, and nothing reads it.
- No `priceNLetter` compatibility getters. No consumer exists.
- No `RentPriceChanged(uint256[])` event. The vendored one is declared and never
  emitted; `PricesChanged` replaces it with the actual new shape.
- No timelock or delay on `setPrices`. Adding one here while `setPriceOracle` has
  none would be theatre. The delay arrives at governance hardening, on the key.

## 6. Worked example

Base $1/yr, rungs at 13 and 32:

```
setPrices(1e18, [ Rung({maxLength: 13, priceUSDPerYear: 4e18}),
                  Rung({maxLength: 32, priceUSDPerYear: 2e18}) ])
```

storage after the call: `topRung = 32`, lengths 1..13 hold `4e18`,
lengths 14..32 hold `2e18`, `basePriceUSDPerYear = 1e18`.

| Label length | Price per year | Source |
|---|---|---|
| 1 to 13 | $4 | rung 13, inherited downward through the gap |
| 14 to 32 | $2 | rung 32 |
| 33 and up | $1 | base |

The `.simplex` launch curve in the same form, matching `docs/architecture.md`:

```
setPrices(1e18, [ Rung(3, 128e18), Rung(4, 32e18), Rung(5, 8e18) ])
```

A free TLD is `setPrices(0, [])`: `topRung` stays 0, every length falls to a base
of zero.

**The auction.** `setPremium` takes the starting premium in attoUSD and the number
of days it takes to decay to nothing. $1,024 over 10 days:

```
setPremium(1024e18, 10)
```

storage after the call: `startPremium = 1024e18`, `totalDays = 10`,
`endValue = 1024e18 >> 10 = 1e18`.

The premium is charged on top of the rent from the moment the name becomes
registrable (its expiry plus the registrar's 90-day grace period), and halves every
day. `endValue` is subtracted throughout, so the curve lands exactly on zero at
`totalDays` instead of stepping off a cliff:

| Days past grace | Premium |
|---|---|
| 0 | $1,023 |
| 1 | $511 |
| 2 | $255 |
| 5 | $31 |
| 9 | $1 |
| 10 and after | $0 |

ENS's mainnet auction is `setPremium(100000000e18, 21)`: $100,000,000 halving to
nothing over three weeks. `setPremium(x, 0)` makes `endValue` equal `startPremium`,
which zeroes the premium at every elapsed time and is how the auction is switched
off.

## 7. Implementation steps

Branch from `origin/simplex` in the `ens-contracts` submodule. The local `simplex`
branch is 10 commits behind after PR #26 merged on 2026-08-27, so fetch first. PR
targets `simplex`.

**Step 1. The contract.** Add `contracts/simplex/SimplexPriceOracle.sol` as
sketched in §5. Nothing else in `contracts/` changes.
*Done when:* `pnpm hardhat compile` is clean and the deployed bytecode is under the
24 KB limit.

**Step 2. Unit tests.** Add `test/simplex/TestSimplexPriceOracle.test.ts` per §8.
*Done when:* every case in §8 passes, and the premium-parity case matches
`ExponentialPremiumPriceOracle` bit for bit at the sampled offsets.

**Step 3. Migrate the `.simplex` test fixture.** `test/simplex/fixtures/namesV2.ts`
is documented as wiring the stack "as `deploy-simplex.mjs` will wire it", so it
should wire the oracle `.simplex` will actually launch with. Replace the
`StablePriceOracle` deployment with `SimplexPriceOracle`, and replace the
per-second `PRICE_CURVE` array with a per-year `Rung[]`. Keep the
`yearPriceUSD(len, years)` and `YEAR_PRICE_USD` helper signatures: 43 lines across
six test files go through those helpers and so need no source edit. Only two files
reference `PRICE_CURVE` directly, three lines each: `TestPriceOracleUSD.test.ts`
(4, 14, 18) and `TestLaunchLifecycle.test.ts` (14, 118, 891). Eighteen test files
use the fixture in total.

One caveat that must be checked rather than assumed. The helpers' *values* shift
slightly. Today `perYear(10)` truncates to attoUSD per second
(`(10e18)/31536000 = 317097919837`) and `yearPriceUSD` multiplies back up, landing
on `9999999999979632000` rather than `10e18`. The new oracle stores per-year
directly and `(perYear * years * YEAR) / YEAR` is exact, so the same helper now
returns `10e18`. Both sides of every assertion that goes through `yearPriceUSD`
still agree, because both derive from the same constant. Any assertion comparing
against a hard-coded literal, an ETH amount or a balance delta does not, and must
be re-derived.

*Outcome:* none did. All 307 tests in `test/simplex/` passed with no assertion
value changed, so every one of them was already routed through the helpers.

While here, fix the stale comment at `namesV2.ts:68-70`: it claims "$1/yr at 5+
characters, $32 at 4, $128 at 3" and "~0.9993 ETH" for a one-year six-character
name, while `PRICE_CURVE` at `namesV2.ts:22-29` encodes $10 at 6+ with a factor of
ten per character lost, making that name cost about 10 ETH.

The fixture's curve translates directly:
`setPrices(BASE, [Rung(1, BASE*100000), Rung(2, BASE*10000), Rung(3, BASE*1000),
Rung(4, BASE*100), Rung(5, BASE*10)])`, giving `topRung = 5`.
*Done when:* the full `test/simplex/` suite passes, and every assertion that
changed value is traced to the truncation above rather than to a behaviour change.

**Step 4. Leave the ENS suites alone.** `TestStablePriceOracle`,
`TestExponentialPremiumPriceOracle`, `TestEthRegistrarController`,
`TestBulkRenewal`, `TestStaticBulkRenewal` and `test/fixtures/deployEnsFixture.ts`
keep using the vendored oracles. They test vendored code.
*Done when:* `pnpm test` is green across the whole repo.

**Step 5. Documentation.** Per §9.
*Done when:* no doc still describes prices as fixed at construction, and
`docs/ens-diff.md` lists the new contract.

**Step 6 (optional). Cold-owner helper.** `scripts/price-curve.mjs`, taking a
human curve ("base $1, <=5 $8, <=4 $32, <=3 $128") and emitting the `setPrices`
calldata plus the resulting price table for a length sweep, so the admin sees what
they are signing. Same role `deploy-oracle.mjs` plays today. Skip if the deploy
script will cover it.
*Done when:* the emitted calldata decodes to the intended rungs and the printed
table matches an on-chain `rentPrice` sweep against a local deployment.

**Step 7. `.simplex` deploy wiring.** `deploy-simplex.mjs` does not exist yet. When
it is written it substitutes `SimplexPriceOracle` for
`ExponentialPremiumPriceOracle` at step 5 of the per-TLD deployment order, and
adds the `transferOwnership`/`acceptOwnership` pair to the handover. Recorded here
so it is not lost; not part of this PR.

## 8. Test plan

`test/simplex/TestSimplexPriceOracle.test.ts`:

**Band lookup and gaps.** With base $1 and rungs at 13 and 32, assert the price at
lengths 1, 12, 13, 14, 31, 32, 33 and 100 against the table in §6. Assert that a
curve with rungs at 3, 4 and 5 reproduces `$1 / $8 / $32 / $128` exactly.

**Validation.** Reject: a rung at length 0; a rung above `MAX_RUNG_LENGTH`;
lengths not strictly ascending, including a duplicate; a price that rises as
length grows; a base above the lowest rung. Each with its own error selector.

**Free TLD.** `setPrices(0, [])` quotes zero at every length and every duration.

**Duration.** `price(1 year) * 3 == price(3 years)` exactly; a 28-day
`MIN_REGISTRATION_DURATION` quote matches `perYear * 28 days / 365 days`.

**Empty label.** `priceUSD("")` returns the shortest-name price, not zero.

**Unit separation.** Mirror `TestPriceOracleUSD.test.ts`: `priceUSD` is unmoved by
an ETH price change, `price` moves inversely, and the two agree when the feed pins
1 attoUSD to 1 wei.

**Feed.** `setUsdOracle` rejects the zero address and rejects a feed answering
zero or negative. After a valid swap, `price` changes and `priceUSD` does not. A
feed that goes to zero *after* installation makes `price` revert `InvalidPriceFeed`
while `priceUSD` keeps working, which is the property the sponsored path depends on.

**Premium parity.** Deploy `SimplexPriceOracle` and `ExponentialPremiumPriceOracle`
with the same `startPremium`/`totalDays`, and assert equal premiums at elapsed
offsets of 0, 1 hour, 1 day, 1.5 days, 10 days, 20.99 days and 21 days past
`expires + 90 days`, plus zero premium anywhere inside the grace period.

**Premium reconfiguration.** `setPremium` changes the curve as expected;
`setPremium(x, 0)` yields zero premium at every offset.

**Rung shrink.** Set a curve with `topRung = 32`, then one with `topRung = 5`, and
assert that length 20 now pays the base price, proving the uncleared entries above
`topRung` are unreachable.

**Ownership.** Every setter rejects a non-owner. `Ownable2Step` handover requires
acceptance; the pending owner cannot call the setters before accepting.

**Interface.** `supportsInterface` is true for `IERC165`, `IPriceOracle` and
`IPriceOracleUSD`.

**Integration, against the controller.** Swap the oracle in with `setPriceOracle`,
register and renew a name at the new curve, and confirm that `registerWithCredit`
deducts the attoUSD list price from the registrar allowance via `priceUSD`. Then
change the curve with `setPrices` and confirm the next registration pays the new
price with no redeployment.

## 9. Documentation and governance updates

| File | Change |
|---|---|
| `docs/architecture.md:154-165` | Pricing section: describe base plus rungs and the setter. Also correct the claim at `:49` that `StablePriceOracle` is "vendored verbatim"; it already carries the SNRC `price6Letter`, `priceUSD` and `InvalidPriceFeed` additions. |
| `docs/ens-diff.md` | Add `SimplexPriceOracle` to the SNRC contract list, in the same plain-language register as the rest of the file. |
| `docs/deployment.md:167,259` | Per-TLD deployment order step 5 uses `SimplexPriceOracle` for `.simplex`; add the ownership handover. |
| `docs/security.md:60,203,223` | Admin capability list gains `setPrices`, `setUsdOracle`, `setPremium`, all on the oracle's own owner. |
| `docs/plans/names-v2-launch-to-freeze-plan.md` §4 (**deferred**: this file lives on the `ab/launch-to-freeze-plan` branch, not on `main`) | Admin key row gains the three setters. §5's "hostile price oracle" paragraph stays as written: the new setters are strictly weaker than `setPriceOracle`, which is already listed, so the bound (each name's remaining term plus 90 days of grace, with permissionless renewal throughout) is unchanged. §7 recipes gain the oracle's `transferOwnership`/`acceptOwnership` pair. |
| `CLAUDE.md` | "Admin capabilities" and "Deployment order (per TLD)" step 5. |

## 10. Risks and accepted exposure

**A price change between commit and reveal.** A registrant who committed at the old
price and reveals after an increase reverts `InsufficientValue`. `register` refunds
any excess (`SimplexController.sol:516`) and the dApp sends 102% of the quote
(`CURRENCY_FLUCTUATION_BUFFER_PERCENTAGE`, `ens-app-v3/src/utils/constants.ts:18`,
applied at `registerName.ts:42`), so an increase under 2% is absorbed and anything
larger is refused rather than overcharged. The exposure is identical to
`setPriceOracle` today and is not made worse by this change.

**Enforced monotonicity blocks an inverted curve.** A promotional price making a
4-character name cheaper than a 5-character one is rejected. Deliberate, per D2. If
that is ever wanted, the escape is a fresh oracle plus `setPriceOracle`, which is
the same escape that exists today.

**The 64-character ceiling.** No rung can sit above 64. Names longer than the
tallest rung pay the base price, which is the floor, so the effect is confined to
pricing very long names identically. It bounds `setPrices` at 64 storage writes,
about 1.4M gas on a first set and about 320k on a rewrite.

**Length is counted in codepoints, the label cap in bytes.** Pricing uses
`StringUtils.strlen`, which counts UTF-8 codepoints, while
`BaseRegistrarImplementation`'s `maxLabelLength` guard compares `bytes(label).length`
(`BaseRegistrarImplementation.sol:147`). The two units already disagree in the
deployed contracts and this change does not alter that; it is noted because
`MAX_RUNG_LENGTH = 64` is a codepoint count, so a 64-codepoint multi-byte label
still sits inside the rung range while consuming up to 256 bytes. `maxLabelLength`
defaults to 0, meaning no cap at all, so nothing currently constrains either.

**One more key handover.** The oracle has its own `Ownable2Step` owner, separate
from the controller's. A handover that transfers the controller and forgets the
oracle leaves price control on the deploy key, which the launch plan destroys on
5 Nov 2026. The runbook change in §9 is what prevents that, and the verification
step should read `owner()` on the oracle explicitly.

**Copied decay math.** About 110 lines duplicated from
`ExponentialPremiumPriceOracle`. The alternative was making a vendored function
`virtual`, which the minimal-diff rule rules out. The parity test in §8 is what
keeps the copy honest.

## 11. Out of scope, and follow-ups this uncovered

**The live `.testing` premium.** Oracle `0x8237865c6145f4f21cede1c06db0b4b2edc21722`
was constructed with `rentPrices = [0,0,0,0,0]`, `startPremium = 1e26` and
`totalDays = 21`, which are ENS's mainnet defaults. So `.testing` registration is
free, but a *lapsed* `.testing` name costs up to $100,000,000 on the day its 90-day
grace period ends and does not return to free for 21 days. That reads as inherited
defaults rather than a decision. Fixing it needs a replacement oracle plus
`setPriceOracle` either way, since D7 leaves `.testing` on its current oracle. What
this change buys is that the replacement can be a `SimplexPriceOracle`, after which
the same correction is a `setPremium(0, 0)` call. Worth its own issue.

**Three different `.simplex` curves are documented.** The Pricing table in
`docs/architecture.md:154-165` says $1 at 6+, $8 at 5, $32 at 4, $128 at 3. The
comment at `namesV2.ts:68-70` says $1 at 5+, $32 at 4, $128 at 3, dropping the $8
rung, and adds that a one-year six-character name therefore costs about 0.9993 ETH
in the tests. The `PRICE_CURVE` constant it describes (`namesV2.ts:22-29`) encodes
something else again: $10 at 6+ with a factor of ten per character lost, so $100 at
5, $1000 at 4, $10000 at 3, which makes that same name cost about 10 ETH, not
0.9993. Whichever is intended, the launch curve should be settled in one place
before `.simplex` deploys, and this plan does not settle it.

**Frontend.** No change needed. The dApp reads `controller.rentPrice` and derives
the yearly figure itself (`ens-app-v3/src/utils/utils.ts:33`); it never reads the
oracle's storage. The "Pricing display" item still open in `CLAUDE.md` is
independent of this work.
