import { writeFileSync } from 'fs'

const C = {
  up: { fill: '#dbeafe', stroke: '#1d4ed8' },
  fixed: { fill: '#f3f4f6', stroke: '#4b5563' },
  client: { fill: '#ede9fe', stroke: '#6d28d9' },
  service: { fill: '#fae8ff', stroke: '#a21caf' },
  external: { fill: '#fef3c7', stroke: '#b45309' },
  gov: { fill: '#dcfce7', stroke: '#15803d' },
  frame: { fill: '#f8fafc', stroke: '#1d4ed8' },
}
const INK = '#111827'
const MUTED = '#4b5563'
const LINE = '#4b5563'
const DASH = '6 4'
const FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif'
const W = 960
const BOX_H = 52

const VIEWS = {
  system: {
    title: 'System — who uses the .simplex contracts',
    height: 600,
    frame: { at: [24, 296], size: [912, 132], label: '.simplex contracts' },
    boxes: {
      webstore: { at: [112, 52], w: 280, kind: 'client', title: 'Webstore — simplex.domains', role: 'buys names, edits links' },
      app: { at: [640, 52], w: 248, kind: 'client', title: 'SimpleX app', role: 'finds names, opens the webstore' },
      storesvc: { at: [112, 176], w: 280, kind: 'service', title: 'StoreService', role: 'pays gas from its sponsor allowance' },
      snrcres: { at: [640, 176], w: 248, kind: 'service', title: 'Resolver service', role: 'answers name lookups over SMP' },
      registration: { at: [44, 336], w: 272, kind: 'up', title: 'Registration', role: 'controller, name policy, sponsor' },
      records: { at: [344, 336], w: 272, kind: 'up', title: 'Records', role: 'resolver, universal resolver' },
      names: { at: [644, 336], w: 272, kind: 'up', title: 'Names', role: 'registry, NFT registrar, subnames' },
      dapp: { at: [344, 496], w: 272, kind: 'client', title: 'dApp — app.simplex.domains', role: 'the user\'s own wallet' },
      wallets: { at: [680, 496], w: 236, kind: 'client', title: 'Wallets and marketplaces', role: 'names as NFTs' },
    },
    arrows: [
      ['app', 'snrcres', 'name lookup (SMP)', { at: [760, 140], points: [[760, 104], [760, 176]] }],
      ['app', 'webstore', 'opens to buy a name', { at: [516, 70], points: [[640, 70], [392, 70]] }],
      ['app', 'storesvc', 'planned: buy names\nin the app', { at: [500, 140], points: [[640, 92], [500, 92], [500, 188], [392, 188]], planned: true }],
      ['webstore', 'storesvc', 'orders, payment,\nsigned requests', { at: [242, 140], points: [[242, 104], [242, 176]] }],
      ['storesvc', 'registration', 'registers names,\nsponsored', { at: [200, 262], points: [[200, 228], [200, 336]] }],
      ['storesvc', 'records', 'writes signed\nrecord edits', { at: [372, 262], points: [[372, 228], [372, 336]] }],
      ['storesvc', 'names', 'planned: transfers,\nsubnames', { at: [481, 220], points: [[392, 220], [570, 220], [570, 276], [690, 276], [690, 336]], planned: true }],
      ['snrcres', 'names', 'reads owners,\nexpiry', { at: [820, 262], points: [[820, 228], [820, 336]] }],
      ['snrcres', 'records', 'reads records', { at: [590, 316], points: [[640, 214], [590, 214], [590, 336]] }],
      ['dapp', 'registration', 'registers, renews\n(pays ETH)', { at: [262, 522], points: [[344, 522], [180, 522], [180, 388]] }],
      ['dapp', 'names', 'offers, claims,\nsubnames', { at: [660, 458], points: [[616, 522], [660, 522], [660, 388]] }],
      ['dapp', 'records', 'edits and resolves\nrecords', { at: [480, 458], points: [[480, 496], [480, 388]] }],
      ['wallets', 'names', 'ERC-721', { at: [860, 458], points: [[860, 496], [860, 388]] }],
    ],
    legend: [['client', 'client'], ['service', 'SimpleX service'], ['up', 'contracts'], ['planned', 'planned']],
  },
  contracts: {
    title: 'Contracts — how they call each other',
    height: 600,
    frame: { at: [16, 120], size: [928, 336], label: 'upgradeable until frozen', dashed: true },
    boxes: {
      oracle: { at: [420, 44], w: 180, kind: 'fixed', title: 'SimplexPriceOracle', role: 'prices in US cents' },
      chainlink: { at: [744, 44], w: 180, kind: 'external', title: 'Chainlink ETH/USD', role: 'price feed' },
      policy: { at: [36, 152], w: 240, kind: 'up', title: 'SimplexNamePolicy', role: 'reserved names, terms' },
      controller: { at: [420, 152], w: 180, kind: 'up', title: 'SimplexController', role: 'registers and renews' },
      sponsor: { at: [744, 152], w: 180, kind: 'up', title: 'SimplexSponsor', role: 'registrar allowances' },
      registrar: { at: [36, 268], w: 240, kind: 'up', title: 'BaseRegistrarImplementation', role: 'NFT registrar' },
      subnames: { at: [420, 268], w: 180, kind: 'up', title: 'SubnameRegistrar', role: 'subnames of a name' },
      resolver: { at: [744, 268], w: 180, kind: 'up', title: 'SimplexResolver', role: 'records of each name' },
      registry: { at: [420, 384], w: 180, kind: 'up', title: 'ENSRegistry', role: 'owner and resolver' },
      universal: { at: [744, 384], w: 180, kind: 'up', title: 'UniversalResolver', role: 'resolution for apps' },
      renderer: { at: [36, 492], w: 240, kind: 'fixed', title: 'MetadataRenderer', role: 'NFT image and metadata' },
    },
    arrows: [
      ['sponsor', 'controller', 'sponsored\nregistration', { at: [672, 172], points: [[744, 172], [600, 172]] }],
      ['controller', 'policy', 'reservations,\nterms, commits', { at: [348, 178], points: [[420, 178], [276, 178]], both: true }],
      ['controller', 'oracle', 'price', { at: [510, 136], points: [[510, 152], [510, 96]] }],
      ['oracle', 'chainlink', 'ETH/USD', { at: [672, 70], points: [[600, 70], [744, 70]] }],
      ['controller', 'registrar', 'registers,\nrenews', { at: [328, 236], points: [[436, 204], [436, 236], [220, 236], [220, 268]] }],
      ['controller', 'resolver', 'first records', { at: [687, 236], points: [[584, 204], [584, 236], [790, 236], [790, 268]] }],
      ['registrar', 'policy', 'transfer check,\nreserved names', { at: [100, 236], points: [[100, 268], [100, 204]], both: true }],
      ['registrar', 'registry', 'sets the\nname\'s owner', { at: [335, 410], points: [[250, 320], [250, 410], [420, 410]] }],
      ['registrar', 'subnames', 're-registration,\nexpiry', { at: [348, 294], points: [[276, 294], [420, 294]] }],
      ['registrar', 'renderer', 'NFT metadata', { at: [100, 410], points: [[100, 320], [100, 492]] }],
      ['subnames', 'registry', 'creates\nsubnames', { at: [510, 352], points: [[510, 320], [510, 384]] }],
      ['resolver', 'subnames', 'subname owner,\nclears records', { at: [672, 284], points: [[744, 284], [600, 284]], both: true }],
      ['resolver', 'registry', 'checks\nthe owner', { at: [635, 360], points: [[744, 312], [690, 312], [690, 360], [580, 360], [580, 384]] }],
      ['universal', 'registry', 'finds the\nresolver', { at: [672, 420], points: [[744, 420], [600, 420]] }],
      ['universal', 'resolver', 'reads\nrecords', { at: [834, 352], points: [[834, 384], [834, 320]] }],
    ],
    legend: [['up', 'upgradeable'], ['fixed', 'immutable, swappable'], ['external', 'external']],
  },
  governance: {
    title: 'Governance — who controls what',
    height: 600,
    frame: { at: [24, 260], size: [920, 204], label: 'upgradeable contracts' },
    boxes: {
      root: { at: [24, 44], w: 190, kind: 'fixed', title: 'Root', role: 'owns the registry root' },
      timelock: { at: [570, 44], w: 180, kind: 'gov', title: 'Timelock', role: '7 days, from GOV8', planned: true },
      oracle: { at: [24, 152], w: 190, kind: 'fixed', title: 'SimplexPriceOracle', role: 'prices in US cents' },
      adminSafe: { at: [330, 152], w: 180, kind: 'gov', title: 'admin Safe', role: '2 of 4' },
      proxyAdmins: { at: [708, 152], w: 228, kind: 'gov', title: '8 × ProxyAdmin', role: 'one per upgradeable contract' },
      policy: { at: [60, 292], w: 180, kind: 'up', title: 'SimplexNamePolicy', role: 'reserved names, terms' },
      registrar: { at: [330, 292], w: 240, kind: 'up', title: 'BaseRegistrarImplementation', role: 'NFT registrar' },
      controller: { at: [640, 292], w: 180, kind: 'up', title: 'SimplexController', role: 'registers and renews' },
      sponsor: { at: [330, 396], w: 180, kind: 'up', title: 'SimplexSponsor', role: 'registrar allowances' },
      others: { at: [696, 396], w: 232, kind: 'up', title: 'the other four', role: 'registry, subnames, resolvers' },
      guardian: { at: [330, 512], w: 200, kind: 'gov', title: 'guardian Safe', role: '1 of 4, 2 of 4 from GOV7' },
    },
    arrows: [
      ['adminSafe', 'proxyAdmins', 'upgrades, freezes\n(until GOV8)', { at: [609, 178], points: [[510, 178], [708, 178]] }],
      ['adminSafe', 'timelock', 'planned: schedules,\nfrom GOV8', { at: [480, 111], points: [[480, 152], [480, 70], [570, 70]], planned: true }],
      ['timelock', 'proxyAdmins', 'planned: executes\nafter 7 days', { at: [830, 111], points: [[750, 70], [830, 70], [830, 152]], planned: true }],
      ['proxyAdmins', 'frame', 'replaces the code', { at: [880, 232], points: [[880, 204], [880, 260]] }],
      ['adminSafe', 'controller', 'settings, pointers', { at: [600, 236], points: [[500, 204], [500, 236], [700, 236], [700, 292]] }],
      ['adminSafe', 'policy', 'brand names,\nterms', { at: [280, 236], points: [[350, 204], [350, 236], [210, 236], [210, 292]] }],
      ['adminSafe', 'registrar', 'controllers,\nmetadata', { at: [440, 236], points: [[440, 204], [440, 292]] }],
      ['adminSafe', 'oracle', 'prices, feed', { at: [272, 178], points: [[330, 178], [214, 178]] }],
      ['adminSafe', 'root', 'TLD, lock', { at: [282, 70], points: [[350, 152], [350, 70], [214, 70]] }],
      ['guardian', 'controller', 'pauses sales,\nreceives revenue', { at: [660, 370], points: [[530, 538], [660, 538], [660, 344]], both: true }],
      ['guardian', 'sponsor', 'registrar allowance', { at: [420, 480], points: [[420, 512], [420, 448]] }],
      ['guardian', 'policy', 'reserves names', { at: [150, 420], points: [[330, 538], [150, 538], [150, 344]] }],
    ],
    legend: [['gov', 'governance'], ['up', 'upgradeable'], ['fixed', 'immutable'], ['planned', 'planned']],
  },
}

const lines = (s) => s.split('\n')
const textWidth = (s, size, bold = false) => Math.max(...lines(s).map((l) => l.length)) * size * (bold ? 0.6 : 0.55)
const labelBox = (label, [cx, cy]) => {
  const w = textWidth(label, 13) + 12, h = lines(label).length * 16 + 6
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}
const legendItems = (view) => {
  let x = 24
  return view.legend.map(([kind, text]) => {
    const item = { kind, text, x }
    x += 28 + textWidth(text, 13) + 24
    return item
  })
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function svg(view) {
  const H = view.height
  const out = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}" role="img" aria-label="${esc(view.title)}">`)
  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`)
  out.push(`<text class="title" x="24" y="28" font-size="16" font-weight="600" fill="${INK}">${esc(view.title)}</text>`)
  const f = view.frame
  out.push(`<rect class="frame" x="${f.at[0]}" y="${f.at[1]}" width="${f.size[0]}" height="${f.size[1]}" rx="12" fill="${C.frame.fill}" stroke="${C.frame.stroke}" stroke-width="1.5"${f.dashed ? ` stroke-dasharray="${DASH}"` : ''}/>`)
  out.push(`<text class="frame-label" x="${f.at[0] + 16}" y="${f.at[1] + 18}" font-size="13" font-weight="600" fill="${C.frame.stroke}">${esc(f.label)}</text>`)
  const head = ([x1, y1], [x2, y2]) => {
    const len = Math.hypot(x2 - x1, y2 - y1)
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len
    const bx = x2 - ux * 9, by = y2 - uy * 9
    return `<polygon class="head" points="${x2},${y2} ${bx - uy * 4},${by + ux * 4} ${bx + uy * 4},${by - ux * 4}" fill="${LINE}"/>`
  }
  for (const [, , , { points, planned, both }] of view.arrows) {
    out.push(`<polyline class="arrow" points="${points.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${LINE}" stroke-width="1.5"${planned ? ` stroke-dasharray="${DASH}"` : ''}/>`)
    out.push(head(points.at(-2), points.at(-1)))
    if (both) out.push(head(points[1], points[0]))
  }
  for (const b of Object.values(view.boxes)) {
    const [x, y] = b.at, c = C[b.kind]
    out.push(`<rect class="box" x="${x}" y="${y}" width="${b.w}" height="${BOX_H}" rx="8" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"${b.planned ? ` stroke-dasharray="${DASH}"` : ''}/>`)
    out.push(`<text x="${x + 12}" y="${y + 22}" font-size="15" font-weight="600" fill="${INK}">${esc(b.title)}</text>`)
    out.push(`<text x="${x + 12}" y="${y + 41}" font-size="13" fill="${MUTED}">${esc(b.role)}</text>`)
  }
  for (const [, , label, { at }] of view.arrows) {
    const r = labelBox(label, at)
    out.push(`<rect class="label" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="4" fill="#ffffff"/>`)
    lines(label).forEach((l, i) => out.push(`<text x="${at[0]}" y="${r.y + 15 + i * 16}" font-size="13" text-anchor="middle" fill="${INK}">${esc(l)}</text>`))
  }
  const ly = H - 22
  for (const { kind, text, x } of legendItems(view)) {
    if (kind === 'planned') out.push(`<line class="legend" x1="${x}" y1="${ly}" x2="${x + 20}" y2="${ly}" stroke="${LINE}" stroke-width="1.5" stroke-dasharray="${DASH}"/>`)
    else out.push(`<rect class="legend" x="${x}" y="${ly - 7}" width="20" height="14" rx="3" fill="${C[kind].fill}" stroke="${C[kind].stroke}" stroke-width="1.5"/>`)
    out.push(`<text class="legend" x="${x + 28}" y="${ly + 5}" font-size="13" fill="${MUTED}">${esc(text)}</text>`)
  }
  out.push('</svg>')
  return out.join('\n')
}

function excalidraw(name, view) {
  let n = 0
  const id = (p) => `${name}-${p}-${++n}`
  const seed = (text) => {
    let h = 0x811c9dc5
    for (const c of text) h = Math.imul(h ^ c.codePointAt(0), 0x01000193) >>> 0
    return h % 2 ** 31
  }
  const base = (over) => {
    const el = {
      id: id('el'), angle: 0, strokeColor: INK, backgroundColor: 'transparent', fillStyle: 'solid',
      strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null,
      seed: 0, version: 1, versionNonce: 0, isDeleted: false, boundElements: null, updated: 1,
      link: null, locked: false, ...over,
    }
    el.seed = seed(el.id)
    el.versionNonce = seed(`${el.id}/versionNonce`)
    return el
  }
  const els = []
  const shapes = {}
  const text = (x, y, str, size, extra = {}) => els.push(base({
    type: 'text', x, y, width: textWidth(str, size), height: lines(str).length * size * 1.25, text: str,
    fontSize: size, fontFamily: 2, textAlign: 'left', verticalAlign: 'top', containerId: null,
    originalText: str, autoResize: true, lineHeight: 1.25, ...extra,
  }))
  text(24, 12, view.title, 16)
  const f = view.frame
  shapes.frame = base({ id: `${name}-frame`, type: 'rectangle', x: f.at[0], y: f.at[1], width: f.size[0], height: f.size[1],
    backgroundColor: C.frame.fill, strokeColor: C.frame.stroke, strokeStyle: f.dashed ? 'dashed' : 'solid',
    strokeWidth: 1, roundness: { type: 3 }, boundElements: [] })
  els.push(shapes.frame)
  text(f.at[0] + 16, f.at[1] + 6, f.label, 13, { strokeColor: C.frame.stroke })
  for (const [key, b] of Object.entries(view.boxes)) {
    const c = C[b.kind], gid = `${name}-grp-${key}`
    shapes[key] = base({ id: `${name}-box-${key}`, type: 'rectangle', x: b.at[0], y: b.at[1], width: b.w, height: BOX_H,
      backgroundColor: c.fill, strokeColor: c.stroke, strokeStyle: b.planned ? 'dashed' : 'solid', strokeWidth: 1,
      roundness: { type: 3 }, groupIds: [gid], boundElements: [] })
    els.push(shapes[key])
    text(b.at[0] + 12, b.at[1] + 8, b.title, 15, { groupIds: [gid] })
    text(b.at[0] + 12, b.at[1] + 29, b.role, 13, { strokeColor: MUTED, groupIds: [gid] })
  }
  for (const [from, to, label, { at, points, planned, both }] of view.arrows) {
    const [x0, y0] = points[0]
    const rel = points.map(([x, y]) => [x - x0, y - y0])
    const xs = rel.map((p) => p[0]), ys = rel.map((p) => p[1])
    const ar = base({ id: id('arrow'), type: 'arrow', x: x0, y: y0, width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys), strokeColor: LINE, strokeStyle: planned ? 'dashed' : 'solid',
      roundness: null, points: rel, lastCommittedPoint: null,
      startBinding: { elementId: shapes[from].id, focus: 0, gap: 1 }, endBinding: { elementId: shapes[to].id, focus: 0, gap: 1 },
      startArrowhead: both ? 'triangle' : null, endArrowhead: 'triangle', elbowed: false, boundElements: [] })
    els.push(ar)
    shapes[from].boundElements.push({ id: ar.id, type: 'arrow' })
    shapes[to].boundElements.push({ id: ar.id, type: 'arrow' })
    const r = labelBox(label, at)
    const t = base({ id: id('label'), type: 'text', x: r.x + 6, y: r.y + 3, width: r.w - 12, height: r.h - 6, text: label,
      fontSize: 13, fontFamily: 2, textAlign: 'center', verticalAlign: 'middle', containerId: ar.id,
      originalText: label, autoResize: true, lineHeight: 1.23 })
    els.push(t)
    ar.boundElements.push({ id: t.id, type: 'text' })
  }
  const ly = view.height - 22
  for (const { kind, text: str, x } of legendItems(view)) {
    if (kind === 'planned') els.push(base({ type: 'line', x, y: ly, width: 20, height: 0, strokeColor: LINE, strokeStyle: 'dashed',
      roundness: null, points: [[0, 0], [20, 0]], lastCommittedPoint: null, startBinding: null, endBinding: null,
      startArrowhead: null, endArrowhead: null }))
    else els.push(base({ type: 'rectangle', x, y: ly - 7, width: 20, height: 14, backgroundColor: C[kind].fill,
      strokeColor: C[kind].stroke, roundness: { type: 3 } }))
    text(x + 28, ly - 8, str, 13, { strokeColor: MUTED })
  }
  return { type: 'excalidraw', version: 2, source: 'snrc-architecture-generator', elements: els,
    appState: { gridSize: null, viewBackgroundColor: '#ffffff' }, files: {} }
}

const dir = new URL('.', import.meta.url).pathname
for (const [name, view] of Object.entries(VIEWS)) {
  writeFileSync(`${dir}architecture-simplex-v2-${name}.svg`, svg(view))
  writeFileSync(`${dir}architecture-simplex-v2-${name}.excalidraw`, JSON.stringify(excalidraw(name, view), null, 1))
  console.log(name, 'boxes:', Object.keys(view.boxes).length, 'arrows:', view.arrows.length)
}
