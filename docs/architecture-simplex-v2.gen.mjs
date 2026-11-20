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

const COL = [450, 960, 1470]
const CW = 370
const ROW_A = 760
const ROW_B = 1110
const RH = 230

const BOXES = {
  webstore: { at: [40, 60], size: [360, 140], kind: 'client', title: 'Webstore — simplex.domains', tag: 'OFF-CHAIN',
    body: 'browser app served by StoreService:\nsearch, order (BTCPay, Stripe, codes);\nsigns RegisterName with a browser\nwallet; edits links' },
  app: { at: [440, 60], size: [360, 140], kind: 'client', title: 'SimpleX app', tag: 'OFF-CHAIN',
    body: 'buys names through the App Store\nand Google Play; signs RegisterName\nwith the name\'s wallet key;\nresolves names over SMP' },
  storesvc: { at: [40, 290], size: [460, 180], kind: 'service', title: 'StoreService — simplex-store-service', tag: 'OFF-CHAIN',
    body: 'holds the registrar key, which pays gas only;\nrent is spent from its sponsor allowance;\nrelays the owners\' signed record edits;\nreads the registrar, registry, controller,\nresolver and sponsor' },
  snrcres: { at: [960, 290], size: [370, 140], kind: 'service', title: 'Resolver service — names role', tag: 'OFF-CHAIN',
    body: 'answers SimpleX lookups over SMP;\nreads the registry and the resolver\n(snrc-resolve)' },
  sponsor: { at: [40, 520], size: [330, 150], kind: 'up', title: 'SimplexSponsor', tag: 'UPGRADEABLE',
    body: 'registrar allowances in attoUSD;\nregisterWithCredit, renewWithCredit,\nwith the owner\'s signature' },
  oracle: { at: [40, 760], size: [330, 140], kind: 'fixed', title: 'SimplexPriceOracle', tag: 'IMMUTABLE · setPriceOracle swaps it',
    body: 'US cents per year; feed settable;\nowner: admin Safe' },
  chainlink: { at: [40, 940], size: [330, 70], kind: 'external', title: 'Chainlink ETH/USD feed', tag: 'EXTERNAL', body: '' },
  controller: { at: [COL[0], ROW_A], size: [CW, RH], kind: 'up', title: 'SimplexController', tag: 'UPGRADEABLE',
    body: 'commit, register, renew (payable);\nregisterSponsored, renewSponsored\n(sponsor only); sales switch;\nowner: admin Safe;\nbeneficiary: guardian Safe' },
  resolver: { at: [COL[1], ROW_A], size: [CW, RH], kind: 'up', title: 'SimplexResolver', tag: 'UPGRADEABLE',
    body: 'records of names and subnames:\nsimplex.contact, simplex.channel;\nsetText, setTextWithSig,\nclearRecordsWithSig' },
  registry: { at: [COL[2], ROW_A], size: [CW, RH], kind: 'up', title: 'ENSRegistry', tag: 'UPGRADEABLE',
    body: 'owner and resolver of every node;\nsetApprovalForAll,\nsetApprovalForAllWithSig' },
  policy: { at: [COL[0], ROW_B], size: [CW, RH], kind: 'up', title: 'SimplexNamePolicy', tag: 'UPGRADEABLE',
    body: 'reserved and community names;\ngeneral and community terms;\nacceptances; registerReserved;\nowner: the controller\'s owner' },
  registrar: { at: [COL[1], ROW_B], size: [CW, RH], kind: 'up', title: 'BaseRegistrarImplementation', tag: 'UPGRADEABLE',
    body: 'ERC-721 of 2LDs, expiries, labels;\noffer and claim, approveWithSig,\nclaimWithSig; owner: admin Safe' },
  subnames: { at: [COL[2], ROW_B], size: [CW, RH], kind: 'up', title: 'SubnameRegistrar', tag: 'UPGRADEABLE',
    body: 'subnames, soulbound to the 2LD;\ncreateSubname, createSubnameWithSig,\ndeleteSubname, purge' },
  renderer: { at: [450, 1420], size: [370, 120], kind: 'fixed', title: 'MetadataRenderer', tag: 'IMMUTABLE · setMetadataRenderer swaps it',
    body: 'tokenURI: on-chain JSON and SVG' },
  dapp: { at: [960, 1420], size: [370, 170], kind: 'client', title: 'dApp — simplex-app', tag: 'OFF-CHAIN',
    body: "ENS app v3 fork; the user's wallet\nsigns and pays: register, terms,\nrecords, offer and claim, subnames;\nresolves through UniversalResolver" },
  wallets: { at: [1470, 1420], size: [370, 110], kind: 'client', title: 'Wallets and marketplaces', tag: 'OFF-CHAIN',
    body: 'ERC-721 view of each name' },
  universal: { at: [1520, 480], size: [320, 130], kind: 'up', title: 'UniversalResolver', tag: 'UPGRADEABLE',
    body: 'resolve(name, data)' },
  gateway: { at: [1990, 480], size: [340, 100], kind: 'fixed', title: 'DummyGatewayProvider', tag: 'IMMUTABLE', body: 'gateways()' },
  root: { at: [1990, 620], size: [340, 130], kind: 'fixed', title: 'Root', tag: 'IMMUTABLE',
    body: 'owns the registry root;\nlock(simplex) at GOV9;\nowner: admin Safe' },
  adminSafe: { at: [1990, 790], size: [340, 150], kind: 'gov', title: 'admin Safe — 2 of 4', tag: 'GOVERNANCE',
    body: 'owns the eight ProxyAdmins, the\ncontroller, registrar, oracle and Root;\n7-day timelock in front from GOV8' },
  guardian: { at: [1990, 970], size: [340, 150], kind: 'gov', title: 'guardian Safe', tag: 'GOVERNANCE · 1 of 4, 2 of 4 from GOV7',
    body: 'controller beneficiary: revenue,\nsetRegistrarAllowance,\nsetPublicSalesOpen, addReservedNames' },
  proxyAdmins: { at: [1990, 1150], size: [340, 160], kind: 'gov', title: '8 × ProxyAdmin', tag: 'UPGRADE AUTHORITY',
    body: 'one per upgradeable contract (blue),\ncreated by its proxy;\nupgradeAndCall upgrades it;\nrenounceOwnership freezes it' },
}

const ZONE = { at: [420, 710], size: [1450, 670],
  label: 'CORE · UPGRADEABLE UNTIL FROZEN', labelAt: [868, 712] }

const ARROWS = [
  ['webstore', 'storesvc', 'HTTPS /api: search, order,\npay, signed RegisterName,\nlink edits', { from: [220, 200], to: [220, 290] }],
  ['app', 'storesvc', 'SMP: purchases,\nsigned RegisterName', { from: [470, 200], to: [470, 290] }],
  ['app', 'snrcres', 'SMP: name lookup', { from: [760, 200], to: [1000, 290] }],
  ['storesvc', 'sponsor', 'registerWithCredit', { from: [205, 470], to: [205, 520] }],
  ['storesvc', 'controller', 'commit', { from: [470, 470], to: [560, 760], t: 0.35 }],
  ['storesvc', 'resolver', 'setTextWithSig,\nclearRecordsWithSig,\nmulticall of two', { from: [500, 420], to: [1010, 760], t: 0.5 }],
  ['snrcres', 'resolver', 'text(simplex.contact,\nsimplex.channel)', { from: [1120, 430], to: [1120, 760], t: 0.62 }],
  ['snrcres', 'registry', 'resolver(node)', { from: [1290, 430], to: [1560, 760], t: 0.62 }],
  ['sponsor', 'controller', 'registerSponsored,\nrenewSponsored', { from: [370, 620], to: [470, 790], t: 0.45 }],
  ['controller', 'oracle', 'price,\npriceUSD', { from: [450, 830], to: [370, 830] }],
  ['oracle', 'chainlink', 'latestAnswer', { from: [205, 900], to: [205, 940] }],
  ['controller', 'resolver', 'multicallWith-\nNodeCheck,\nclearRecords', { from: [820, 860], to: [960, 860] }],
  ['controller', 'registry', 'setRecord', { points: [[640, 760], [640, 742], [1700, 742], [1700, 760]], t: 0.72 }],
  ['controller', 'policy', 'consumeRegistration,\nisReserved', { from: [560, 990], to: [560, 1110] }],
  ['controller', 'registrar', 'registerWithLabel,\nrenew, transferFrom', { from: [790, 990], to: [1010, 1110], t: 0.5 }],
  ['resolver', 'registry', 'owner(node)', { from: [1330, 860], to: [1470, 860] }],
  ['subnames', 'resolver', 'ownerOf (nameWrapper) ⇄\nclearSubnameRecords', { from: [1520, 1110], to: [1280, 990], t: 0.2, both: true }],
  ['registrar', 'registry', 'setSubnodeOwner', { from: [1250, 1110], to: [1560, 990], t: 0.8 }],
  ['subnames', 'registry', 'setSubnodeRecord', { from: [1760, 1110], to: [1760, 990] }],
  ['policy', 'registrar', 'registerReserved', { from: [820, 1180], to: [960, 1180] }],
  ['registrar', 'policy', 'consumeTransfer', { from: [960, 1270], to: [820, 1270] }],
  ['registrar', 'subnames', 'onReregister,\nonExpiryChanged', { from: [1330, 1220], to: [1470, 1220] }],
  ['registrar', 'renderer', 'tokenURI', { from: [970, 1340], to: [700, 1420], t: 0.75 }],
  ['wallets', 'registrar', 'ownerOf,\ntokenURI', { from: [1490, 1420], to: [1300, 1340], t: 0.12 }],
  ['dapp', 'registrar', 'offer, claim', { from: [1100, 1420], to: [1100, 1340] }],
  ['dapp', 'policy', 'accept terms', { from: [990, 1420], to: [800, 1340], t: 0.3 }],
  ['dapp', 'subnames', 'createSubname, deleteSubname\n(after setApprovalForAll\non the registry)', { from: [1310, 1420], to: [1520, 1340], t: 0.82 }],
  ['dapp', 'controller', 'commit, register,\nrenew (payable)', { points: [[960, 1460], [890, 1460], [890, 1040], [770, 990]], t: 0.34 }],
  ['dapp', 'resolver', 'setText', { points: [[1330, 1460], [1400, 1460], [1400, 950], [1330, 950]], t: 0.55 }],
  ['dapp', 'universal', 'resolve', { points: [[1330, 1570], [1910, 1570], [1910, 545], [1840, 545]], t: 0.38 }],
  ['universal', 'resolver', 'resolve', { from: [1540, 610], to: [1250, 760], t: 0.4 }],
  ['universal', 'registry', 'findResolver', { from: [1760, 610], to: [1760, 760] }],
  ['universal', 'gateway', 'gateways()', { from: [1840, 520], to: [1990, 520] }],
  ['root', 'registry', 'owner of the\nroot node', { from: [1990, 700], to: [1840, 800], t: 0.4 }],
  ['adminSafe', 'proxyAdmins', 'owner', { points: [[2330, 865], [2365, 865], [2365, 1230], [2330, 1230]], t: 0.5 }],
  ['proxyAdmins', 'zone', 'upgradeAndCall,\nrenounceOwnership\n(also sponsor and\nUniversalResolver)', { from: [1990, 1300], to: [1870, 1300], t: 0.5, dy: -50 }],
]

const TITLE = '.simplex v2 — goal architecture'
const LEGEND = [
  ['up', 'upgradeable: own proxy and ProxyAdmin'],
  ['fixed', 'immutable, swappable without downtime'],
  ['zone', 'dashed: the core whose swap interrupts users'],
  ['client', 'off-chain: users\' clients'],
  ['service', 'off-chain: SimpleX services'],
  ['gov', 'governance'],
  ['external', 'external'],
]
const LEGEND_AT = [1990, 1350]

const W = 2400
const H = 1620

const lines = (s) => (s ? s.split('\n') : [])
const textWidth = (s, size) => Math.max(0, ...lines(s).map((l) => l.length)) * size * 0.56

const pathOf = ([, , , o]) => o.points ?? [o.from, o.to]
const along = (pts, t) => {
  const seg = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]))
  let d = seg.reduce((a, b) => a + b, 0) * t
  for (let i = 0; i < seg.length; i++) {
    if (d <= seg[i]) {
      const r = seg[i] ? d / seg[i] : 0
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * r, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * r]
    }
    d -= seg[i]
  }
  return pts.at(-1)
}

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
  for (const a of ARROWS) {
    const pts = pathOf(a)
    out.push(`<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="#374151" stroke-width="1.6"/>`)
    out.push(head(pts.at(-2), pts.at(-1)))
    if (a[3].both) out.push(head(pts[1], pts[0]))
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
  for (const a of ARROWS) {
    const [ax, ay] = along(pathOf(a), a[3].t ?? 0.5)
    const mx = ax + (a[3].dx ?? 0), my = ay + (a[3].dy ?? 0)
    const ls = lines(a[2])
    const w = textWidth(a[2], 12) + 10, h = ls.length * 15 + 6
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
  const seed = () => Math.floor(Math.random() * 2 ** 31)
  const base = (over) => ({
    id: id('el'), angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: 1, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null,
    seed: seed(), version: 1, versionNonce: seed(), isDeleted: false, boundElements: null, updated: 1,
    link: null, locked: false, ...over,
  })
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
  for (const a of ARROWS) {
    const [from, to, label, o] = a
    const pts = pathOf(a)
    const [x0, y0] = pts[0]
    const rel = pts.map(([x, y]) => [x - x0, y - y0])
    const xs = rel.map((p) => p[0]), ys = rel.map((p) => p[1])
    const ar = base({ id: id('arrow'), type: 'arrow', x: x0, y: y0, width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys), strokeColor: '#374151', roundness: null, points: rel,
      lastCommittedPoint: null, startBinding: { elementId: rects[from].id, focus: 0, gap: 2 },
      endBinding: { elementId: rects[to].id, focus: 0, gap: 2 }, startArrowhead: o.both ? 'arrow' : null,
      endArrowhead: 'arrow', elbowed: false, boundElements: [] })
    els.push(ar)
    rects[from].boundElements.push({ id: ar.id, type: 'arrow' })
    rects[to].boundElements.push({ id: ar.id, type: 'arrow' })
    const [mx, my] = along(pts, o.t ?? 0.5)
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
