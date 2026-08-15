/**
 * Material file/folder icons for the explorer: the FULL Material Icon Theme
 * (~1100 SVGs + the compiled VSCode icon-theme mapping) served as one
 * gzip-stored JSON member through the plugin's lazy bundle route
 * (/sidebar/bundle/icons.json.gz — see src/bundle-route.ts; the browser
 * decompresses the Content-Encoding: gzip body natively). Packed from the
 * upstream VSIX by scripts/pack-icons.mjs (MIT, see
 * assets/MATERIAL-ICONS-LICENSE).
 *
 * Loading is lazy and memoized: the first explorer render fetches the
 * member once (~300KB wire); until it arrives (or forever, if the fetch
 * fails) the explorer keeps its generic outline icons — icon richness is
 * progressive enhancement, never a blocker. Matching mirrors the theme's
 * own precedence: exact filename → extension → the `file` default; folders
 * by name with open/closed variants (folderNames / folderNamesExpanded).
 */
import { useEffect, useState } from 'react'

/** The packed asset's shape (mirror of scripts/pack-icons.mjs). */
export interface FileIconSet {
  file: string
  folder: string
  folderOpen: string
  ext: Record<string, string>
  fileNames: Record<string, string>
  folderNames: Record<string, string>
  folderNamesExpanded: Record<string, string>
  icons: Record<string, string>
}

/** In-flight/memoized load; a failure clears the entry so a retry re-fetches. */
let cache: Promise<FileIconSet> | undefined

/** Fetch the icon set once (browser transparently gunzips the body). */
export function loadFileIcons(): Promise<FileIconSet> {
  if (cache !== undefined) return cache
  const task = (async (): Promise<FileIconSet> => {
    const response = await fetch('/sidebar/bundle/icons.json.gz')
    if (!response.ok) throw new Error(`icon set fetch failed: HTTP ${response.status}`)
    return await response.json() as FileIconSet
  })()
  cache = task
  void task.catch(() => { cache = undefined })
  return task
}

/** The icon id for a FILE name, theme precedence: filename → ext → default. */
export function iconIdForFile(set: FileIconSet, name: string): string {
  const lower = name.toLowerCase()
  return set.fileNames[lower] ?? set.ext[extOf(lower)] ?? set.file
}

/** The icon id for a FOLDER name, honoring the open/closed variant. */
export function iconIdForFolder(set: FileIconSet, name: string, open: boolean): string {
  const lower = name.toLowerCase()
  return (open ? set.folderNamesExpanded : set.folderNames)[lower]
    ?? (open ? set.folderOpen : set.folder)
}

/** The extension of a lowercased filename (text after the last dot; '' when none). */
function extOf(lower: string): string {
  const at = lower.lastIndexOf('.')
  return at <= 0 ? '' : lower.slice(at + 1)
}

/**
 * React hook: the loaded icon set (null until fetched / forever on error —
 * callers render their generic icons meanwhile). Re-attempts on remount
 * after a failure (the cache entry was cleared).
 */
export function useFileIcons(): FileIconSet | null {
  const [set, setSet] = useState<FileIconSet | null>(null)
  useEffect(() => {
    let alive = true
    loadFileIcons().then((loaded) => { if (alive) setSet(loaded) }).catch(() => { /* keep fallback */ })
    return () => { alive = false }
  }, [])
  return set
}

/**
 * One material icon rendered from its inline SVG (16×16 viewBox, fill
 * colors baked into the paths). dangerouslySetInnerHTML is the same
 * pattern the plugin already uses for its inlined logo glyph; the SVGs
 * come from our own packed asset, not user input.
 */
export function MaterialIcon(props: { svg: string; size?: number }): React.ReactNode {
  const size = props.size ?? 16
  return (
    <span
      className="dsh-mit-icon"
      style={{ width: size, height: size, display: 'inline-flex', flex: 'none' }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: props.svg }}
    />
  )
}
