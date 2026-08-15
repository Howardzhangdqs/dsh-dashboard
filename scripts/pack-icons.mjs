#!/usr/bin/env node
/**
 * Pack the Material Icon Theme into the plugin's gzip-stored asset.
 *
 * Source: the official VSIX release of
 *   https://github.com/material-extensions/vscode-material-icon-theme
 * (MIT license). The VSIX carries BOTH halves we need:
 *   - dist/material-icons.json — the compiled VSCode icon-theme mapping
 *     (fileExtensions / fileNames / folderNames / folderNamesExpanded /
 *     defaults), already case-folded and pattern-expanded;
 *   - icons/*.svg — the 1250 rasterized icon files (including the 296
 *     generated folder-*-open variants that do not exist in the repo).
 *
 * Output: assets/icons.json.gz — ONE gzip member (~360KB) containing
 *   { file, folder, folderOpen, ext, fileNames, folderNames,
 *     folderNamesExpanded, icons: {name: svgText} }
 * served by the host's /sidebar/bundle route with Content-Encoding: gzip
 * (the browser decompresses natively) and consumed by
 * src/client/file-icons.ts on first explorer render.
 *
 * Usage:
 *   node scripts/pack-icons.mjs <path-to.vsix | extracted-extension-dir>
 *   node scripts/pack-icons.mjs            # repack from assets/material-src
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ASSETS = join(ROOT, 'assets')
const OUT = join(ASSETS, 'icons.json.gz')

/** argv[2]: a .vsix file, an extracted extension dir, or missing = assets/material-src. */
const source = process.argv[2] ?? join(ASSETS, 'material-src')

async function main() {
  const { mapping, iconsDir } = await locateSource(source)
  const available = new Set(
    (await readdir(iconsDir)).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)),
  )
  const allIds = collectDefinitionIds(mapping)
  const defIds = allIds.filter((id) => available.has(id))
  const dropped = allIds.length - defIds.length
  const icons = {}
  for (const id of defIds) {
    icons[id] = await readFile(join(iconsDir, `${id}.svg`), 'utf8')
  }
  // Strip mapping entries whose icon file the release did not ship (optional
  // icon-pack glyphs like angular-*): a table hit must always have an SVG.
  const strip = (table) => {
    if (table === null || typeof table !== 'object') return table
    const out = {}
    for (const [key, id] of Object.entries(table)) {
      if (typeof id === 'string' && available.has(id)) out[key] = id
    }
    return out
  }
  const pack = {
    file: available.has(mapping.file) ? mapping.file : 'file',
    folder: available.has(mapping.folder) ? mapping.folder : 'folder',
    folderOpen: available.has(mapping.folderExpanded) ? mapping.folderExpanded : 'folder-open',
    ext: strip(mapping.fileExtensions),
    fileNames: strip(mapping.fileNames),
    folderNames: strip(mapping.folderNames),
    folderNamesExpanded: strip(mapping.folderNamesExpanded),
    icons,
  }
  const json = JSON.stringify(pack)
  const gz = gzipSync(json, { level: 9 })
  await mkdir(ASSETS, { recursive: true })
  await writeFile(OUT, gz)
  process.stdout.write(
    `packed ${Object.keys(icons).length} icons (${dropped} unsupplied ids dropped; `
    + `${(gz.length / 1024).toFixed(0)}KB gz, ${(json.length / 1024).toFixed(0)}KB raw) -> ${OUT}\n`,
  )
}

/** Resolve the mapping JSON + icons dir from a .vsix or an extracted dir. */
async function locateSource(src) {
  const isVsix = src.endsWith('.vsix')
  const base = isVsix ? await extractVsix(src) : src
  const extDir = await findExtensionDir(base)
  const mapping = JSON.parse(await readFile(join(extDir, 'dist', 'material-icons.json'), 'utf8'))
  return { mapping, iconsDir: join(extDir, 'icons') }
}

/** A .vsix is a zip; the extension payload lives under extension/. */
async function extractVsix(vsixPath) {
  const { tmpdir } = await import('node:os')
  const target = join(await tmpdir(), `dsh-mit-pack-${Date.now()}`)
  await mkdir(target, { recursive: true })
  const { execFile } = await import('node:child_process')
  await new Promise((resolve, reject) => {
    execFile('unzip', ['-qo', vsixPath, '-d', target], (err) => (err ? reject(err) : resolve()))
  })
  return target
}

/** The extracted tree may or may not include the extension/ level. */
async function findExtensionDir(base) {
  const entries = await readdir(base, { withFileTypes: true })
  if (entries.some((e) => e.name === 'dist' && e.isDirectory())) return base
  const sub = entries.find((e) => e.isDirectory() && e.name === 'extension')
  if (sub !== undefined) return join(base, sub.name)
  throw new Error(`no extension payload under ${base} (expected dist/material-icons.json)`)
}

/** Every icon id the mapping tables + defaults reference. */
function collectDefinitionIds(mapping) {
  const ids = new Set()
  for (const key of ['file', 'folder', 'folderExpanded', 'rootFolder', 'rootFolderExpanded']) {
    if (typeof mapping[key] === 'string') ids.add(mapping[key])
  }
  for (const key of ['fileExtensions', 'fileNames', 'folderNames', 'folderNamesExpanded']) {
    const table = mapping[key]
    if (table === null || typeof table !== 'object') continue
    for (const id of Object.values(table)) {
      if (typeof id === 'string') ids.add(id)
    }
  }
  return [...ids]
}

await main()
