#!/usr/bin/env node
import { createHash } from 'crypto'
import { pathToFileURL } from 'url'

const MAX_BYTES = 256 * 1024
const LINK =
  /^https:\/\/raw\.githubusercontent\.com\/simplex-chat\/simplex-chat\/[0-9a-f]{40}\/([A-Za-z0-9_./-]+\.md)#sha256=([0-9a-f]{64})$/
const TEXT_TYPE = /^text\/(plain|markdown)\s*(;\s*charset=utf-8\s*)?$/i

export function parseTermsLink(link) {
  const match = LINK.exec(link)
  if (!match) throw new Error(`not a terms link: ${link}`)
  const [, path, digest] = match
  if (path.split('/').some((segment) => ['', '.', '..'].includes(segment)))
    throw new Error(`not a terms path: ${path}`)
  return { path, digest }
}

async function fetchTerms(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(url, { redirect: 'manual' })
    if (response.status === 429) {
      await new Promise((r) => setTimeout(r, 1000 * (Number(response.headers.get('retry-after')) || 3)))
      continue
    }
    if (response.status !== 200) throw new Error(`${url}: HTTP ${response.status}`)
    const type = response.headers.get('content-type') ?? ''
    if (!TEXT_TYPE.test(type)) throw new Error(`${url}: content type ${type}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAX_BYTES) throw new Error(`${url}: ${bytes.length} bytes`)
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return bytes
  }
  throw new Error(`${url}: still rate limited`)
}

export async function checkTermsLink(link) {
  const { path, digest } = parseTermsLink(link)
  const bytes = await fetchTerms(link.slice(0, link.indexOf('#')))
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== digest) throw new Error(`sha256 of ${path} is ${actual}, the link says ${digest}`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [role, link] = process.argv.slice(2)
  checkTermsLink(link).then(
    () => console.log(`✓ ${role} terms: ${link}`),
    (err) => {
      console.error(`✗ ${err.message}`)
      process.exit(1)
    },
  )
}
