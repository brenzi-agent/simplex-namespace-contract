# Reversible payments — contract work plan

Built on `simplex-namespace-contract` @ `c1cca32` and `ens-contracts` @ `1a11cda` (tag `simplex-mainnet-v1`, deployed), stacked on [ens-contracts #49](https://github.com/simplex-network/ens-contracts/pull/49) (`ab/holder-renewal-terms` @ `7ff8c37`) and its deployment, [#18](https://github.com/brenzi/simplex-namespace-contract/pull/18).

## 1. Contents

1. Contents
2. Problem
3. Decisions
4. Registration states
5. Threat model and risks
6. Contract changes
7. Deployment and rollback
8. Requirements for the store service
9. Effects outside this repository
10. Tests

## 2. Problem

The store service registers a name with `SimplexSponsor.registerWithCredit` once its payment settles. A card payment can still be disputed or refunded afterwards, usually within 120 days of the payment and longer on some card networks; the price and a dispute fee are withdrawn from the store's balance when a dispute opens ([Stripe](https://docs.stripe.com/disputes/how-disputes-work)).

A registration keeps its whole paid term after its payment is reversed:

- a term is set once, by `registerWithLabel`, and is only extended by `renew` ([`BaseRegistrarImplementation.sol:171`](https://github.com/simplex-network/ens-contracts/blob/1a11cda4be59ae46a13e194d78ffdaac1ca3b0c8/contracts/ethregistrar/BaseRegistrarImplementation.sol#L171), [`:213`](https://github.com/simplex-network/ens-contracts/blob/1a11cda4be59ae46a13e194d78ffdaac1ca3b0c8/contracts/ethregistrar/BaseRegistrarImplementation.sol#L213));
- a held name becomes available 90 days after its expiry ([`:51`](https://github.com/simplex-network/ens-contracts/blob/1a11cda4be59ae46a13e194d78ffdaac1ca3b0c8/contracts/ethregistrar/BaseRegistrarImplementation.sol#L51), [`:134-137`](https://github.com/simplex-network/ens-contracts/blob/1a11cda4be59ae46a13e194d78ffdaac1ca3b0c8/contracts/ethregistrar/BaseRegistrarImplementation.sol#L134-L137));
- a held name is moved only to an address its holder approved ([`:72-80`](https://github.com/simplex-network/ens-contracts/blob/1a11cda4be59ae46a13e194d78ffdaac1ca3b0c8/contracts/ethregistrar/BaseRegistrarImplementation.sol#L72-L80), [`:273-281`](https://github.com/simplex-network/ens-contracts/blob/1a11cda4be59ae46a13e194d78ffdaac1ca3b0c8/contracts/ethregistrar/BaseRegistrarImplementation.sol#L273-L281));
- the registrar is immutable.

Example: a two-year registration paid by card is disputed 30 days later. The price and the dispute fee are withdrawn at once, and the holder keeps the name for two years and 90 days.

## 3. Decisions

`reversibleUntil` is the reversal deadline of a registration's payment; `E` is the end of its first term.

| # | Decision | Applied | Status |
|---|---|---|---|
| D0 | Consent to the reversal deadline | the buyer signs `reversibleUntil` in `RegisterName` | pending the owner |
| D1 | Transfers before the reversal deadline | allowed; a claim of a reversed registration is refused; a claim of an unsettled one by another person needs the recipient's acknowledgement in the app and the dApp | the owner, 18 Nov |
| D2 | Cancellation | the first term ends 30 days after the reversal deadline; the rest of the paid term is added at settlement; people see the paid expiry | the owner, 18 Nov |
| D3 | What is public on chain | the reversal deadline of each card payment, to the second, and each reversal | pending the owner |
| D4 | Records of a reversed registration | kept on chain; withheld by the names resolver | pending the owner |
| D5 | Renewals paid by card | not sold: the store renews for crypto, prepaid codes, or a balance past its reversal deadline | pending the owner |
| D6 | Who reverses and who reinstates | the guardian (`beneficiary`) reverses, before the reversal deadline; the admin (`owner`) reinstates, which settles at once | decided |
| D7 | Form and bound of the reversal deadline | a signed timestamp, at most 180 days after the registration; one already passed registers the whole term | decided |
| D8 | Settlement window | 30 days between the reversal deadline and `E`; `E` stored in each entry | decided |
| D9 | Renewal of an unsettled registration | refused on both paths until settlement | decided |
| D10 | Settlement of a reserved name | allowed, to the paid term | decided |
| D11 | Placement | a new contract, `SimplexSettlement`, behind a UUPS proxy, a registrar controller; its address held once, by the name policy | decided |
| D12 | Who settles | anyone: the store service, a script in this repository, and the dApp's Settle action | decided |

## 4. Registration states

```mermaid
stateDiagram-v2
  [*] --> final: register, registerReserved, registerWithCredit with reversibleUntil not after the block
  [*] --> reversible: registerWithCredit with reversibleUntil after the block, expiry = E
  reversible --> reversed: guardian, reversePayment(label), before reversibleUntil
  reversed --> final: admin, reinstatePayment(label), before E + 90 days, expiry = paid expiry
  reversible --> final: anyone, settleRegistration(label), from reversibleUntil to E + 90 days, expiry = paid expiry
  reversible --> lapsed: unsettled at E + 90 days
  reversed --> lapsed: at E + 90 days
  lapsed --> [*]: available to any registration path
```

One entry per reversible registration is stored in `SimplexSettlement`:

```
Entry                          one slot, keyed by token id
  reversibleUntil  uint64      the reversal deadline
  firstExpiry      uint64      E, the end of the first term
  remaining        uint64      the paid term minus the first term
  reversed         bool        set by the guardian
```

An entry is in effect while all three hold:

- `reversibleUntil != 0`;
- `registrar.nameExpires(id) == firstExpiry`;
- `!registrar.available(id)`, so before `E + 90 days`.

The expiry is changed by settlement, by reinstatement, by every later registration, and by a renewal from another registrar controller that the admin adds; a stale entry is ignored.

| State | renewal, both paths | claim | `settleRegistration` | `reversePayment` | `reinstatePayment` |
|---|---|---|---|---|---|
| reversible, before `reversibleUntil` | `RegistrationNotSettled` | with the recipient's acknowledgement | `ReversiblePeriodNotEnded` | guardian | `PaymentNotReversed` |
| reversible, `reversibleUntil` to `E` | `RegistrationNotSettled` | with the recipient's acknowledgement | anyone | `ReversiblePeriodEnded` | `PaymentNotReversed` |
| reversible, `E` to `E` + 90 days | `RegistrationNotSettled` | refused by `ownerOf` | anyone | `ReversiblePeriodEnded` | `PaymentNotReversed` |
| reversed, before `E` | `RegistrationNotSettled` | `PaymentReversed` | `PaymentReversed` | `PaymentReversed` | admin |
| reversed, `E` to `E` + 90 days | `RegistrationNotSettled` | refused by `ownerOf` | `PaymentReversed` | `PaymentReversed` | admin |
| lapsed, from `E` + 90 days | as #49 for a new registration | — | `NotReversible` | `NotReversible` | `NotReversible` |
| final | as #49 | as #49 | `NotReversible` | `NotReversible` | `NotReversible` |

```
SimplexController.registerSponsored(registration, reversibleUntil)      sponsor only
  ... as #49
  term = namePolicy.settlement().open(id, reversibleUntil, registration.duration)
  _registerCore(registration, labelhash, (0, 0), term)

SimplexSettlement.open(id, reversibleUntil, duration)                   controller only
  reversibleUntil <= block.timestamp: return duration
  reversibleUntil <= block.timestamp + MAX_REVERSIBLE_PERIOD            else ReversibleUntilTooLate(reversibleUntil)
  term = reversibleUntil + SETTLEMENT_WINDOW - block.timestamp
  entries[id] = (reversibleUntil, block.timestamp + term, duration - term, false)
  emit NamePaymentReversible(labelhash, reversibleUntil, block.timestamp + duration)
  return term

settleRegistration(label)                                               anyone
  entry in effect                                                       else NotReversible(label)
  !reversed                                                             else PaymentReversed(label)
  block.timestamp >= reversibleUntil                                    else ReversiblePeriodNotEnded(label)
  _settle(id, remaining)

reversePayment(label)                                                   controller.beneficiary() only
  entry in effect                                                       else NotReversible(label)
  !reversed                                                             else PaymentReversed(label)
  block.timestamp < reversibleUntil                                     else ReversiblePeriodEnded(label)
  reversed = true
  emit NamePaymentReversed(labelhash)

reinstatePayment(label)                                                 controller.owner() only
  entry in effect                                                       else NotReversible(label)
  reversed                                                              else PaymentNotReversed(label)
  _settle(id, remaining)

_settle(id, remaining)
  delete entries[id]
  emit NameRegistrationSettled(labelhash, registrar.renew(id, remaining))

reversibleRegistration(id) view
  entry in effect: (reversibleUntil, firstExpiry + remaining, reversed)
  else: (0, 0, false)

SimplexNamePolicy.consumeRenewal(label, labelhash, duration, holder)
  settlement.reversibleRegistration(id).reversibleUntil == 0            else RegistrationNotSettled(label)
  ... as #49

SimplexNamePolicy.consumeTransfer(tokenId, from, to, offer, label)
  !settlement.reversibleRegistration(tokenId).reversed                  else PaymentReversed(label)
  ... as #49
```

Example after the change: a two-year registration with its reversal deadline on day 180 expires on day 210 until it is settled, and is extended to day 730 by settlement from day 180. Disputed on day 30 and reversed, it stays with its holder until day 210, without renewal, onward claim or records from the names resolver; it is available on day 300.

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
  S-->>P: reversibleUntil = payment time + 180 days
  P->>P: owner signs RegisterName with reversibleUntil
  S->>Sp: registerWithCredit(registration, reversibleUntil, nonce, deadline, sig)
  Sp->>Sp: signature checked, allowance spent for registration.duration
  Sp->>C: registerSponsored(registration, reversibleUntil)
  C->>St: open(id, reversibleUntil, duration)
  St-->>C: term = reversibleUntil + 30 days - now
  C->>R: registerWithLabel(label, owner, term)
  alt payment kept
    S->>St: settleRegistration(label), from reversibleUntil
    St->>R: renew(id, remaining)
  else payment disputed or refunded before reversibleUntil
    S-->>G: alert with the order's evidence
    G->>St: reversePayment(label)
    Note over R: expiry stays E, available at E + 90 days
    opt dispute won before E + 90 days
      A->>St: reinstatePayment(label)
      St->>R: renew(id, remaining)
    end
  end
```

## 5. Threat model and risks

| Who or what | Power after the change | Bound |
|---|---|---|
| a buyer who disputes, or a card thief | holds the name until `E` | no renewal; after the reversal, no claim and no records from the names resolver; available at `E` + 90 days; other on-chain readers show its records until then |
| a third party who claims before the reversal | loses the name at `E` | the recipient acknowledges the reversal deadline before the claim (D1) |
| the guardian | reverses any unsettled reversible registration before its reversal deadline | one hardware wallet until GOV8; kept after `freeze()`; a reinstatement settles the registration, which then cannot be reversed; while the guardian and the admin are one key, the split separates nothing |
| the admin | reinstates; upgrades `SimplexSettlement` until `freeze()`; adds a registrar controller, whose renewal ends an entry; removes `SimplexSettlement` as a registrar controller, also after `freeze()`, after which every unsettled registration lapses at `E` + 90 days | as every admin power, behind the timelock from GOV8 |
| `SimplexSettlement` | a registrar controller: registers and renews in its code's bounds | the same trust as the name policy, which is a registrar controller behind a UUPS proxy too |
| a fault in `SimplexSettlement.reversibleRegistration` | every holder transfer and every renewal of every name reverts, as both call it through the name policy | repaired by an upgrade until `freeze()`; after it, only by a new name policy, which starts without the reserved and community lists |
| the registrar key | registers with a reversal deadline only when the buyer signed it (D0) | a registration to its own address is unsigned, as today |
| the store service | settles each reversible registration | unsettled at `E` + 90 days, an honest buyer's name lapses; anyone can settle (D12) |
| an observer of the chain | learns which names were paid by card, the time of each payment, and each reversal (D3) | crypto and code orders are registered without a reversal deadline |
| a dispute still open at `E` + 90 days | the name becomes available | the guardian reserves it privately before `E` + 90 days; on a won dispute the admin assigns it with `registerReserved`, for at least 730 days, or the store refunds |
| a payment withdrawn again after a reinstatement | the registration stays final | the store's loss |
| a reversal after the reversal deadline | outside the contracts | the store's loss; the deadline, 180 days after the payment, exceeds Stripe's usual 120 days, also from `term_start` (2027-01-01) for payments made from 2 Nov 2026 |

## 6. Contract changes

```mermaid
flowchart LR
  page["Names page"] -->|"RegisterName with reversibleUntil"| service["Store service"]
  service -->|"registerWithCredit(..., reversibleUntil, ...)"| sponsor["SimplexSponsor<br/>new deployment"]
  sponsor -->|"registerSponsored(registration, reversibleUntil)"| controller["SimplexController<br/>upgrade"]
  controller -->|"settlement()"| policy["SimplexNamePolicy<br/>upgrade"]
  controller -->|"open(id, reversibleUntil, duration)"| settlement["SimplexSettlement<br/>new, UUPS proxy"]
  controller -->|"registerWithLabel(term)"| registrar["BaseRegistrar<br/>unchanged"]
  guardian["Guardian"] -->|"reversePayment"| settlement
  admin["Admin"] -->|"reinstatePayment"| settlement
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
  - `MAX_REVERSIBLE_PERIOD = 180 days`;
  - `SETTLEMENT_WINDOW = 30 days`.
- storage:
  - `mapping(uint256 => Entry) private _entries`;
  - `uint256[49] __gap`.
- functions:
  - `open(uint256, uint256, uint256)`;
  - `settleRegistration(string)`;
  - `reversePayment(string)`;
  - `reinstatePayment(string)`;
  - `reversibleRegistration(uint256)`.
- `_authorizeUpgrade`: the controller's owner; refused once the controller is frozen, and for an implementation built for another controller or registrar.
- events:
  - `NamePaymentReversible(bytes32 indexed labelhash, uint256 reversibleUntil, uint256 paidExpires)`;
  - `NamePaymentReversed(bytes32 indexed labelhash)`;
  - `NameRegistrationSettled(bytes32 indexed labelhash, uint256 expires)`.
- errors:
  - `ReversibleUntilTooLate(uint256)`;
  - `NotReversible(string)`;
  - `ReversiblePeriodNotEnded(string)`;
  - `ReversiblePeriodEnded(string)`;
  - `PaymentReversed(string)`;
  - `PaymentNotReversed(string)`.

`SimplexNamePolicy`, upgraded in place, storage unchanged:

- the implementation's immutable `settlement`;
- `_authorizeUpgrade` also refuses an implementation built for another `settlement`;
- the checks in `consumeRenewal` and `consumeTransfer`;
- errors:
  - `PaymentReversed(string)`;
  - `RegistrationNotSettled(string)`.

`INamePolicy`:

- `settlement()`;
- `ISettlement`, with `open` and `reversibleRegistration`.

`SimplexController`, upgraded in place, storage unchanged:

- `registerSponsored(registration, reversibleUntil)`;
- `_registerCore` takes the first term, which `register` passes as `registration.duration`.

`SimplexSponsor`, a new deployment:

- `registerWithCredit(registration, reversibleUntil, nonce, deadline, sig)`;
- the type `RegisterName(string label,address owner,uint256 duration,address resolver,bytes[] data,uint256 reversibleUntil,uint256 nonce,uint256 deadline)`;
- `reversibleUntil` passed to `registerSponsored`;
- the allowance spent for `registration.duration`, as now.

`BaseRegistrarImplementation`, `ENSRegistry`, `SimplexResolver` and `SubnameRegistrar` are unchanged.

`ens-contracts/docs/upgrades.md`:

- `SimplexSettlement`'s layout;
- the invariant `MAX_REVERSIBLE_PERIOD + SETTLEMENT_WINDOW < MIN_REGISTRATION`.

Sizes of a prototype on #49, by solc 0.8.26, optimizer runs 1,000,000, EVM `paris`, against the limit of 24,576 bytes; the prototype is committed with the implementation:

| Contract | #49 | Prototype | Headroom |
|---|---|---|---|
| `SimplexController` | 21,889 | 22,278 | 2,298 |
| `SimplexNamePolicy` | 22,652 | 23,466 | 1,110 |
| `SimplexSponsor` | 5,840 | 5,856 | 18,720 |
| `SimplexSettlement` | — | 8,289 | 16,287 |

## 7. Deployment and rollback

By the recipe of [#18](https://github.com/brenzi/simplex-namespace-contract/pull/18), before the store accepts its first card order for a name (`[names] codes_only = off`):

| # | Caller | Call |
|---|---|---|
| 1 | any funded key | deploy `SimplexSettlement(controllerProxy, registrar)` and `SimplexSettlementProxy` |
| 2 | any funded key | deploy the `SimplexController` implementation, the `SimplexNamePolicy` implementation with the settlement proxy, and `SimplexSponsor(controllerProxy)`; verify the six on Etherscan |
| 3 | registrar owner | `registrar.addController(settlementProxy)` |
| 4 | controller owner | `namePolicy.upgradeTo(policyImpl)` |
| 5 | operators | the store service registers or re-signs every order signed for the old sponsor |
| 6 | controller owner | `controller.upgradeToAndCall(controllerImpl, setSponsor(newSponsor))`, in one transaction: the new controller reverts every call of the old sponsor |
| 7 | guardian key | `newSponsor.setRegistrarAllowance(registrar, N)` |
| 8 | controller owner | `namePolicy.setGeneralTerms(link)` and `namePolicy.setCommunityTerms(link)`, when the terms text states the condition; acceptances of the old links are made again |
| 9 | operators | the store service and the names page, with the new sponsor address and `RegisterName` type |

```mermaid
flowchart TD
  s1["1. SimplexSettlement and its proxy"] --> s2["2. implementations and sponsor, verified"]
  s2 --> s3["3. addController(settlement)"]
  s3 --> s4["4. policy upgrade"]
  s4 --> s5["5. orders of the old sponsor registered or re-signed"]
  s5 --> s6["6. controller upgrade and setSponsor, one transaction"]
  s6 --> s7["7. allowance on the new sponsor"]
  s7 --> s8["8. terms links, when changed"]
  s8 --> s9["9. store service and names page"]
```

The order holds with #18 in the same run or before it. The #49 controller calls `consumeRenewal` on the policy; the new policy calls only `SimplexSettlement`; the new controller calls the policy's `settlement()`.

The upgrade is rehearsed by the script on a fork of mainnet first: the settings read back unchanged, then a sponsored registration with a reversal deadline, a refused renewal, a reversal with a refused claim, a reinstatement and a settlement. Verified on mainnet:

- `controller.sponsor()` is the new sponsor, whose `controller()` is the proxy;
- `namePolicy.settlement()` is the settlement proxy, whose `controller()` is the controller proxy;
- `registrar.controllers(settlementProxy)` is true;
- `MAX_REVERSIBLE_PERIOD()` is 15,552,000 and `SETTLEMENT_WINDOW()` 2,592,000.

Rollback, while entries exist:

```mermaid
flowchart TD
  r1["1. the store supplies reversibleUntil = 0"] --> r2["2. a sponsor of the #49 interface deployed"]
  r2 --> r3["3. controller: upgradeToAndCall(#49 implementation, setSponsor(that sponsor))"]
  r3 --> r4["4. the new policy and SimplexSettlement kept: entries settle, renewals and claims stay checked"]
  r4 --> r5["5. policy back to the #49 implementation, and removeController(settlement), once every entry is settled or lapsed"]
```

The snapshot-and-redeploy fallback of the launch-to-freeze plan, §7: a reversed name is reserved and not re-minted, as a disputed name past its expiry; an unsettled name is re-minted for its paid term.

## 8. Requirements for the store service

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
  V->>S: dispute, refund or early fraud warning
  S-->>O: alert with the evidence, urgent within 14 days of reversibleUntil
  O-->>G: reversal requested
  G->>St: reversePayment(label), before reversibleUntil
  V->>S: funds reinstated
  S-->>O: alert with the evidence
  O-->>A: reinstatement requested
  A->>St: reinstatePayment(label), before E + 90 days
```

- Supply each sponsored registration's `reversibleUntil` for the owner's signature, exact to the second:
  - a card payment: its time plus 180 days;
  - an in-app payment, when added for names: its time plus 180 days;
  - a balance: the `reversibleUntil` of the money it holds;
  - crypto and prepaid codes: 0.
- Sell renewals for crypto, prepaid codes, or a balance past its `reversibleUntil` (D5).
- Send `settleRegistration(label)` for each reversible registration from `reversibleUntil`, and alert the operators when one is unsettled 7 days after it.
- Show the paid expiry and the date the registration becomes final, in place of the expiry on chain.
- Read Stripe's `charge.dispute.created`, `charge.dispute.funds_reinstated`, `charge.dispute.closed`, `charge.refunded` and `radar.early_fraud_warning.created` for registered orders, and alert the operators with the order's payment, signed order and registration transaction.
- Alert the operators 14 days before `E` + 90 days of a reversed registration whose dispute is still open, for the guardian's reservation.
- Relay no record edit, offer or claim of a reversed registration, and show it as reversed in search.
- Classify `ReversibleUntilTooLate` as a code error.

## 9. Effects outside this repository

- simplex-chat, branch `names`:
  - the store service's `RegisterName` digest and calldata ([`Names/Registration.hs:119-141`](https://github.com/simplex-chat/simplex-chat/blob/0410929c9d1659312fa41ee69127796454379eef/apps/simplex-store-service/src/StoreService/Names/Registration.hs#L119-L141));
  - its Stripe events ([`Providers/Stripe.hs:104`](https://github.com/simplex-chat/simplex-chat/blob/0410929c9d1659312fa41ee69127796454379eef/apps/simplex-store-service/src/StoreService/Providers/Stripe.hs#L104));
  - a settlement task;
  - `docs/protocol/names-overview.md`: the non-custodial objective ([`:189`](https://github.com/simplex-chat/simplex-chat/blob/0410929c9d1659312fa41ee69127796454379eef/docs/protocol/names-overview.md#L189)) is amended by the reversal deadline, and, with D4, the objective against infrastructure censorship ([`:190`](https://github.com/simplex-chat/simplex-chat/blob/0410929c9d1659312fa41ee69127796454379eef/docs/protocol/names-overview.md#L190)) by the withheld records.
- simplex-chat app:
  - the import of an owner code is an offer and a claim ([plan, §3](https://github.com/simplex-chat/simplex-chat/blob/0410929c9d1659312fa41ee69127796454379eef/plans/2026-10-12-names-sponsored-registration.md#L44));
  - before a claim of an unsettled registration from another person, the recipient acknowledges its reversal deadline; the import of the app user's own owner code asks for no acknowledgement.
- simplex.domains:
  - `RegisterName` with `reversibleUntil` ([`crypto/registration.ts:61`](https://github.com/simplex-chat/simplex.domains/blob/c33ba147c58702d54c99cf27415502f50727daee/webapp/src/crypto/registration.ts#L61)), shown to the buyer before signing;
  - "Registered until" with the paid expiry and the final date ([`views/order.ts:1270-1272`](https://github.com/simplex-chat/simplex.domains/blob/c33ba147c58702d54c99cf27415502f50727daee/webapp/src/views/order.ts#L1270-L1272));
  - the terms text.
- simplexmq:
  - the resolver answers the paid expiry and the reversal deadline of an unsettled registration ([`snrc-resolve.py:1180-1260`](https://github.com/simplex-chat/simplexmq/blob/9c4a814fdab9f7350b5f259bb5afe5145b5bd383/scripts/resolver/service/snrc-resolve.py#L1180-L1260));
  - with D4, a reversed registration and its subnames are answered without records, in `registration()` and `resolve()`;
  - the SMP protocol's `NameRegistration` gains those fields under a new protocol version.
- simplex-domains-app-v3:
  - the paid expiry and the final date;
  - a Settle action;
  - Extend of an unsettled registration reverts `RegistrationNotSettled`;
  - the claim review lists the reversal deadline and asks for an acknowledgement.
- This repository:
  - `scripts/settle-due.mjs`: settles every due entry from the `NamePaymentReversible` events, with any funded key;
  - `docs/plans/names-v2-launch-to-freeze-plan.md` §4, §5 and §7;
  - `docs/security.md`: the new privileged surface, the risks of §5, and the invariant "before its registration expires, `E` for an unsettled reversible registration, while `SimplexSettlement` is a registrar controller";
  - `CLAUDE.md`: admin capabilities;
  - the deployment script of #18.

## 10. Tests

`ens-contracts/test/simplex/TestReversiblePayment.test.ts`:

- registration:
  - a reversal deadline expires the name 30 days after it, on the bare and the resolver path, and emits `NamePaymentReversible` with the paid expiry;
  - a reversal deadline not after the block registers the whole term;
  - `reversibleUntil == block.timestamp + MAX_REVERSIBLE_PERIOD` registers; one second later reverts `ReversibleUntilTooLate`;
  - the store's formula, payment time plus 180 days, with the registration minutes and a day after the payment;
  - the allowance spent is the paid term's price;
  - `RegisterName` with another `reversibleUntil` reverts `InvalidSignature`; the type hash is pinned;
  - a community name with a reversal deadline.
- settlement:
  - reverts before `reversibleUntil`, and is allowed at `block.timestamp == reversibleUntil`;
  - extends the expiry to the paid term's end from `reversibleUntil` to `E` + 90 days;
  - reverts `NotReversible` from `E` + 90 days, and a second time;
  - settles a reserved name;
  - during the grace period, restores the subnames' owner.
- renewal on both paths reverts `RegistrationNotSettled` before settlement and works after it.
- reversal:
  - refuses a claim and settlement; the name lapses at `E` and is available 90 days later;
  - reverts at `block.timestamp == reversibleUntil`;
  - reverts for the admin, the registrar, the holder and anyone else;
  - reverts for a final registration.
- reinstatement:
  - extends the term at once and ends the entry, so a second reversal reverts `NotReversible`;
  - reverts from `E` + 90 days;
  - reverts for the guardian and anyone but the admin.
- transfers:
  - `transferFrom`, both `safeTransferFrom` overloads and `claimWithSig` revert `PaymentReversed` after a reversal;
  - `approve` and `approveWithSig` still work;
  - an offer and a claim before the reversal succeed, also between `reversibleUntil` and `E`, and the reversal then applies to the new holder;
  - subnames keep their owner between `reversibleUntil` and `E`.
- stale and lapsed entries:
  - a re-registration of a lapsed name, through `registerWithCredit` and through `registerReserved`, leaves the entry without effect;
  - so does a renewal by an added registrar controller;
  - `reversibleRegistration` answers zeros from `E` + 90 days.
- upgrades:
  - `SimplexSettlement` is upgraded only by the controller's owner, never once frozen, never to an implementation for another controller or registrar; an upgrade keeps the entries;
  - the name policy refuses an implementation built for another `settlement`;
  - the deployment order and the rollback, with transfers and renewals across each step;
  - an upgrade of proxies populated by the #49 implementations keeps every value;
  - the invariant `MAX_REVERSIBLE_PERIOD + SETTLEMENT_WINDOW < MIN_REGISTRATION`.
- each new guard, removed, fails at least one test.
