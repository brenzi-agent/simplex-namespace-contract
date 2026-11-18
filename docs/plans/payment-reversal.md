# Reversible payments — contract work plan

Built on `simplex-namespace-contract` @ `c1cca32` and `ens-contracts` @ `1a11cda` (tag `simplex-mainnet-v1`, deployed), stacked on [ens-contracts #49](https://github.com/simplex-network/ens-contracts/pull/49) (`ab/holder-renewal-terms` @ `7ff8c37`) and its deployment, [#18](https://github.com/brenzi/simplex-namespace-contract/pull/18).

## 1. Contents

1. Contents
2. Problem
3. Decisions
4. Registration states
5. Claims and imports
6. Threat model and risks
7. Contract changes
8. Deployment and rollback
9. Requirements for the store service
10. Effects outside this repository
11. Tests

## 2. Problem

The store service registers a name with `SimplexSponsor.registerWithCredit` once its payment settles. A card payment can still be disputed or refunded afterwards, usually within 120 days of the payment and longer on some card networks; the price and a dispute fee are withdrawn from the store's balance when a dispute opens ([Stripe](https://docs.stripe.com/disputes/how-disputes-work)).

The whole paid term of a registration is kept after its payment is reversed:

- a term is set once, by `registerWithLabel`, and is only extended by `renew` ([`BaseRegistrarImplementation.sol:171`](https://github.com/simplex-network/ens-contracts/blob/1a11cda4be59ae46a13e194d78ffdaac1ca3b0c8/contracts/ethregistrar/BaseRegistrarImplementation.sol#L171), [`:213`](https://github.com/simplex-network/ens-contracts/blob/1a11cda4be59ae46a13e194d78ffdaac1ca3b0c8/contracts/ethregistrar/BaseRegistrarImplementation.sol#L213));
- a held name becomes available 90 days after its expiry ([`:51`](https://github.com/simplex-network/ens-contracts/blob/1a11cda4be59ae46a13e194d78ffdaac1ca3b0c8/contracts/ethregistrar/BaseRegistrarImplementation.sol#L51), [`:134-137`](https://github.com/simplex-network/ens-contracts/blob/1a11cda4be59ae46a13e194d78ffdaac1ca3b0c8/contracts/ethregistrar/BaseRegistrarImplementation.sol#L134-L137));
- a held name is moved only to an address its holder approved ([`:72-80`](https://github.com/simplex-network/ens-contracts/blob/1a11cda4be59ae46a13e194d78ffdaac1ca3b0c8/contracts/ethregistrar/BaseRegistrarImplementation.sol#L72-L80), [`:273-281`](https://github.com/simplex-network/ens-contracts/blob/1a11cda4be59ae46a13e194d78ffdaac1ca3b0c8/contracts/ethregistrar/BaseRegistrarImplementation.sol#L273-L281));
- the registrar is immutable.

Example: a two-year registration paid by card is disputed 30 days later. The price and the dispute fee are withdrawn at once, and the holder keeps the name for two years and 90 days.

## 3. Decisions

`reversibleDays` is the number of days a registration's payment can be reversed, counted from the registration's block; `reversibleUntil` is the end of those days; `E`, 30 days later, is the end of the first term.

| # | Decision | Applied | Status |
|---|---|---|---|
| D0 | Consent to the reversible days | the buyer signs `reversibleDays` in `RegisterName` | pending the owner |
| D1 | Transfers before `reversibleUntil` | allowed; a claim of a reversed registration is refused by the name policy; before `reversibleUntil`, clients list the reversal deadline, `E` and the paid expiry for every claim of an unsettled registration, the import of an owner code included, and ask for the recipient's acknowledgement | the owner, 18 Nov |
| D2 | Cancellation | the first term ends 30 days after `reversibleUntil`; the rest of the paid term is added at settlement; people see the paid expiry | the owner, 18 Nov |
| D3 | What is public on chain | which names were paid by card, through their reversible days, and each reversal | pending the owner |
| D4 | Records of a reversed registration | kept on chain; withheld by the names resolver | pending the owner |
| D5 | Renewals paid by card | not sold: the store renews for crypto, prepaid codes, or a balance past its reversal deadline | pending the owner |
| D6 | Who reverses | the guardian or the admin, before `reversibleUntil` | pending the owner |
| D15 | Reversible days of a card payment | 180 | pending the owner |
| D7 | Who reinstates | the admin; a reinstatement settles at once | decided |
| D8 | Form and bound of the reversible days | a whole number of days, at most 180; 0 registers the whole term | decided |
| D9 | Settlement window | 30 days between `reversibleUntil` and `E`; both stored in each entry | decided |
| D10 | Renewal of an unsettled registration | refused on both paths until settlement | decided |
| D11 | Settlement of a reserved name | allowed, to the paid term | decided |
| D12 | Placement | a new contract, `SimplexSettlement`, behind a UUPS proxy, a registrar controller; its address held once, by the name policy | decided |
| D13 | Who settles | anyone: the store service, a script in this repository, and the dApp's Settle action | decided |
| D14 | Start of card sales | card payments for names enabled by a store setting of their own, after the clients of section 10 that show the paid expiry and ask for the acknowledgement are released | decided |
| D16 | Rollback of the controller | only to an implementation that calls `consumeRenewal`, while any entry is in effect | decided |

## 4. Registration states

```mermaid
stateDiagram-v2
  [*] --> final: register, registerReserved, registerWithCredit with reversibleDays = 0
  [*] --> reversible: registerWithCredit with reversibleDays > 0, expiry = E
  reversible --> reversed: guardian or admin, reversePayments, before reversibleUntil
  reversed --> final: admin, reinstatePayments, up to E + 90 days, expiry = paid expiry
  reversible --> final: anyone, settleRegistration, from reversibleUntil up to E + 90 days, expiry = paid expiry
  reversible --> final: a renewal by another registrar controller the admin adds, entry ignored
  reversible --> lapsed: unsettled after E + 90 days
  reversed --> lapsed: after E + 90 days
  lapsed --> [*]: available to any registration path
```

One entry per reversible registration is stored in `SimplexSettlement`:

```
Entry                          one slot, keyed by token id
  reversibleUntil  uint64      the end of the reversible days
  firstExpiry      uint64      E, the end of the first term
  remaining        uint64      the paid term minus the first term
  reversed         bool        set by a reversal
```

An entry is in effect while all three hold:

- `reversibleUntil != 0`;
- `block.timestamp <= firstExpiry + 90 days`, the registrar's grace period, inclusive as in `available` ([`:136`](https://github.com/simplex-network/ens-contracts/blob/1a11cda4be59ae46a13e194d78ffdaac1ca3b0c8/contracts/ethregistrar/BaseRegistrarImplementation.sol#L136));
- `registrar.nameExpires(id) == firstExpiry`.

The expiry is changed by settlement, by reinstatement, by every later registration, by a renewal from another registrar controller that the admin adds, and by a renewal through a controller implementation that calls no `consumeRenewal` (D16); a stale entry is ignored.

| State | renewal, both paths | claim, on chain | `settleRegistration` | `reversePayments` | `reinstatePayments` |
|---|---|---|---|---|---|
| reversible, before `reversibleUntil` | `RegistrationNotSettled` | allowed; clients ask for an acknowledgement | `ReversiblePeriodNotEnded` | guardian or admin | `PaymentNotReversed` |
| reversible, `reversibleUntil` to `E` | `RegistrationNotSettled` | allowed; clients settle first | anyone | `ReversiblePeriodEnded` | `PaymentNotReversed` |
| reversible, after `E`, up to `E` + 90 days | `RegistrationNotSettled` | refused by `ownerOf` | anyone | `ReversiblePeriodEnded` | `PaymentNotReversed` |
| reversed, up to `E` | `RegistrationNotSettled` | `PaymentReversed` | `PaymentReversed` | `PaymentReversed` | admin |
| reversed, after `E`, up to `E` + 90 days | `RegistrationNotSettled` | refused by `ownerOf` | `PaymentReversed` | `PaymentReversed` | admin |
| lapsed, after `E` + 90 days | refused by the registrar's `renew` | — | `NotReversible` | `NotReversible` | `NotReversible` |
| final | as #49 | as #49 | `NotReversible` | `NotReversible` | `NotReversible` |

```
SimplexController.registerSponsored(registration, reversibleDays)       sponsor only
  ... as #49
  term = registration.duration
  reversibleDays != 0:
    term = namePolicy.settlement().open(id, reversibleDays, registration.duration)
  _registerCore(registration, labelhash, (0, 0), term)

SimplexSettlement.open(id, reversibleDays, duration)                    controller only, proxy only
  reversibleDays <= MAX_REVERSIBLE_DAYS                                 else ReversibleDaysTooMany(reversibleDays)
  term = reversibleDays * 1 days + SETTLEMENT_WINDOW
  duration > term                                                       else DurationTooShort(duration)
  entries[id] = (block.timestamp + reversibleDays * 1 days, block.timestamp + term, duration - term, false)
  emit NamePaymentReversible(labelhash, reversibleUntil, block.timestamp + duration)
  return term

settleRegistration(label)                                               anyone
  entry in effect                                                       else NotReversible(label)
  !reversed                                                             else PaymentReversed(label)
  block.timestamp >= reversibleUntil                                    else ReversiblePeriodNotEnded(label)
  _settle(id, remaining)

reversePayments(labels)                                                 controller.beneficiary() or controller.owner() only
  for each label:
    entry in effect                                                     else NotReversible(label)
    !reversed                                                           else PaymentReversed(label)
    block.timestamp < reversibleUntil                                   else ReversiblePeriodEnded(label)
    reversed = true
    emit NamePaymentReversed(labelhash)

reinstatePayments(labels)                                               controller.owner() only
  for each label:
    entry in effect                                                     else NotReversible(label)
    reversed                                                            else PaymentNotReversed(label)
    _settle(id, remaining)

_settle(id, remaining)
  delete entries[id]
  emit NameRegistrationSettled(labelhash, registrar.renew(id, remaining))

reversibleRegistration(id) view                                         proxy only
  entry in effect: (reversibleUntil, firstExpiry + remaining, reversed)
  else: (0, 0, false)

SimplexNamePolicy.consumeRenewal(label, labelhash, duration, holder)
  settlement.reversibleRegistration(id).reversibleUntil == 0            else RegistrationNotSettled(label)
  ... as #49

SimplexNamePolicy.consumeTransfer(tokenId, from, to, offer, label)
  !settlement.reversibleRegistration(tokenId).reversed                  else PaymentReversed(label)
  ... as #49
```

Example after the change: a two-year registration with 180 reversible days expires on day 210 until it is settled, and is extended to day 730 by settlement from day 180. Disputed on day 30 and reversed, it stays with its holder until day 210, without renewal or onward claim, and, with D4, without records from the names resolver; it is available after day 300. Without D4, the names resolver answers its records through the grace period ([`snrc-resolve.py:1238`](https://github.com/simplex-chat/simplexmq/blob/9c4a814fdab9f7350b5f259bb5afe5145b5bd383/scripts/resolver/service/snrc-resolve.py#L1238)), and SimpleX users see the reversal only after day 300.

```mermaid
sequenceDiagram
  participant P as Names page
  participant S as Store service
  participant G as Guardian
  participant A as Admin
  participant Sp as SimplexSponsor
  participant C as SimplexController
  participant St as SimplexSettlement
  participant R as BaseRegistrar
  S-->>P: reversibleDays from the stored payment
  P->>P: owner signs RegisterName with reversibleDays
  S->>S: reveal refused unless signed over the stored reversibleDays
  S->>Sp: registerWithCredit(registration, reversibleDays, nonce, deadline, sig)
  Sp->>Sp: signature checked, allowance spent for registration.duration
  Sp->>C: registerSponsored(registration, reversibleDays)
  C->>St: open(id, reversibleDays, duration)
  St-->>C: term = reversibleDays + 30 days
  C->>R: registerWithLabel(label, owner, term)
  alt payment kept
    S->>St: settleRegistration(label), from reversibleUntil
    St->>R: renew(id, remaining)
  else dispute opened or refund made before reversibleUntil
    S-->>G: alert with the evidence of every name the payment funded
    G->>St: reversePayments([label, ...])
    Note over R: expiry stays E, available after E + 90 days
    opt dispute won, up to E + 90 days
      A->>St: reinstatePayments([label, ...])
      St->>R: renew(id, remaining)
    end
  end
```

## 5. Claims and imports

```mermaid
sequenceDiagram
  participant H as Holder or owner code
  participant Cl as App or dApp of the recipient
  participant Rs as Names resolver or chain
  participant S as Store service
  participant St as SimplexSettlement
  participant R as BaseRegistrar
  H->>R: offer, approveWithSig
  Cl->>Rs: reversibleRegistration(id): reversibleUntil, paid expiry, reversed
  alt reversed
    Cl-->>Cl: "payment reversed: this name cannot be claimed"
  else before reversibleUntil
    Cl-->>Cl: reversal deadline, E, paid expiry and the loss of the name on a reversal shown
    Cl->>Cl: recipient acknowledges
    Cl->>S: claimWithSig relayed, with the acknowledgement
    S->>R: claimWithSig
  else from reversibleUntil
    Cl->>S: settleRegistration relayed
    S->>St: settleRegistration(label)
    Cl->>S: claimWithSig relayed
    S->>R: claimWithSig
  else no entry
    Cl->>S: claimWithSig relayed, as #49
  end
```

- The data is read from `reversibleRegistration(id)`, directly or through the names resolver's answer.
- The store service relays a claim of an unsettled registration before `reversibleUntil` only with the client's acknowledgement.

## 6. Threat model and risks

| Who or what | Power after the change | Bound |
|---|---|---|
| a buyer who disputes, or a card thief | holds the name until `E` | renewal refused; after the reversal, claims refused and records withheld by the names resolver; available after `E` + 90 days; other on-chain readers show its records until then |
| a card thief's modified names page | signs `RegisterName` with `reversibleDays = 0` | the store refuses a reveal signed over another value than its stored one |
| a third party who claims before the reversal | loses the name at `E` | the recipient acknowledges the reversal deadline before the claim (D1) |
| the guardian | reverses any unsettled reversible registration before `reversibleUntil` | one hardware wallet until GOV8; kept after `freeze()`; a reinstatement settles the registration, which then cannot be reversed; while the guardian and the admin are one key, the split separates nothing; the store alerts on a reversal the operators did not request |
| the admin | reverses; reinstates; upgrades `SimplexSettlement` until `freeze()`; adds a registrar controller, whose renewal ends an entry; removes `SimplexSettlement` as a registrar controller, also after `freeze()`, after which every unsettled registration lapses after `E` + 90 days | as every admin power, behind the timelock from GOV8; a reinstatement lands up to `E` + 90 days, after the 7-day delay |
| `SimplexSettlement` | a registrar controller: registers and renews in its code's bounds | the same trust as the name policy, which is a registrar controller behind a UUPS proxy too |
| a fault in `SimplexSettlement.reversibleRegistration` | all holder transfers and renewals of all names revert, as the name policy calls it on both | repaired by an upgrade until `freeze()`; after it, transfers by `registrar.setNamePolicy(0)`, without the terms check, and renewals by an added registrar controller |
| the registrar key | registers with reversible days only when the buyer signed them (D0) | a registration to its own address is unsigned, as today |
| the store service | settles each reversible registration | unsettled after `E` + 90 days, an honest buyer's name lapses; anyone can settle (D13) |
| an observer of the chain | learns which names were paid by card, and each reversal (D3) | crypto and code orders are registered with 0 days; the registration's time is public as today |
| a holder whose dispute is won | the names resolver withholds the name's records from the reversal to the reinstatement, 2 to 3 months | the store tells the holder; with D4 only |
| a dispute still open at `E` + 90 days | the name becomes available | the guardian reserves it privately before `E` + 90 days; on a won dispute the admin assigns it with `registerReserved`, for at least 730 days, or the store refunds; on a lost one the admin releases it with `removeReservedNames` |
| a dispute won before `E` + 90 days of a name the guardian reserved | the reinstated name cannot be renewed while reserved | the admin's reinstatement goes with `removeReservedNames` |
| a rollback of the controller to an implementation without `consumeRenewal`, such as v1 `0x0b1120b6…89eddb` | a renewal changes the expiry and ends the entry: a reversed holder escapes, an honest buyer loses the rest of the paid term | D16: excluded while any entry is in effect |
| the freeze | `SimplexSettlement`'s upgrades end at `freeze()` only because its implementation checks `controller.frozen()`; as a registrar controller, an implementation without that check keeps a power to mint and renew any name | the freeze recipe reads the settlement's implementation slot, as it reads the policy's |
| a payment withdrawn again after a reinstatement | the registration stays final | the store's loss |
| a reversal after `reversibleUntil` | outside the contracts | the store's loss; 180 days after the registration exceed Stripe's usual 120 days after the payment, also from `term_start` (2027-01-01) for registrations from 2 Nov 2026; a later `term_start` shortens that margin |
| the snapshot-and-redeploy fallback | re-mints an unsettled name as final | the store's reversal window for it ends |

## 7. Contract changes

```mermaid
flowchart LR
  page["Names page"] -->|"RegisterName with reversibleDays"| service["Store service"]
  service -->|"registerWithCredit(..., reversibleDays, ...)"| sponsor["SimplexSponsor<br/>new deployment"]
  sponsor -->|"registerSponsored(registration, reversibleDays)"| controller["SimplexController<br/>upgrade"]
  controller -->|"settlement()"| policy["SimplexNamePolicy<br/>upgrade"]
  controller -->|"open(id, reversibleDays, duration)"| settlement["SimplexSettlement<br/>new, UUPS proxy"]
  controller -->|"registerWithLabel(term)"| registrar["BaseRegistrar<br/>unchanged"]
  guardian["Guardian or admin"] -->|"reversePayments"| settlement
  admin["Admin"] -->|"reinstatePayments"| settlement
  anyone["Anyone"] -->|"settleRegistration"| settlement
  settlement -->|"renew(id, remaining)"| registrar
  registrar -->|"consumeTransfer"| policy
  controller -->|"consumeRenewal"| policy
  policy -->|"reversibleRegistration(id)"| settlement
```

`SimplexSettlement`, new, behind `SimplexSettlementProxy`, an ERC-1967 proxy as `SimplexNamePolicyProxy`:

- immutables:
  - `controller`;
  - `registrar`.
- constants:
  - `MAX_REVERSIBLE_DAYS = 180`;
  - `SETTLEMENT_WINDOW = 30 days`;
  - the registrar's grace period, 90 days.
- storage:
  - `mapping(uint256 => Entry) private _entries`;
  - `uint256[49] __gap`.
- functions:
  - `open(uint256, uint256, uint256)`;
  - `settleRegistration(string)`;
  - `reversePayments(string[])`;
  - `reinstatePayments(string[])`;
  - `reversibleRegistration(uint256)`.
- `open` and `reversibleRegistration` revert `NotProxy` on the implementation, as the name policy's functions do.
- `_authorizeUpgrade`: the controller's owner; refused once the controller is frozen, and for an implementation built for another controller or registrar.
- events:
  - `NamePaymentReversible(bytes32 indexed labelhash, uint256 reversibleUntil, uint256 paidExpires)`;
  - `NamePaymentReversed(bytes32 indexed labelhash)`;
  - `NameRegistrationSettled(bytes32 indexed labelhash, uint256 expires)`.
- errors:
  - `ReversibleDaysTooMany(uint256)`;
  - `DurationTooShort(uint256)`, the controller's selector;
  - `NotController()`;
  - `NotProxy()`;
  - `NotOwner()`;
  - `NotBeneficiary()`;
  - `Frozen()`;
  - `ImplementationMismatch()`;
  - `NotReversible(string)`;
  - `ReversiblePeriodNotEnded(string)`;
  - `ReversiblePeriodEnded(string)`;
  - `PaymentReversed(string)`;
  - `PaymentNotReversed(string)`.

`SimplexNamePolicy`, upgraded in place, storage unchanged:

- the implementation's immutable `settlement`, bound for every later implementation;
- `_authorizeUpgrade` also refuses an implementation built for another `settlement`, and so refuses the #49 implementation: the policy is fixed forward only;
- the checks in `consumeRenewal` and `consumeTransfer`;
- errors:
  - `PaymentReversed(string)`;
  - `RegistrationNotSettled(string)`.

`INamePolicy`:

- `settlement()`;
- `ISettlement`, with `open` and `reversibleRegistration`.

`SimplexController`, upgraded in place, storage unchanged:

- `registerSponsored(registration, reversibleDays)`;
- `_registerCore` takes the first term, which `register` passes as `registration.duration`.

`SimplexSponsor`, a new deployment:

- `registerWithCredit(registration, reversibleDays, nonce, deadline, sig)`;
- the type `RegisterName(string label,address owner,uint256 duration,address resolver,bytes[] data,uint256 reversibleDays,uint256 nonce,uint256 deadline)`;
- `reversibleDays` passed to `registerSponsored`;
- the allowance spent for `registration.duration`, as now.

`BaseRegistrarImplementation`, `ENSRegistry`, `SimplexResolver` and `SubnameRegistrar` are unchanged.

`ens-contracts/docs/upgrades.md`:

- `SimplexSettlement`'s layout and its `ImplementationMismatch` binding;
- the policy's binding to `settlement`;
- the invariant `MAX_REVERSIBLE_DAYS days + SETTLEMENT_WINDOW < MIN_REGISTRATION`.

Sizes of a prototype on #49, by solc 0.8.26, optimizer runs 1,000,000, EVM `paris`, against the limit of 24,576 bytes:

| Contract | #49 | Prototype | Headroom |
|---|---|---|---|
| `SimplexController` | 21,889 | 22,295 | 2,281 |
| `SimplexNamePolicy` | 22,652 | 23,466 | 1,110 |
| `SimplexSponsor` | 5,840 | 5,856 | 18,720 |
| `SimplexSettlement` | — | 9,078 | 15,498 |

## 8. Deployment and rollback

By the recipe of [#18](https://github.com/brenzi/simplex-namespace-contract/pull/18), in one run with it when both are merged before it. Card payments for names are enabled by a store setting of their own, apart from `[names] codes_only`, only after step 8 and the client releases of section 10 that show the paid expiry and ask for the acknowledgement.

| # | Caller | Call |
|---|---|---|
| 1 | any funded key | deploy `SimplexSettlement(controllerProxy, registrar)`, `SimplexSettlementProxy`, the `SimplexController` implementation, the `SimplexNamePolicy` implementation with the settlement proxy, and `SimplexSponsor(controllerProxy)`; in a run with #18, also the #49 controller implementation, for a rollback (D16); verify each on Etherscan |
| 2 | registrar owner | `registrar.addController(settlementProxy)` |
| 3 | controller owner | `namePolicy.upgradeTo(policyImpl)` |
| 4 | guardian key | `newSponsor.setRegistrarAllowance(registrarKey, N)`, for the store service's hot wallet |
| 5 | operators | the store service registers every order already signed for the old sponsor, and takes no new reveal |
| 6 | controller owner | `namePolicy.setGeneralTerms(link)` and `namePolicy.setCommunityTerms(link)`, when the terms text states the condition |
| 7 | controller owner | `controller.upgradeToAndCall(controllerImpl, setSponsor(newSponsor))`, in one transaction: the new controller has no one-argument `registerSponsored` for the old sponsor |
| 8 | operators | the store service and the names page, with the new sponsor address and `RegisterName` type; the remaining orders are signed once |

```mermaid
flowchart TD
  s1["1. five contracts deployed and verified"] --> s2["2. addController(settlement)"]
  s2 --> s3["3. policy upgrade"]
  s3 --> s4["4. allowance on the new sponsor"]
  s4 --> s5["5. orders of the old sponsor registered, new reveals paused"]
  s5 --> s6["6. terms links, when changed"]
  s6 --> s7["7. controller upgrade and setSponsor, one transaction"]
  s7 --> s8["8. store service and names page; remaining orders signed once"]
  s8 --> s9["9. dApp and resolver releases of section 10"]
  s9 --> s10["10. card payments for names enabled"]
```

The order holds with #18 in the same run or before it. The #49 controller calls `consumeRenewal` on the policy; `SimplexSettlement` is the new policy's one new callee; the new controller calls the policy's `settlement()`.

The upgrade is rehearsed by the script on a fork of mainnet first: the settings read back unchanged, then a sponsored registration with reversible days, a refused renewal, a reversal with a refused claim, a reinstatement and a settlement. Verified on mainnet:

- `controller.sponsor()` is the new sponsor, whose `controller()` is the proxy;
- `namePolicy.settlement()` is the settlement proxy, whose `controller()` is the controller proxy;
- the settlement proxy's ERC-1967 implementation slot holds the verified `SimplexSettlement`;
- `registrar.controllers(settlementProxy)` is true;
- `MAX_REVERSIBLE_DAYS()` is 180 and `SETTLEMENT_WINDOW()` 2,592,000.

Rollback, while entries exist:

```mermaid
flowchart TD
  r1["1. card payments for names stopped"] --> r2["2. a sponsor of the #49 interface deployed"]
  r2 --> r3["3. controller: upgradeToAndCall(#49 implementation, setSponsor(that sponsor)); never v1 while an entry is in effect (D16)"]
  r3 --> r4["4. the new policy and SimplexSettlement kept: entries settle, renewals and claims stay checked"]
  r4 --> r5["5. removeController(settlement), once every entry is settled or lapsed"]
```

With every entry settled or lapsed, `reversibleRegistration` returns zeros, and the new policy behaves as the #49 policy. The policy is fixed forward only.

The freeze recipe, launch-to-freeze A7: the settlement proxy's implementation slot is read as the policy's, and a simulated `settlement.upgradeTo` reverts `Frozen`.

The snapshot-and-redeploy fallback of the launch-to-freeze plan, §7: a reversed name is reserved and not re-minted, as a disputed name past its expiry; an unsettled name is re-minted for its paid term.

## 9. Requirements for the store service

```mermaid
sequenceDiagram
  participant V as Stripe
  participant S as Store service
  participant O as Operators
  participant G as Guardian
  participant A as Admin
  participant St as SimplexSettlement
  S->>St: settleRegistration(label), from reversibleUntil
  S-->>O: alert, unsettled 7 days after reversibleUntil
  V->>S: early fraud warning
  S-->>O: alert: refund decision
  V->>S: dispute opened, or refund made
  S-->>O: alert with the evidence of every name the payment funded, urgent within 14 days of reversibleUntil
  O-->>G: reversal requested
  G->>St: reversePayments([label, ...]), before reversibleUntil
  St-->>S: NamePaymentReversed
  S-->>O: alert on a reversal not requested
  V->>S: funds reinstated
  S-->>O: alert with the evidence
  O-->>A: reinstatement requested
  A->>St: reinstatePayments([label, ...]), up to E + 90 days
```

- Store each payment's reversal deadline with it, and supply each sponsored registration's `reversibleDays` for the owner's signature:
  - a card payment: 180 (D15);
  - an in-app payment, when added for names: 180;
  - a balance: the whole days, rounded up, from the signing to the deadline of the money it holds;
  - an order paid from a balance and a card together: the larger of the two;
  - crypto and prepaid codes: 0.
- Enable card payments for names by a setting of their own, after the client releases of section 10.
- Build the `RegisterName` digest and the calldata from the stored `reversibleDays`, and refuse a reveal signed over any other value.
- Show at checkout that a card payment is final 180 days after the registration, and on the order page the exact date.
- Show the paid expiry and the date the registration becomes final, in place of the expiry on chain.
- Sell renewals for crypto, prepaid codes, or a balance past its reversal deadline (D5); refuse a renewal of a registration before its `reversibleUntil`; after it, settle the registration before asking the holder for the renewal acceptance, which #49 binds to the current expiry.
- Relay a claim of an unsettled registration before its `reversibleUntil` only with the client's acknowledgement; from `reversibleUntil`, settle before the claim.
- Send `settleRegistration(label)` for each reversible registration from `reversibleUntil`, and alert the operators when one is unsettled 7 days after it.
- Read Stripe's `radar.early_fraud_warning.created` as a refund decision for the operators, and `charge.dispute.created`, `charge.refunded`, `charge.dispute.funds_reinstated` and `charge.dispute.closed` as reversal and reinstatement requests; each alert lists the evidence of every name the payment funded, directly or through balances.
- Alert the operators on a `NamePaymentReversed` they did not request.
- Alert the operators 14 days before `E` + 90 days of a reversed registration whose dispute is still open, for the guardian's reservation; a reinstatement of a reserved name goes with `removeReservedNames`.
- Relay no record edit, offer or claim of a reversed registration, and show it as reversed in search.
- Classify the new reverts:
  - `ReversibleDaysTooMany`, `DurationTooShort`: code errors;
  - `RegistrationNotSettled`: settle, then retry;
  - `ReversiblePeriodNotEnded`: wait for `reversibleUntil`;
  - `NotReversible` on settlement: settled already, or lapsed;
  - `PaymentReversed` on a relayed claim: permanent.

## 10. Effects outside this repository

- simplex-chat, branch `names`:
  - the store service's `RegisterName` digest and calldata ([`Names/Registration.hs:119-141`](https://github.com/simplex-chat/simplex-chat/blob/0410929c9d1659312fa41ee69127796454379eef/apps/simplex-store-service/src/StoreService/Names/Registration.hs#L119-L141));
  - its reveal check, which takes the duration from the stored order ([`Names/Reveal.hs:109`](https://github.com/simplex-chat/simplex-chat/blob/0410929c9d1659312fa41ee69127796454379eef/apps/simplex-store-service/src/StoreService/Names/Reveal.hs#L109)) and takes `reversibleDays` the same way;
  - its Stripe events ([`Providers/Stripe.hs:104`](https://github.com/simplex-chat/simplex-chat/blob/0410929c9d1659312fa41ee69127796454379eef/apps/simplex-store-service/src/StoreService/Providers/Stripe.hs#L104));
  - a settlement task;
  - a test in which the page signs `reversibleDays = 0` for a card order;
  - `docs/protocol/names-overview.md`: the non-custodial objective ([`:189`](https://github.com/simplex-chat/simplex-chat/blob/0410929c9d1659312fa41ee69127796454379eef/docs/protocol/names-overview.md#L189)) is amended by the reversible days, and, with D4, the objective against infrastructure censorship ([`:190`](https://github.com/simplex-chat/simplex-chat/blob/0410929c9d1659312fa41ee69127796454379eef/docs/protocol/names-overview.md#L190)) by the withheld records.
- simplex-chat app: the claim and import flow of section 5; the import of an owner code is an offer and a claim ([plan, §3](https://github.com/simplex-chat/simplex-chat/blob/0410929c9d1659312fa41ee69127796454379eef/plans/2026-10-12-names-sponsored-registration.md#L44)).
- simplex.domains:
  - `RegisterName` with `reversibleDays` ([`crypto/registration.ts:61`](https://github.com/simplex-chat/simplex.domains/blob/c33ba147c58702d54c99cf27415502f50727daee/webapp/src/crypto/registration.ts#L61));
  - checkout: a card payment is final 180 days after the registration; the order page: the exact date;
  - "Registered until" with the paid expiry and the final date ([`views/order.ts:1270-1272`](https://github.com/simplex-chat/simplex.domains/blob/c33ba147c58702d54c99cf27415502f50727daee/webapp/src/views/order.ts#L1270-L1272));
  - the terms text.
- simplexmq:
  - the resolver answers the paid expiry and `reversibleUntil` of an unsettled registration ([`snrc-resolve.py:1180-1260`](https://github.com/simplex-chat/simplexmq/blob/9c4a814fdab9f7350b5f259bb5afe5145b5bd383/scripts/resolver/service/snrc-resolve.py#L1180-L1260));
  - with D4, a reversed registration and its subnames are answered without records, in `registration()` and `resolve()`;
  - the SMP protocol's `NameRegistration` gains those fields under a new protocol version.
- simplex-domains-app-v3:
  - the paid expiry and the final date;
  - a Settle action, also before a renewal, so that the renewal acceptance names the paid expiry;
  - Extend of an unsettled registration reverts `RegistrationNotSettled`;
  - the claim flow of section 5.
- This repository:
  - `scripts/settle-due.mjs`: settles every due entry from the `NamePaymentReversible` events, with the labels from `registrar.labelOf`, with any funded key;
  - `scripts/deploy-mainnet.mjs`, `scripts/deploy-local.mjs` and `scripts/build-verification.mjs`, which build `SimplexNamePolicy(controller, registrar)` today: the settlement implementation and proxy before the policy, `addController(settlement)`, the settlement passed to the policy, the read-back and the Etherscan entries; the snapshot-and-redeploy fallback runs `deploy-mainnet.mjs`;
  - `docs/plans/names-v2-launch-to-freeze-plan.md`: §4, §5, §7, and the tables A1, A6 and A7;
  - `docs/security.md`: the new privileged surface, the risks of section 6, the invariant "before its registration expires, `E` for an unsettled reversible registration, while `SimplexSettlement` is a registrar controller", and line 329, as a reserved name is settled to its paid term;
  - `docs/deployment.md:3-5` and `docs/architecture.md:170-171`: `SimplexSettlement` among the contracts behind a proxy;
  - `docs/deployment.md:495-497`: the new `registerWithCredit`;
  - `CLAUDE.md:52, 91, 104, 110-111, 116, 144-145`: the proxies, the settlement of a reserved name, the freeze and its upgrade authority, the admin capabilities and `registerWithCredit`;
  - the deployment script of #18, and its rollback recipe, which names the v1 implementation (D16).
- ens-contracts: the test fixture `test/simplex/fixtures/namesV2.ts:183`.

## 11. Tests

`ens-contracts/test/simplex/TestReversiblePayment.test.ts`:

- registration:
  - reversible days expire the name 30 days after `reversibleUntil`, on the bare and the resolver path; `NameRegistered.expires` is `E`, and `NamePaymentReversible.paidExpires` the registration's time plus its duration;
  - a registration with reversible days over a stale reversed entry starts unreversed;
  - 0 days register the whole term, and `open` is not called;
  - 180 days register; 181 revert `ReversibleDaysTooMany`;
  - a duration not above the first term reverts `DurationTooShort`;
  - `open` reverts `NotController` for every caller but the controller, and `NotProxy` on the implementation;
  - the allowance spent is the paid term's price;
  - `RegisterName` with other `reversibleDays` reverts `InvalidSignature`; the type hash is pinned;
  - a community name with reversible days.
- settlement:
  - reverts before `reversibleUntil`, and is allowed at `block.timestamp == reversibleUntil`, from any address;
  - extends the expiry to the paid term's end from `reversibleUntil` to `E` + 90 days inclusive;
  - reverts `NotReversible` one second after `E` + 90 days, and a second time;
  - settles a reserved name;
  - during the grace period, restores the subnames' owner.
- renewal on both paths reverts `RegistrationNotSettled` before settlement and works after it; a renewal acceptance signed before settlement reverts `TermsNotAccepted` after it.
- reversal:
  - refuses a claim and settlement; the name lapses at `E` and is available one second after `E` + 90 days;
  - reverts at `block.timestamp == reversibleUntil`;
  - succeeds for the guardian and the admin; reverts for the registrar, the holder and anyone else;
  - reverts for a final registration;
  - reverses several names in one call, and reverts the call for one name out of effect.
- reinstatement:
  - extends the term at once and ends the entry, so a second reversal reverts `NotReversible`;
  - is allowed at `E` + 90 days and reverts one second later;
  - reverts for the guardian and anyone but the admin.
- transfers:
  - `transferFrom`, both `safeTransferFrom` overloads and `claimWithSig` revert `PaymentReversed` after a reversal;
  - `approve` and `approveWithSig` still work;
  - an offer and a claim before the reversal succeed, and the reversal then applies to the new holder;
  - a claim between `reversibleUntil` and `E` succeeds, and a reversal then reverts `ReversiblePeriodEnded`;
  - subnames keep their owner between `reversibleUntil` and `E`.
- stale and lapsed entries:
  - a re-registration of a lapsed name, through `registerWithCredit` and through `registerReserved`, leaves the entry without effect;
  - so does a renewal by an added registrar controller;
  - `reversibleRegistration` returns the entry at `E` + 90 days and zeros one second later.
- upgrades:
  - `SimplexSettlement` is upgraded only by the controller's owner, and refuses an upgrade once the controller is frozen or to an implementation for another controller or registrar; an upgrade keeps the entries;
  - the implementation's `reversibleRegistration` reverts `NotProxy`;
  - the name policy refuses an implementation built for another `settlement`;
  - the deployment order and the rollback, with transfers and renewals across each step;
  - a renewal through the v1 controller implementation ends an entry, which pins D16;
  - the name policy refuses an upgrade to the #49 implementation;
  - an upgrade of proxies populated by the #49 implementations keeps every value;
  - the invariant `MAX_REVERSIBLE_DAYS days + SETTLEMENT_WINDOW < MIN_REGISTRATION`.
- each new guard, removed, fails at least one test.
