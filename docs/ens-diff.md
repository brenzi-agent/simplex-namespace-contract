# How SNRC differs from ENS (in plain terms)

SNRC (the SimpleX Namespace Registry) is a fork of ENS — same commit-reveal
registration, same `ENSRegistry` and `PublicResolver` under the hood. If you know
ENS, here is what actually changed, and why.

**It's for chat, not wallets.** An ENS name points at things like an ETH address
or a website. An SNRC name points at **SimpleX chat links** — a contact link
(1:1) and a channel link — stored as text records. You look a name up and get a
link your SimpleX app can open.

**Different top-level names.** Names end in `.simplex` (and `.testing` for the
trial run), not `.eth`. Each TLD is its own separate deployment.

**Names are ordinary NFTs.** ENS added a "NameWrapper" that turns names into a
more complex token with programmable locks ("fuses"). SNRC removed all of it. A
name is a plain ERC-721 NFT and shows up in your wallet.

**Nobody gets a name they didn't ask for.** In ENS anyone can register a name to
your address or send you one, and the chain then shows it as yours. In SNRC a
name goes only to an address that agreed — by sending the transaction or by
signing. Sending a name is an offer the recipient takes; the sender cannot push
it. The price is that names don't sell on marketplaces, which deliver to the
buyer without the buyer's say.

**The picture is drawn on-chain.** ENS renders a name's NFT image on a hosted
server. SNRC builds the image and all its metadata entirely on-chain, so it needs
no server and can't be silently changed.

**No search index required.** To list "my names" or read a name, ENS leans on an
external indexer (The Graph). SNRC stores enough on-chain — it remembers each
name's text label and the token is enumerable — that the app works against any
plain Ethereum node, with no indexer.

**Sub-names stick to the name.** In ENS you can hand a subname (like
`team.alice.eth`) to someone else as an independent asset. In SNRC a subname is
**glued to its parent's NFT**: whoever holds `alice.simplex` controls all of its
subnames, and if the name is sold the subnames go with it. They can't be sold or
assigned separately.

**Registration rules are SNRC's own.** A name must be 6+ characters (loosened
over time) and some names are reserved. For `.testing`, registration was
initially limited to holders of a specific "SMPXNFT" access NFT — that gate has
since been lifted. Pricing is USD-denominated ($10/year for 6+ chars, ten times
more for each character shorter); `.testing` is free.

**Prices can be changed without a new contract.** ENS bakes its price list into
the oracle at deployment, so every price change means deploying a replacement.
SNRC's `SimplexPriceOracle` keeps the list in storage: a base yearly price plus a
short list of "names this long or shorter cost this much" steps, both replaceable
by one owner call. The contract refuses any change that would make a shorter name
cheaper than a longer one.

**Almost nothing can change after launch.** Only one contract — the registration
controller — is upgradeable, and that power is meant to move to a cold owner and
eventually be renounced. Everything else is fixed once deployed.
