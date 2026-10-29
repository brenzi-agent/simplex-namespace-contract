#!/usr/bin/env node
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { pathToFileURL } from 'url'

const REPO = 'simplex-chat/simplex-chat'
const HOSTS = [`https://git.simplex.chat/${REPO}.git`, `https://github.com/${REPO}.git`]
const TAG_PREFIX = { general: 'general-terms-v', community: 'community-terms-v' }
const MAX_BYTES = 256 * 1024
const LINK =
  /^https:\/\/git\.simplex\.chat\/simplex-chat\/simplex-chat\/raw\/commit\/([0-9a-f]{40})\/([A-Za-z0-9_./-]+\.md)#sha256=([0-9a-f]{64})$/
const TEXT_TYPE = /^text\/(plain|markdown)\s*(;\s*charset=utf-8\s*)?$/i

export function parseTermsLink(link) {
  const match = LINK.exec(link)
  if (!match) throw new Error(`not a terms link: ${link}`)
  const [, sha, path, digest] = match
  if (path.split('/').some((segment) => ['', '.', '..'].includes(segment)))
    throw new Error(`not a terms path: ${path}`)
  return { sha, path, digest }
}

function taggedCommits(host, role) {
  const prefix = `refs/tags/${TAG_PREFIX[role]}`
  const peeled = new Map(
    execFileSync('git', ['ls-remote', host, 'refs/tags/*terms-v*'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
      .filter(([, ref]) => ref.startsWith(prefix))
      .map(([sha, ref]) => [ref.replace(/\^\{\}$/, ''), sha]),
  )
  return new Set(peeled.values())
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

export async function checkTermsLink(role, link) {
  if (!TAG_PREFIX[role]) throw new Error(`the role is general or community, not ${role}`)
  const { sha, path, digest } = parseTermsLink(link)
  for (const host of HOSTS)
    if (!taggedCommits(host, role).has(sha))
      throw new Error(`${host}: no ${TAG_PREFIX[role]}* tag points at ${sha}`)
  const forgejo = await fetchTerms(link.slice(0, link.indexOf('#')))
  const github = await fetchTerms(`https://raw.githubusercontent.com/${REPO}/${sha}/${path}`)
  if (!forgejo.equals(github)) throw new Error(`the hosts serve different bytes for ${path}`)
  const actual = createHash('sha256').update(forgejo).digest('hex')
  if (actual !== digest) throw new Error(`sha256 of ${path} is ${actual}, the link says ${digest}`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [role, link] = process.argv.slice(2)
  checkTermsLink(role, link).then(
    () => console.log(`✓ ${role} terms: ${link}`),
    (err) => {
      console.error(`✗ ${err.message}`)
      process.exit(1)
    },
  )
}
