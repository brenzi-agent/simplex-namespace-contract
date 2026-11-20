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
  webstore: { at: [3550, 605], size: [330, 151], kind: 'client', title: 'Webstore — simplex.domains', tag: 'OFF-CHAIN',
    body: 'browser app served by StoreService:\nsearch, order (BTCPay, Stripe, codes);\nsigns RegisterName, terms and record\nedits with the owner code\'s key' },
  app: { at: [3555, 1555], size: [320, 170], kind: 'client', title: 'SimpleX app', tag: 'OFF-CHAIN',
    body: 'resolves names over SMP through a\nnames-role SMP server; opens\nsimplex.domains; planned: buys names\n(App Store, Google Play), signs\nRegisterName with the name\'s key' },
  dapp: { at: [120, 1085], size: [310, 151], kind: 'client', title: 'dApp — simplex-app', tag: 'OFF-CHAIN',
    body: 'ENS app v3 fork; the user\'s wallet\nsigns and pays: register, terms,\nrecords, offer and claim, subnames;\nadmin page for the owner\'s calls' },
  wallets: { at: [3575, 153], size: [280, 94], kind: 'client', title: 'Wallets and marketplaces', tag: 'OFF-CHAIN',
    body: 'ERC-721 view of each name' },
  storesvc: { at: [3515, 1066], size: [400, 189], kind: 'service', title: 'StoreService — simplex-store-service', tag: 'OFF-CHAIN',
    body: 'holds the registrar key, which pays gas only;\nrent is spent from its sponsor allowance;\ncommits, registers, and relays the owners\'\nsigned terms acceptances and record edits;\nplanned: relays offers and claims,\nsubnames, claim terms and renewals' },
  snrcres: { at: [100, 1574], size: [350, 132], kind: 'service', title: 'Resolver service — snrc-resolve', tag: 'OFF-CHAIN',
    body: 'answers the names role of SMP\nservers over HTTP; batches its\nreads through Multicall3' },
  sponsor: { at: [2695, 1574], size: [320, 132], kind: 'up', title: 'SimplexSponsor', tag: 'UPGRADEABLE',
    body: 'registrar allowances in attoUSD;\nregisterWithCredit, renewWithCredit,\nwith the owner\'s signature' },
  controller: { at: [985, 1555], size: [300, 170], kind: 'up', title: 'SimplexController', tag: 'UPGRADEABLE',
    body: 'commit, register, renew (payable);\nregisterSponsored, renewSponsored\n(sponsor only); sales switch;\nowner: admin Safe;\nbeneficiary: guardian Safe' },
  policy: { at: [1860, 1565], size: [270, 151], kind: 'up', title: 'SimplexNamePolicy', tag: 'UPGRADEABLE',
    body: 'reserved and community names;\ngeneral and community terms;\nacceptances; registerReserved;\nowner: the controller\'s owner' },
  registrar: { at: [2700, 1094], size: [310, 132], kind: 'up', title: 'BaseRegistrarImplementation', tag: 'UPGRADEABLE',
    body: 'ERC-721 of 2LDs, expiries, labels;\noffer and claim, approveWithSig,\nclaimWithSig; owner: admin Safe' },
  resolver: { at: [990, 1085], size: [290, 151], kind: 'up', title: 'SimplexResolver', tag: 'UPGRADEABLE',
    body: 'records of names and subnames:\nsimplex.contact, simplex.channel;\nsetText, setTextWithSig,\nclearRecordsWithSig' },
  subnames: { at: [1835, 614], size: [320, 132], kind: 'up', title: 'SubnameRegistrar', tag: 'UPGRADEABLE',
    body: 'subnames, soulbound to the 2LD;\ncreateSubname, createSubnameWithSig,\ndeleteSubname, purge' },
  registry: { at: [1850, 1094], size: [290, 132], kind: 'up', title: 'ENSRegistry', tag: 'UPGRADEABLE',
    body: 'owner and resolver of every node;\nsetApprovalForAll,\nsetApprovalForAllWithSig' },
  universal: { at: [1030, 633], size: [210, 94], kind: 'up', title: 'UniversalResolver', tag: 'UPGRADEABLE',
    body: 'resolve(name, data)' },
  oracle: { at: [125, 2064], size: [300, 113], kind: 'fixed', title: 'SimplexPriceOracle', tag: 'IMMUTABLE · setPriceOracle swaps it',
    body: 'US cents per year; feed settable;\nowner: admin Safe' },
  chainlink: { at: [145, 648], size: [260, 64], kind: 'external', title: 'Chainlink ETH/USD feed', tag: 'EXTERNAL',
    body: '' },
  renderer: { at: [2685, 153], size: [340, 94], kind: 'fixed', title: 'MetadataRenderer', tag: 'IMMUTABLE · setMetadataRenderer swaps it',
    body: 'tokenURI: on-chain JSON and SVG' },
  gateway: { at: [1015, 153], size: [240, 94], kind: 'fixed', title: 'DummyGatewayProvider', tag: 'IMMUTABLE',
    body: 'gateways()' },
  root: { at: [1855, 2054], size: [280, 132], kind: 'fixed', title: 'Root', tag: 'IMMUTABLE',
    body: 'owns the registry root;\nlock(simplex) at GOV9;\nowner and controller: admin Safe' },
  adminSafe: { at: [2685, 2054], size: [340, 132], kind: 'gov', title: 'admin Safe — 2 of 4', tag: 'GOVERNANCE',
    body: 'owns the eight ProxyAdmins, the\ncontroller, registrar, oracle and Root;\n7-day timelock in front from GOV8' },
  guardian: { at: [975, 2054], size: [320, 132], kind: 'gov', title: 'guardian Safe', tag: 'GOVERNANCE · 1 of 4, 2 of 4 from GOV7',
    body: 'the controller\'s beneficiary:\nreceives the revenue; halts sales,\nfunds registrars, reserves names' },
  proxyAdmins: { at: [3555, 2054], size: [320, 132], kind: 'gov', title: '8 × ProxyAdmin', tag: 'UPGRADE AUTHORITY',
    body: 'one per upgradeable contract (blue),\ncreated by its proxy; upgrades it;\nrenounceOwnership freezes it' },
}

const ZONE = { at: [945, 554], size: [2110, 1211],
  label: 'UPGRADEABLE UNTIL FROZEN', labelAt: [965, 556] }

const ARROWS = [
  ['webstore', 'storesvc', 'HTTPS /api: search, terms, invoice,\nregister, reveal (signed RegisterName\nand terms), find, record edits',
    { at: [3712, 862], points: [[3712, 756], [3712, 977], [3709, 977], [3709, 1066]] }],
  ['app', 'storesvc', 'SMP: badge commands',
    { at: [3693, 1328], points: [[3605, 1555], [3605, 1397], [3693, 1397], [3693, 1255]] }],
  ['app', 'storesvc', 'planned, SMP: name purchases\n(App Store, Google Play),\nsigned RegisterName',
    { at: [3717, 1480], points: [[3717, 1555], [3717, 1397], [3773, 1397], [3773, 1255]], planned: true }],
  ['app', 'snrcres', 'SMP: name lookup,\nthrough a names-role server',
    { at: [3159, 2208], points: [[3875, 1653], [3885, 1653], [3885, 2208], [2348, 2208], [2348, 2224], [78, 2224], [78, 1688], [100, 1688]] }],
  ['app', 'webstore', 'opens simplex.domains',
    { at: [3925, 1023], points: [[3875, 1573], [3925, 1573], [3925, 735], [3880, 735]] }],
  ['storesvc', 'sponsor', 'registerWithCredit;\nnonces, registrarAllowance',
    { at: [3163, 1228], points: [[3515, 1228], [3055, 1228], [3055, 1564], [2985, 1564], [2985, 1574]] }],
  ['storesvc', 'controller', 'commit; rentPriceUSD, available,\ncommitments, commitment ages,\nnamePolicy',
    { at: [3182, 1750], points: [[3565, 1255], [3565, 1411], [3545, 1411], [3545, 1750], [1303, 1750], [1303, 1701], [1285, 1701]] }],
  ['storesvc', 'policy', 'commitUnderGeneralTermsWithSig,\ncommitUnderCommunityTermsWithSig;\nreservedNames, communityNames,\nterms links, acceptedTerms, nonces',
    { at: [2296, 1679], points: [[3533, 1255], [3533, 1572], [2465, 1572], [2465, 1679], [2130, 1679]] }],
  ['storesvc', 'resolver', 'setTextWithSig, clearRecordsWithSig,\nmulticall of them; text, nonces',
    { at: [2296, 1084], points: [[3515, 1100], [3263, 1100], [3263, 1070], [2858, 1070], [2858, 1056], [2678, 1056], [2678, 1084], [1403, 1084], [1403, 1103], [1280, 1103]] }],
  ['storesvc', 'registrar', 'nameExpires, ownerOf,\nGRACE_PERIOD, ens; census:\nenumeration, labelOf,\nbaseNode, subnameHook',
    { at: [3385, 1164], points: [[3515, 1148], [3492, 1148], [3492, 1164], [3265, 1164], [3265, 1176], [3010, 1176]] }],
  ['storesvc', 'registry', 'owner, resolver',
    { at: [2300, 1208], points: [[3515, 1180], [3492, 1180], [3492, 1207], [3282, 1207], [3282, 1186], [3021, 1186], [3021, 1244], [2671, 1244], [2671, 1208], [2140, 1208]] }],
  ['storesvc', 'subnames', 'childrenLength,\ngetChildren, ownerOf',
    { at: [2934, 712], points: [[3515, 1084], [3128, 1084], [3128, 712], [2675, 712], [2675, 696], [2155, 696]] }],
  ['storesvc', 'sponsor', 'planned: renewWithCredit',
    { at: [3273, 1592], points: [[3549, 1255], [3549, 1399], [3539, 1399], [3539, 1592], [3015, 1592]], planned: true }],
  ['storesvc', 'policy', 'planned:\nacceptGeneralTermsForClaimWithSig,\nacceptCommunityTermsForClaimWithSig',
    { at: [2753, 1404], points: [[3515, 1212], [3266, 1212], [3266, 1200], [3038, 1200], [3038, 1404], [2453, 1404], [2453, 1583], [2130, 1583]], planned: true }],
  ['storesvc', 'registrar', 'planned: approveWithSig,\nclaimWithSig',
    { at: [3151, 1144], points: [[3515, 1116], [3265, 1116], [3265, 1144], [3010, 1144]], planned: true }],
  ['storesvc', 'registry', 'planned:\nsetApprovalForAllWithSig',
    { at: [2568, 1236], points: [[3515, 1164], [3504, 1164], [3504, 1215], [3274, 1215], [3274, 1193], [3030, 1193], [3030, 1236], [2108, 1236], [2108, 1226]], planned: true }],
  ['storesvc', 'subnames', 'planned: createSubnameWithSig,\ndeleteSubnameWithSig',
    { at: [3357, 696], points: [[3533, 1066], [3533, 696], [3128, 696], [3128, 680], [2155, 680]], planned: true }],
  ['snrcres', 'registrar', 'nameExpires, GRACE_PERIOD,\nlabelOf, subnameHook',
    { at: [845, 580], points: [[134, 1574], [134, 1383], [100, 1383], [100, 1025], [122, 1025], [122, 580], [2734, 580], [2734, 1094]] }],
  ['snrcres', 'registry', 'resolver, owner',
    { at: [1757, 1208], points: [[262, 1574], [262, 1288], [1606, 1288], [1606, 1208], [1850, 1208]] }],
  ['snrcres', 'controller', 'namePolicy, prices,\nminCharLength',
    { at: [791, 1637], points: [[450, 1640], [586, 1640], [586, 1637], [985, 1637]] }],
  ['snrcres', 'policy', 'reservedNames',
    { at: [883, 1545], points: [[294, 1574], [294, 1545], [1573, 1545], [1573, 1583], [1860, 1583]] }],
  ['snrcres', 'oracle', 'prices',
    { at: [278, 1827], points: [[278, 1706], [278, 1951], [271, 1951], [271, 2064]] }],
  ['snrcres', 'resolver', 'text, addr',
    { at: [427, 1414], points: [[278, 1574], [278, 1414], [531, 1414], [531, 1215], [990, 1215]] }],
  ['snrcres', 'subnames', 'ownerOf',
    { at: [643, 611], points: [[150, 1574], [150, 1371], [110, 1371], [110, 1037], [134, 1037], [134, 611], [1365, 611], [1365, 664], [1835, 664]] }],
  ['dapp', 'controller', 'commit, register, renew (payable);\nrentPrice, commitments, limits;\nadmin page: setMinCharLength',
    { at: [715, 1425], points: [[430, 1199], [715, 1199], [715, 1573], [985, 1573]] }],
  ['dapp', 'policy', 'commitUnder…Terms,\naccept…TermsForClaim;\nreservedNames, terms reads;\nadmin page: the owner\'s calls',
    { at: [1467, 1402], points: [[430, 1183], [515, 1183], [515, 1195], [912, 1195], [912, 1402], [1878, 1402], [1878, 1565]] }],
  ['dapp', 'registrar', 'approve (offer), transferFrom\n(claim); ownerOf, nameExpires,\nenumeration, tokenURI, offers',
    { at: [824, 1041], points: [[298, 1085], [298, 1041], [2690, 1041], [2690, 1112], [2700, 1112]] }],
  ['dapp', 'registry', 'setApprovalForAll, setResolver;\nowner, resolver, isApprovedForAll,\nNewOwner logs',
    { at: [1658, 1128], points: [[430, 1103], [960, 1103], [960, 1075], [1415, 1075], [1415, 1128], [1850, 1128]] }],
  ['dapp', 'subnames', 'createSubname, deleteSubname;\ngetChildren, ownerOf, generation',
    { at: [1614, 632], points: [[394, 1085], [394, 898], [510, 898], [510, 591], [712, 591], [712, 608], [1377, 608], [1377, 632], [1835, 632]] }],
  ['dapp', 'resolver', 'multicall (setText, setAddr, …),\nclearRecords; ABI, record logs',
    { at: [713, 1167], points: [[430, 1167], [990, 1167]] }],
  ['dapp', 'universal', 'resolve, findResolver,\nreverse',
    { at: [729, 913], points: [[410, 1085], [410, 913], [1048, 913], [1048, 727]] }],
  ['dapp', 'oracle', 'prices',
    { at: [90, 1528], points: [[120, 1167], [90, 1167], [90, 2082], [125, 2082]] }],
  ['dapp', 'chainlink', 'latestAnswer',
    { at: [275, 834], points: [[282, 1085], [282, 965], [275, 965], [275, 712]] }],
  ['wallets', 'registrar', 'ERC-721: balanceOf,\nownerOf, tokenURI',
    { at: [3366, 219], points: [[3575, 219], [3140, 219], [3140, 1112], [3010, 1112]] }],
  ['sponsor', 'controller', 'registerSponsored,\nrenewSponsored,\nrentPriceUSD, beneficiary',
    { at: [2576, 1640], points: [[2695, 1640], [2477, 1640], [2477, 1726], [1315, 1726], [1315, 1669], [1285, 1669]] }],
  ['controller', 'registrar', 'registerWithLabel, renew,\ntransferFrom; available,\nnameExpires',
    { at: [1888, 1358], points: [[1227, 1555], [1227, 1358], [2159, 1358], [2159, 1264], [2683, 1264], [2683, 1208], [2700, 1208]] }],
  ['controller', 'registry', 'setRecord, resolver',
    { at: [1495, 1308], points: [[1211, 1555], [1211, 1505], [1225, 1505], [1225, 1308], [1868, 1308], [1868, 1226]] }],
  ['controller', 'resolver', 'multicallWithNodeCheck,\nclearRecords',
    { at: [1131, 1437], points: [[1131, 1555], [1131, 1276], [1136, 1276], [1136, 1236]] }],
  ['controller', 'policy', 'consumeRegistration,\nisReserved, communityNames,\ncontroller',
    { at: [1421, 1637], points: [[1285, 1637], [1566, 1637], [1566, 1599], [1860, 1599]] }],
  ['controller', 'oracle', 'price, priceUSD',
    { at: [674, 2082], points: [[985, 1653], [913, 1653], [913, 2082], [425, 2082]] }],
  ['controller', 'guardian', 'withdraw: ETH revenue',
    { at: [1201, 1952], points: [[1147, 1725], [1147, 1833], [1201, 1833], [1201, 2054]] }],
  ['policy', 'controller', 'commit; commitments,\nmaxCommitmentAge, owner,\nbeneficiary, defaultResolver,\nwasDefaultResolver',
    { at: [1718, 1647], points: [[1860, 1647], [1566, 1647], [1566, 1685], [1285, 1685]] }],
  ['policy', 'registrar', 'registerWithLabel,\ntransferFrom, available',
    { at: [2253, 1424], points: [[2070, 1565], [2070, 1424], [2441, 1424], [2441, 1384], [2492, 1384], [2492, 1369], [2734, 1369], [2734, 1226]] }],
  ['policy', 'registry', 'setRecord, resolver',
    { at: [1990, 1445], points: [[1990, 1565], [1990, 1330], [1996, 1330], [1996, 1226]] }],
  ['policy', 'resolver', 'clearRecords',
    { at: [1381, 1215], points: [[1894, 1565], [1894, 1394], [1594, 1394], [1594, 1215], [1280, 1215]] }],
  ['registrar', 'registry', 'setSubnodeOwner,\nsetResolver, owner',
    { at: [2555, 1128], points: [[2700, 1128], [2140, 1128]] }],
  ['registrar', 'subnames', 'onReregister,\nonExpiryChanged',
    { at: [2433, 728], points: [[2718, 1094], [2718, 728], [2155, 728]] }],
  ['registrar', 'policy', 'consumeTransfer, registrar',
    { at: [2261, 1363], points: [[2718, 1226], [2718, 1363], [2069, 1363], [2069, 1510], [2054, 1510], [2054, 1565]] }],
  ['registrar', 'renderer', 'tokenURI',
    { at: [2847, 458], points: [[2846, 1094], [2846, 668], [2847, 668], [2847, 247]] }],
  ['subnames', 'registry', 'setSubnodeRecord, setOwner,\nsetResolver, owner',
    { at: [1997, 904], points: [[1997, 746], [1997, 1053], [1996, 1053], [1996, 1094]] }],
  ['subnames', 'resolver', 'clearSubnameRecords',
    { at: [1458, 906], points: [[1853, 746], [1853, 906], [1248, 906], [1248, 1085]] }],
  ['resolver', 'registry', 'owner',
    { at: [1482, 1183], points: [[1280, 1183], [1677, 1183], [1677, 1176], [1850, 1176]] }],
  ['resolver', 'subnames', 'ownerOf',
    { at: [1519, 1010], points: [[1152, 1085], [1152, 1010], [1869, 1010], [1869, 746]] }],
  ['universal', 'registry', 'resolver',
    { at: [1462, 699], points: [[1240, 699], [1692, 699], [1692, 1053], [1868, 1053], [1868, 1094]] }],
  ['universal', 'resolver', 'supportsInterface; text,\naddr, … as requested',
    { at: [1136, 957], points: [[1128, 727], [1128, 833], [1136, 833], [1136, 1085]] }],
  ['universal', 'gateway', 'gateways',
    { at: [1177, 409], points: [[1144, 633], [1144, 578], [1177, 578], [1177, 247]] }],
  ['root', 'registry', 'setSubnodeOwner,\nsetResolver',
    { at: [2164, 1794], points: [[2135, 2072], [2164, 2072], [2164, 1504], [2092, 1504], [2092, 1226]] }],
  ['oracle', 'chainlink', 'latestAnswer',
    { at: [66, 967], points: [[125, 2114], [55, 2114], [55, 1248], [66, 1248], [66, 682], [145, 682]] }],
  ['adminSafe', 'proxyAdmins', 'upgradeAndCall,\ntransferOwnership,\nrenounceOwnership',
    { at: [3341, 2120], points: [[3025, 2136], [3150, 2136], [3150, 2120], [3555, 2120]] }],
  ['adminSafe', 'controller', 'setSponsor, setDefaultResolver,\nsetNamePolicy, setPriceOracle,\nsetMinCharLength, recoverFunds,\nacceptOwnership',
    { at: [1591, 1896], points: [[2685, 2088], [2257, 2088], [2257, 1766], [1903, 1766], [1903, 1896], [1259, 1896], [1259, 1725]] }],
  ['adminSafe', 'policy', 'registerReserved,\nremoveReservedNames,\nremoveCommunityNames,\nsetGeneralTerms, setCommunityTerms',
    { at: [2411, 1899], points: [[2685, 2072], [2411, 2072], [2411, 1740], [2102, 1740], [2102, 1716]] }],
  ['adminSafe', 'registrar', 'addController, removeController,\nsetMetadataRenderer, setNamePolicy,\nsetSubnameHook, setMaxLabelLength,\nsetResolver',
    { at: [3068, 1987], points: [[3025, 2120], [3068, 2120], [3068, 1865], [3047, 1865], [3047, 1208], [3010, 1208]] }],
  ['adminSafe', 'oracle', 'setPrices, setUsdOracle,\nacceptOwnership',
    { at: [1547, 2196], points: [[2703, 2186], [2703, 2196], [399, 2196], [399, 2177]] }],
  ['adminSafe', 'root', 'setController, setResolver,\nlock, setSubnodeOwner',
    { at: [2409, 2120], points: [[2685, 2120], [2135, 2120]] }],
  ['guardian', 'sponsor', 'setRegistrarAllowance',
    { at: [1672, 1986], points: [[1217, 2054], [1217, 1986], [1927, 1986], [1927, 1757], [2713, 1757], [2713, 1706]] }],
  ['guardian', 'controller', 'setPublicSalesOpen,\nsetBeneficiary',
    { at: [1035, 1833], points: [[1041, 2054], [1041, 1953], [1035, 1953], [1035, 1725]] }],
  ['guardian', 'policy', 'addReservedNames,\nsetReservationReason,\naddCommunityNames',
    { at: [1551, 2120], points: [[1295, 2120], [1802, 2120], [1802, 1695], [1860, 1695]] }],
  ['proxyAdmins', 'zone', 'upgradeToAndCall',
    { at: [3314, 1840], points: [[3573, 2054], [3573, 1840], [3055, 1840], [3055, 1765]] }],
]

const TITLE = '.simplex v2 — goal architecture'
const LEGEND = [
  ['up', 'upgradeable: own proxy and ProxyAdmin'],
  ['fixed', 'immutable, swappable without downtime'],
  ['zone', 'dashed frame: upgradeable contracts'],
  ['client', 'off-chain: users\' clients'],
  ['service', 'off-chain: SimpleX services'],
  ['gov', 'governance'],
  ['external', 'external'],
  ['planned', 'dashed arrow: a call the plans assign'],
]
const LEGEND_AT = [65, 80]

const W = 4041
const H = 2266

const DASH = '8 5'

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
  for (const [, , , { points, planned }] of ARROWS) {
    out.push(`<polyline points="${points.map((p) => p.join(',')).join(' ')}" fill="none" stroke="#374151" stroke-width="1.6"${planned ? ` stroke-dasharray="${DASH}"` : ''}/>`)
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
    const yy = ly + 46 + i * 26
    if (k === 'planned') out.push(`<line x1="${lx + 14}" y1="${yy - 4}" x2="${lx + 36}" y2="${yy - 4}" stroke="#374151" stroke-width="1.6" stroke-dasharray="${DASH}"/>`)
    else out.push(`<rect x="${lx + 14}" y="${yy - 12}" width="22" height="16" rx="3" fill="${C[k].fill}" stroke="${C[k].stroke}" stroke-width="${k === 'up' ? 2.5 : 1.2}"/>`)
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
  for (const [from, to, label, { at: [mx, my], points, planned }] of ARROWS) {
    const [x0, y0] = points[0]
    const rel = points.map(([x, y]) => [x - x0, y - y0])
    const xs = rel.map((p) => p[0]), ys = rel.map((p) => p[1])
    const ar = base({ id: id('arrow'), type: 'arrow', x: x0, y: y0, width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys), strokeColor: '#374151', strokeStyle: planned ? 'dashed' : 'solid',
      roundness: null, points: rel,
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
    const yy = ly + 46 + i * 26
    if (k === 'planned') els.push(base({ type: 'line', x: lx + 14, y: yy - 4, width: 22, height: 0, strokeColor: '#374151',
      strokeStyle: 'dashed', roundness: null, points: [[0, 0], [22, 0]], lastCommittedPoint: null, startBinding: null,
      endBinding: null, startArrowhead: null, endArrowhead: null, groupIds: ['grp-legend'] }))
    else els.push(base({ type: 'rectangle', x: lx + 14, y: yy - 12, width: 22, height: 16, backgroundColor: C[k].fill,
      strokeColor: C[k].stroke, roundness: { type: 3 }, groupIds: ['grp-legend'] }))
    text(lx + 46, yy - 10, label, 13, { groupIds: ['grp-legend'] })
  })
  return { type: 'excalidraw', version: 2, source: 'snrc-architecture-generator', elements: els,
    appState: { gridSize: null, viewBackgroundColor: '#ffffff' }, files: {} }
}

const dir = new URL('.', import.meta.url).pathname
writeFileSync(`${dir}architecture-simplex-v2.excalidraw`, JSON.stringify(excalidraw(), null, 1))
writeFileSync(`${dir}architecture-simplex-v2.svg`, svg())
console.log('boxes:', Object.keys(BOXES).length, 'arrows:', ARROWS.length)
