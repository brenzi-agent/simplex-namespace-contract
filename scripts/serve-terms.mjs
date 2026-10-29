#!/usr/bin/env node
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { createServer } from 'http'
import { dirname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const PORT = 8097
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'terms')
const FILE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*\.md$/

export const localTermsLink = (file) =>
  `http://127.0.0.1:${PORT}/${file}#sha256=${createHash('sha256').update(readFileSync(join(DIR, file))).digest('hex')}`

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  createServer(async (request, response) => {
    const file = request.url.slice(1)
    const cors = { 'Access-Control-Allow-Origin': '*' }
    const body = request.method === 'GET' && FILE.test(file)
      ? await readFile(join(DIR, file)).catch(() => null)
      : null
    if (!body) response.writeHead(404, cors).end()
    else response.writeHead(200, { ...cors, 'Content-Type': 'text/markdown; charset=utf-8' }).end(body)
  }).listen(PORT, '127.0.0.1', () => console.log(`terms at http://127.0.0.1:${PORT}/`))
}
