import { writeFileSync } from 'fs'

const C = {
  up: { fill: '#dbeafe', stroke: '#1d4ed8', tag: '#1d4ed8' },
  fixed: { fill: '#f3f4f6', stroke: '#4b5563', tag: '#4b5563' },
  client: { fill: '#ede9fe', stroke: '#6d28d9', tag: '#6d28d9' },
  service: { fill: '#fae8ff', stroke: '#a21caf', tag: '#a21caf' },
  external: { fill: '#fef3c7', stroke: '#b45309', tag: '#b45309' },
  gov: { fill: '#dcfce7', stroke: '#15803d', tag: '#15803d' },
  zone: { fill: '#eff6ff', stroke: '#1d4ed8' },
}

const BOXES = {
  webstore: { at: [3549, 605], size: [330, 151], kind: 'client', title: 'Webstore — simplex.domains', tag: 'OFF-CHAIN',
    body: 'browser app served by StoreService:\nsearch, order (BTCPay, Stripe, codes);\nsigns RegisterName, terms and record\nedits with the owner code\'s key' },
  app: { at: [3569, 1574], size: [290, 132], kind: 'client', title: 'SimpleX app', tag: 'OFF-CHAIN',
    body: 'resolves names over SMP through a\nnames-role SMP server; opens\nsimplex.domains to buy a name' },
  dapp: { at: [119, 1085], size: [310, 151], kind: 'client', title: 'dApp — simplex-app', tag: 'OFF-CHAIN',
    body: 'ENS app v3 fork; the user\'s wallet\nsigns and pays: register, terms,\nrecords, offer and claim, subnames;\nadmin page for the owner\'s calls' },
  wallets: { at: [3574, 153], size: [280, 94], kind: 'client', title: 'Wallets and marketplaces', tag: 'OFF-CHAIN',
    body: 'ERC-721 view of each name' },
  storesvc: { at: [3514, 1085], size: [400, 151], kind: 'service', title: 'StoreService — simplex-store-service', tag: 'OFF-CHAIN',
    body: 'holds the registrar key, which pays gas only;\nrent is spent from its sponsor allowance;\ncommits, registers, and relays the owners\'\nsigned terms acceptances and record edits' },
  snrcres: { at: [99, 1574], size: [350, 132], kind: 'service', title: 'Resolver service — snrc-resolve', tag: 'OFF-CHAIN',
    body: 'answers the names role of SMP\nservers over HTTP; batches its\nreads through Multicall3' },
  metadata: { at: [1874, 144], size: [240, 113], kind: 'service', title: 'ens-metadata-service', tag: 'OFF-CHAIN',
    body: 'NFT metadata API; names\nand dates from a subgraph' },
  sponsor: { at: [2694, 1574], size: [320, 132], kind: 'up', title: 'SimplexSponsor', tag: 'UPGRADEABLE',
    body: 'registrar allowances in attoUSD;\nregisterWithCredit, renewWithCredit,\nwith the owner\'s signature' },
  controller: { at: [984, 1555], size: [300, 170], kind: 'up', title: 'SimplexController', tag: 'UPGRADEABLE',
    body: 'commit, register, renew (payable);\nregisterSponsored, renewSponsored\n(sponsor only); sales switch;\nowner: admin Safe;\nbeneficiary: guardian Safe' },
  policy: { at: [1859, 1565], size: [270, 151], kind: 'up', title: 'SimplexNamePolicy', tag: 'UPGRADEABLE',
    body: 'reserved and community names;\ngeneral and community terms;\nacceptances; registerReserved;\nowner: the controller\'s owner' },
  registrar: { at: [2699, 1094], size: [310, 132], kind: 'up', title: 'BaseRegistrarImplementation', tag: 'UPGRADEABLE',
    body: 'ERC-721 of 2LDs, expiries, labels;\noffer and claim, approveWithSig,\nclaimWithSig; owner: admin Safe' },
  resolver: { at: [989, 1085], size: [290, 151], kind: 'up', title: 'SimplexResolver', tag: 'UPGRADEABLE',
    body: 'records of names and subnames:\nsimplex.contact, simplex.channel;\nsetText, setTextWithSig,\nclearRecordsWithSig' },
  subnames: { at: [1834, 614], size: [320, 132], kind: 'up', title: 'SubnameRegistrar', tag: 'UPGRADEABLE',
    body: 'subnames, soulbound to the 2LD;\ncreateSubname, createSubnameWithSig,\ndeleteSubname, purge' },
  registry: { at: [1849, 1094], size: [290, 132], kind: 'up', title: 'ENSRegistry', tag: 'UPGRADEABLE',
    body: 'owner and resolver of every node;\nsetApprovalForAll,\nsetApprovalForAllWithSig' },
  universal: { at: [1029, 633], size: [210, 94], kind: 'up', title: 'UniversalResolver', tag: 'UPGRADEABLE',
    body: 'resolve(name, data)' },
  oracle: { at: [124, 2064], size: [300, 113], kind: 'fixed', title: 'SimplexPriceOracle', tag: 'IMMUTABLE · setPriceOracle swaps it',
    body: 'US cents per year; feed settable;\nowner: admin Safe' },
  chainlink: { at: [144, 648], size: [260, 64], kind: 'external', title: 'Chainlink ETH/USD feed', tag: 'EXTERNAL',
    body: '' },
  renderer: { at: [2684, 153], size: [340, 94], kind: 'fixed', title: 'MetadataRenderer', tag: 'IMMUTABLE · setMetadataRenderer swaps it',
    body: 'tokenURI: on-chain JSON and SVG' },
  gateway: { at: [1014, 153], size: [240, 94], kind: 'fixed', title: 'DummyGatewayProvider', tag: 'IMMUTABLE',
    body: 'gateways()' },
  root: { at: [1854, 2054], size: [280, 132], kind: 'fixed', title: 'Root', tag: 'IMMUTABLE',
    body: 'owns the registry root;\nlock(simplex) at GOV9;\nowner and controller: admin Safe' },
  adminSafe: { at: [2684, 2054], size: [340, 132], kind: 'gov', title: 'admin Safe — 2 of 4', tag: 'GOVERNANCE',
    body: 'owns the eight ProxyAdmins, the\ncontroller, registrar, oracle and Root;\n7-day timelock in front from GOV8' },
  guardian: { at: [974, 2054], size: [320, 132], kind: 'gov', title: 'guardian Safe', tag: 'GOVERNANCE · 1 of 4, 2 of 4 from GOV7',
    body: 'the controller\'s beneficiary:\nreceives the revenue; halts sales,\nfunds registrars, reserves names' },
  proxyAdmins: { at: [3554, 2054], size: [320, 132], kind: 'gov', title: '8 × ProxyAdmin', tag: 'UPGRADE AUTHORITY',
    body: 'one per upgradeable contract (blue),\ncreated by its proxy; upgrades it;\nrenounceOwnership freezes it' },
}

const ZONE = { at: [944, 554], size: [2110, 1211],
  label: 'UPGRADEABLE UNTIL FROZEN', labelAt: [964, 556] }

const ARROWS = [
  ['webstore', 'storesvc', 'HTTPS /api: search, terms, invoice,\nregister, reveal (signed RegisterName\nand terms), find, record edits',
    { at: [3711, 872], points: [[3711, 756], [3711, 991], [3708, 991], [3708, 1085]] }],
  ['app', 'storesvc', 'SMP: badge commands',
    { at: [3715, 1464], points: [[3715, 1574], [3715, 1345], [3708, 1345], [3708, 1236]] }],
  ['app', 'snrcres', 'SMP: name lookup,\nthrough a names-role server',
    { at: [3152, 2212], points: [[3859, 1688], [3888, 1688], [3888, 2212], [2349, 2212], [2349, 2244], [73, 2244], [73, 1688], [99, 1688]] }],
  ['app', 'webstore', 'opens simplex.domains',
    { at: [3928, 1280], points: [[3859, 1640], [3928, 1640], [3928, 735], [3879, 735]] }],
  ['storesvc', 'sponsor', 'registerWithCredit;\nnonces, registrarAllowance',
    { at: [3286, 1592], points: [[3548, 1236], [3548, 1592], [3014, 1592]] }],
  ['storesvc', 'controller', 'commit; rentPriceUSD, available,\ncommitments, commitment ages,\nnamePolicy',
    { at: [3040, 1989], points: [[3564, 1236], [3564, 1405], [3554, 1405], [3554, 1753], [3040, 1753], [3040, 2206], [2337, 2206], [2337, 2232], [951, 2232], [951, 1701], [984, 1701]] }],
  ['storesvc', 'policy', 'commitUnderGeneralTermsWithSig,\ncommitUnderCommunityTermsWithSig;\nreservedNames, communityNames,\nterms links, acceptedTerms, nonces',
    { at: [3183, 1406], points: [[3532, 1236], [3532, 1406], [2603, 1406], [2603, 1583], [2129, 1583]] }],
  ['storesvc', 'resolver', 'setTextWithSig, clearRecordsWithSig,\nmulticall of them; text, nonces',
    { at: [2542, 1080], points: [[3514, 1119], [3319, 1119], [3319, 1080], [1676, 1080], [1676, 1135], [1279, 1135]] }],
  ['storesvc', 'registrar', 'nameExpires, ownerOf,\nGRACE_PERIOD, ens; census:\nenumeration, labelOf,\nbaseNode, subnameHook',
    { at: [3212, 1160], points: [[3514, 1151], [3409, 1151], [3409, 1160], [3009, 1160]] }],
  ['storesvc', 'registry', 'owner, resolver',
    { at: [2609, 1240], points: [[3514, 1167], [3409, 1167], [3409, 1240], [2346, 1240], [2346, 1192], [2139, 1192]] }],
  ['storesvc', 'subnames', 'childrenLength,\ngetChildren, ownerOf',
    { at: [2970, 712], points: [[3532, 1085], [3532, 712], [2566, 712], [2566, 696], [2154, 696]] }],
  ['snrcres', 'registrar', 'nameExpires, GRACE_PERIOD,\nlabelOf, subnameHook',
    { at: [319, 473], points: [[133, 1574], [133, 1383], [95, 1383], [95, 1034], [126, 1034], [126, 473], [745, 473], [745, 118], [2602, 118], [2602, 649], [2749, 649], [2749, 1094]] }],
  ['snrcres', 'registry', 'resolver, owner',
    { at: [877, 1474], points: [[261, 1574], [261, 1474], [1545, 1474], [1545, 1176], [1849, 1176]] }],
  ['snrcres', 'controller', 'namePolicy, prices,\nminCharLength',
    { at: [790, 1637], points: [[449, 1640], [585, 1640], [585, 1637], [984, 1637]] }],
  ['snrcres', 'policy', 'reservedNames',
    { at: [882, 1541], points: [[277, 1574], [277, 1541], [1582, 1541], [1582, 1600], [1839, 1600], [1839, 1615], [1859, 1615]] }],
  ['snrcres', 'oracle', 'prices',
    { at: [277, 1827], points: [[277, 1706], [277, 1951], [270, 1951], [270, 2064]] }],
  ['snrcres', 'resolver', 'text, addr',
    { at: [829, 1215], points: [[245, 1574], [245, 1321], [738, 1321], [738, 1215], [989, 1215]] }],
  ['snrcres', 'subnames', 'ownerOf',
    { at: [899, 595], points: [[149, 1574], [149, 1371], [105, 1371], [105, 1046], [130, 1046], [130, 595], [1852, 595], [1852, 614]] }],
  ['dapp', 'controller', 'commit, register, renew (payable);\nrentPrice, commitments, limits;\nadmin page: setMinCharLength',
    { at: [714, 1385], points: [[429, 1199], [714, 1199], [714, 1573], [984, 1573]] }],
  ['dapp', 'policy', 'commitUnder…Terms,\naccept…TermsForClaim;\nreservedNames, terms reads;\nadmin page: the owner\'s calls',
    { at: [1877, 1374], points: [[429, 1183], [514, 1183], [514, 1242], [726, 1242], [726, 1309], [1877, 1309], [1877, 1565]] }],
  ['dapp', 'registrar', 'approve (offer), transferFrom\n(claim); ownerOf, nameExpires,\nenumeration, tokenURI, offers',
    { at: [555, 804], points: [[345, 1085], [345, 804], [733, 804], [733, 485], [928, 485], [928, 130], [2590, 130], [2590, 661], [2765, 661], [2765, 1094]] }],
  ['dapp', 'registry', 'setApprovalForAll, setResolver;\nowner, resolver, isApprovedForAll,\nNewOwner logs',
    { at: [649, 1103], points: [[429, 1103], [879, 1103], [879, 1071], [1640, 1071], [1640, 1144], [1849, 1144]] }],
  ['dapp', 'subnames', 'createSubname, deleteSubname;\ngetChildren, ownerOf, generation',
    { at: [1572, 632], points: [[329, 1085], [329, 965], [334, 965], [334, 745], [979, 745], [979, 619], [1349, 619], [1349, 632], [1834, 632]] }],
  ['dapp', 'resolver', 'multicall (setText, setAddr, …),\nclearRecords; ABI, record logs',
    { at: [712, 1167], points: [[429, 1167], [989, 1167]] }],
  ['dapp', 'universal', 'resolve, findResolver,\nreverse',
    { at: [676, 913], points: [[361, 1085], [361, 913], [1047, 913], [1047, 727]] }],
  ['dapp', 'oracle', 'prices',
    { at: [85, 1528], points: [[119, 1167], [85, 1167], [85, 2082], [124, 2082]] }],
  ['dapp', 'chainlink', 'latestAnswer',
    { at: [274, 834], points: [[281, 1085], [281, 965], [274, 965], [274, 712]] }],
  ['wallets', 'registrar', 'ERC-721: balanceOf,\nownerOf, tokenURI',
    { at: [3445, 219], points: [[3574, 219], [3330, 219], [3330, 1112], [3009, 1112]] }],
  ['metadata', 'registrar', 'ownerOf',
    { at: [2343, 226], points: [[2114, 226], [2578, 226], [2578, 716], [2733, 716], [2733, 1094]] }],
  ['metadata', 'registry', 'recordExists',
    { at: [1817, 791], points: [[1874, 210], [1817, 210], [1817, 1112], [1849, 1112]] }],
  ['sponsor', 'controller', 'registerSponsored,\nrenewSponsored,\nrentPriceUSD, beneficiary',
    { at: [2425, 1640], points: [[2694, 1640], [2155, 1640], [2155, 1730], [1572, 1730], [1572, 1701], [1284, 1701]] }],
  ['controller', 'registrar', 'registerWithLabel, renew,\ntransferFrom; available,\nnameExpires',
    { at: [1736, 1519], points: [[1146, 1555], [1146, 1519], [2089, 1519], [2089, 1280], [2399, 1280], [2399, 1136], [2674, 1136], [2674, 1144], [2699, 1144]] }],
  ['controller', 'registry', 'setRecord, resolver',
    { at: [1640, 1208], points: [[1284, 1573], [1557, 1573], [1557, 1208], [1849, 1208]] }],
  ['controller', 'resolver', 'multicallWithNodeCheck,\nclearRecords',
    { at: [1130, 1427], points: [[1130, 1555], [1130, 1297], [1135, 1297], [1135, 1236]] }],
  ['controller', 'policy', 'consumeRegistration,\nisReserved, communityNames,\ncontroller',
    { at: [1430, 1637], points: [[1284, 1637], [1570, 1637], [1570, 1599], [1859, 1599]] }],
  ['controller', 'oracle', 'price, priceUSD',
    { at: [673, 2082], points: [[984, 1653], [912, 1653], [912, 2082], [424, 2082]] }],
  ['controller', 'guardian', 'withdraw: ETH revenue',
    { at: [1216, 1952], points: [[1146, 1725], [1146, 1833], [1216, 1833], [1216, 2054]] }],
  ['policy', 'controller', 'commit; commitments,\nmaxCommitmentAge, owner,\nbeneficiary, defaultResolver,\nwasDefaultResolver',
    { at: [1717, 1647], points: [[1859, 1647], [1570, 1647], [1570, 1685], [1284, 1685]] }],
  ['policy', 'registrar', 'registerWithLabel,\ntransferFrom, available',
    { at: [2429, 1395], points: [[2005, 1565], [2005, 1530], [2429, 1530], [2429, 1208], [2699, 1208]] }],
  ['policy', 'registry', 'setRecord, resolver',
    { at: [1989, 1455], points: [[1989, 1565], [1989, 1426], [1995, 1426], [1995, 1226]] }],
  ['policy', 'resolver', 'clearRecords',
    { at: [1485, 1261], points: [[1859, 1583], [1594, 1583], [1594, 1261], [1247, 1261], [1247, 1236]] }],
  ['registrar', 'registry', 'setSubnodeOwner,\nsetResolver, owner',
    { at: [2268, 1144], points: [[2699, 1128], [2387, 1128], [2387, 1144], [2139, 1144]] }],
  ['registrar', 'subnames', 'onReregister,\nonExpiryChanged',
    { at: [2432, 728], points: [[2717, 1094], [2717, 728], [2154, 728]] }],
  ['registrar', 'policy', 'consumeTransfer, registrar',
    { at: [2557, 1160], points: [[2699, 1160], [2411, 1160], [2411, 1292], [2292, 1292], [2292, 1542], [2101, 1542], [2101, 1565]] }],
  ['registrar', 'renderer', 'tokenURI',
    { at: [2846, 470], points: [[2845, 1094], [2845, 700], [2846, 700], [2846, 247]] }],
  ['subnames', 'registry', 'setSubnodeRecord, setOwner,\nsetResolver, owner',
    { at: [1996, 864], points: [[1996, 746], [1996, 988], [1995, 988], [1995, 1094]] }],
  ['subnames', 'resolver', 'clearSubnameRecords',
    { at: [1445, 906], points: [[1834, 680], [1640, 680], [1640, 906], [1247, 906], [1247, 1085]] }],
  ['resolver', 'registry', 'owner',
    { at: [1471, 1167], points: [[1279, 1167], [1671, 1167], [1671, 1160], [1849, 1160]] }],
  ['resolver', 'subnames', 'ownerOf',
    { at: [1468, 1103], points: [[1279, 1103], [1664, 1103], [1664, 728], [1834, 728]] }],
  ['universal', 'registry', 'resolver',
    { at: [1441, 699], points: [[1239, 699], [1652, 699], [1652, 1128], [1849, 1128]] }],
  ['universal', 'resolver', 'supportsInterface; text,\naddr, … as requested',
    { at: [1135, 1025], points: [[1127, 727], [1127, 867], [1135, 867], [1135, 1085]] }],
  ['universal', 'gateway', 'gateways',
    { at: [1176, 413], points: [[1143, 633], [1143, 583], [1176, 583], [1176, 247]] }],
  ['root', 'registry', 'setSubnodeOwner,\nsetResolver',
    { at: [2179, 1488], points: [[2000, 2054], [2000, 1766], [2179, 1766], [2179, 1208], [2139, 1208]] }],
  ['oracle', 'chainlink', 'latestAnswer',
    { at: [66, 984], points: [[124, 2114], [46, 2114], [46, 1256], [66, 1256], [66, 682], [144, 682]] }],
  ['adminSafe', 'proxyAdmins', 'upgradeAndCall,\ntransferOwnership,\nrenounceOwnership',
    { at: [3290, 2120], points: [[3024, 2120], [3554, 2120]] }],
  ['adminSafe', 'controller', 'setSponsor, setDefaultResolver,\nsetNamePolicy, setPriceOracle,\nsetMinCharLength, recoverFunds,\nacceptOwnership',
    { at: [1706, 1896], points: [[2684, 2088], [2155, 2088], [2155, 1896], [1258, 1896], [1258, 1725]] }],
  ['adminSafe', 'policy', 'registerReserved,\nremoveReservedNames,\nremoveCommunityNames,\nsetGeneralTerms, setCommunityTerms',
    { at: [2167, 1849], points: [[2684, 2072], [2167, 2072], [2167, 1695], [2129, 1695]] }],
  ['adminSafe', 'registrar', 'addController, removeController,\nsetMetadataRenderer, setNamePolicy,\nsetSubnameHook, setMaxLabelLength,\nsetResolver',
    { at: [2702, 1921], points: [[2702, 2054], [2702, 1797], [3028, 1797], [3028, 1394], [2989, 1394], [2989, 1226]] }],
  ['adminSafe', 'oracle', 'setPrices, setUsdOracle,\nacceptOwnership',
    { at: [1546, 2200], points: [[2702, 2186], [2702, 2200], [398, 2200], [398, 2177]] }],
  ['adminSafe', 'root', 'setController, setResolver,\nlock, setSubnodeOwner',
    { at: [2408, 2120], points: [[2684, 2120], [2134, 2120]] }],
  ['guardian', 'sponsor', 'setRegistrarAllowance',
    { at: [2335, 1987], points: [[1232, 2054], [1232, 1987], [2495, 1987], [2495, 1688], [2694, 1688]] }],
  ['guardian', 'controller', 'setPublicSalesOpen,\nsetBeneficiary',
    { at: [1034, 1833], points: [[1040, 2054], [1040, 1953], [1034, 1953], [1034, 1725]] }],
  ['guardian', 'policy', 'addReservedNames,\nsetReservationReason,\naddCommunityNames',
    { at: [1560, 2120], points: [[1294, 2120], [1835, 2120], [1835, 1695], [1859, 1695]] }],
  ['proxyAdmins', 'zone', 'upgradeToAndCall',
    { at: [3572, 1914], points: [[3572, 2054], [3572, 1765], [3054, 1765]] }],
]

const TITLE = '.simplex v2 — goal architecture'
const LEGEND = [
  ['up', 'upgradeable: own proxy and ProxyAdmin'],
  ['fixed', 'immutable, swappable without downtime'],
  ['zone', 'dashed: the eight upgradeable contracts'],
  ['client', 'off-chain: users\' clients'],
  ['service', 'off-chain: SimpleX services'],
  ['gov', 'governance'],
  ['external', 'external'],
]
const LEGEND_AT = [64, 80]

const W = 4044
const H = 2284

const lines = (s) => (s ? s.split('\n') : [])
const textWidth = (s, size) => Math.max(0, ...lines(s).map((l) => l.length)) * size * 0.56

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function svg() {
  const out = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="IBM Plex Sans, Helvetica, Arial, sans-serif" role="img" aria-label="${esc(TITLE)}">`)
  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`)
  out.push(`<text x="40" y="38" font-size="26" font-weight="600" fill="#111827">${esc(TITLE)}</text>`)
  const [zx, zy] = ZONE.at, [zw, zh] = ZONE.size
  out.push(`<rect x="${zx}" y="${zy}" width="${zw}" height="${zh}" rx="14" fill="${C.zone.fill}" stroke="${C.zone.stroke}" stroke-width="2" stroke-dasharray="10 6"/>`)
  const head = ([x1, y1], [x2, y2]) => {
    const len = Math.hypot(x2 - x1, y2 - y1) || 1
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len
    const bx = x2 - ux * 11, by = y2 - uy * 11
    return `<polygon points="${x2},${y2} ${bx - uy * 5},${by + ux * 5} ${bx + uy * 5},${by - ux * 5}" fill="#374151"/>`
  }
  for (const [, , , { points }] of ARROWS) {
    out.push(`<polyline points="${points.map((p) => p.join(',')).join(' ')}" fill="none" stroke="#374151" stroke-width="1.6"/>`)
    out.push(head(points.at(-2), points.at(-1)))
  }
  for (const [, b] of Object.entries(BOXES)) {
    const [x, y] = b.at, [w, h] = b.size, c = C[b.kind]
    out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${c.fill}" stroke="${c.stroke}" stroke-width="${b.kind === 'up' ? 3 : 1.5}"/>`)
    out.push(`<text x="${x + 14}" y="${y + 22}" font-size="11" font-weight="600" letter-spacing="0.06em" fill="${c.tag}">${esc(b.tag)}</text>`)
    out.push(`<text x="${x + 14}" y="${y + 46}" font-size="17" font-weight="600" fill="#111827">${esc(b.title)}</text>`)
    lines(b.body).forEach((l, i) => out.push(`<text x="${x + 14}" y="${y + 72 + i * 19}" font-size="14" fill="#1f2937">${esc(l)}</text>`))
  }
  const [lzx, lzy] = ZONE.labelAt
  out.push(`<rect x="${lzx - 6}" y="${lzy - 8}" width="${textWidth(ZONE.label, 14) + 12}" height="20" rx="4" fill="${C.zone.fill}"/>`)
  out.push(`<text x="${lzx}" y="${lzy + 7}" font-size="14" font-weight="600" fill="${C.zone.stroke}">${esc(ZONE.label)}</text>`)
  for (const [, , label, { at: [mx, my] }] of ARROWS) {
    const ls = lines(label)
    const w = textWidth(label, 12) + 10, h = ls.length * 15 + 6
    out.push(`<rect x="${mx - w / 2}" y="${my - h / 2}" width="${w}" height="${h}" rx="4" fill="#ffffff" fill-opacity="0.94" stroke="#d1d5db" stroke-width="0.8"/>`)
    ls.forEach((l, i) => out.push(`<text x="${mx}" y="${my - h / 2 + 15 + i * 15}" font-size="12" text-anchor="middle" fill="#374151">${esc(l)}</text>`))
  }
  const [lx, ly] = LEGEND_AT
  out.push(`<rect x="${lx}" y="${ly}" width="340" height="${36 + LEGEND.length * 26}" rx="8" fill="#ffffff" stroke="#9ca3af"/>`)
  out.push(`<text x="${lx + 14}" y="${ly + 24}" font-size="13" font-weight="600" fill="#111827">LEGEND</text>`)
  LEGEND.forEach(([k, label], i) => {
    const c = C[k], yy = ly + 46 + i * 26
    out.push(`<rect x="${lx + 14}" y="${yy - 12}" width="22" height="16" rx="3" fill="${c.fill}" stroke="${c.stroke}" stroke-width="${k === 'up' ? 2.5 : 1.2}"/>`)
    out.push(`<text x="${lx + 46}" y="${yy + 1}" font-size="13" fill="#1f2937">${esc(label)}</text>`)
  })
  out.push('</svg>')
  return out.join('\n')
}

function excalidraw() {
  let n = 0
  const id = (p) => `${p}-${++n}`
  const seed = (text) => {
    let h = 0x811c9dc5
    for (const c of text) h = Math.imul(h ^ c.codePointAt(0), 0x01000193) >>> 0
    return h % 2 ** 31
  }
  const base = (over) => {
    const el = {
      id: id('el'), angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
      strokeWidth: 1, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null,
      seed: 0, version: 1, versionNonce: 0, isDeleted: false, boundElements: null, updated: 1,
      link: null, locked: false, ...over,
    }
    el.seed = seed(el.id)
    el.versionNonce = seed(`${el.id}/versionNonce`)
    return el
  }
  const els = []
  const rects = {}
  const text = (x, y, str, size, extra = {}) => els.push(base({
    type: 'text', x, y, width: textWidth(str, size), height: lines(str).length * size * 1.25, text: str,
    fontSize: size, fontFamily: 2, textAlign: 'left', verticalAlign: 'top', containerId: null,
    originalText: str, autoResize: true, lineHeight: 1.25, ...extra,
  }))
  text(40, 8, TITLE, 26)
  const zone = base({ id: 'box-zone', type: 'rectangle', x: ZONE.at[0], y: ZONE.at[1], width: ZONE.size[0],
    height: ZONE.size[1], backgroundColor: C.zone.fill, strokeColor: C.zone.stroke, strokeStyle: 'dashed',
    strokeWidth: 2, roundness: { type: 3 }, boundElements: [] })
  els.push(zone)
  rects.zone = zone
  text(ZONE.labelAt[0], ZONE.labelAt[1] - 8, ZONE.label, 14, { strokeColor: C.zone.stroke })
  for (const [key, b] of Object.entries(BOXES)) {
    const c = C[b.kind], gid = `grp-${key}`
    const r = base({ id: `box-${key}`, type: 'rectangle', x: b.at[0], y: b.at[1], width: b.size[0],
      height: b.size[1], backgroundColor: c.fill, strokeColor: c.stroke, strokeWidth: b.kind === 'up' ? 4 : 2,
      roundness: { type: 3 }, groupIds: [gid], boundElements: [] })
    els.push(r)
    rects[key] = r
    text(b.at[0] + 14, b.at[1] + 10, b.tag, 11, { strokeColor: c.tag, groupIds: [gid] })
    text(b.at[0] + 14, b.at[1] + 30, b.title, 17, { groupIds: [gid] })
    if (b.body) text(b.at[0] + 14, b.at[1] + 58, b.body, 14, { groupIds: [gid] })
  }
  for (const [from, to, label, { at: [mx, my], points }] of ARROWS) {
    const [x0, y0] = points[0]
    const rel = points.map(([x, y]) => [x - x0, y - y0])
    const xs = rel.map((p) => p[0]), ys = rel.map((p) => p[1])
    const ar = base({ id: id('arrow'), type: 'arrow', x: x0, y: y0, width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys), strokeColor: '#374151', roundness: null, points: rel,
      lastCommittedPoint: null, startBinding: { elementId: rects[from].id, focus: 0, gap: 2 },
      endBinding: { elementId: rects[to].id, focus: 0, gap: 2 }, startArrowhead: null,
      endArrowhead: 'arrow', elbowed: false, boundElements: [] })
    els.push(ar)
    rects[from].boundElements.push({ id: ar.id, type: 'arrow' })
    rects[to].boundElements.push({ id: ar.id, type: 'arrow' })
    const w = textWidth(label, 12), h = lines(label).length * 15
    const t = base({ id: id('lbl'), type: 'text', x: mx - w / 2, y: my - h / 2, width: w, height: h, text: label,
      fontSize: 12, fontFamily: 2, textAlign: 'center', verticalAlign: 'middle', containerId: ar.id,
      originalText: label, autoResize: true, lineHeight: 1.25, strokeColor: '#374151' })
    els.push(t)
    ar.boundElements.push({ id: t.id, type: 'text' })
  }
  const [lx, ly] = LEGEND_AT
  els.push(base({ type: 'rectangle', x: lx, y: ly, width: 340, height: 36 + LEGEND.length * 26,
    backgroundColor: '#ffffff', strokeColor: '#9ca3af', roundness: { type: 3 }, groupIds: ['grp-legend'] }))
  text(lx + 14, ly + 10, 'LEGEND', 13, { groupIds: ['grp-legend'] })
  LEGEND.forEach(([k, label], i) => {
    const c = C[k], yy = ly + 46 + i * 26
    els.push(base({ type: 'rectangle', x: lx + 14, y: yy - 12, width: 22, height: 16, backgroundColor: c.fill,
      strokeColor: c.stroke, roundness: { type: 3 }, groupIds: ['grp-legend'] }))
    text(lx + 46, yy - 10, label, 13, { groupIds: ['grp-legend'] })
  })
  return { type: 'excalidraw', version: 2, source: 'snrc-architecture-generator', elements: els,
    appState: { gridSize: null, viewBackgroundColor: '#ffffff' }, files: {} }
}

const dir = new URL('.', import.meta.url).pathname
writeFileSync(`${dir}architecture-simplex-v2.excalidraw`, JSON.stringify(excalidraw(), null, 1))
writeFileSync(`${dir}architecture-simplex-v2.svg`, svg())
console.log('boxes:', Object.keys(BOXES).length, 'arrows:', ARROWS.length)
