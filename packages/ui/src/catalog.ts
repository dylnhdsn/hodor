import { isDarkScheme, unpackScheme, type Colorscheme } from '@hodor/core/colorscheme'

/**
 * The bundled scheme catalog: hundreds of terminal colorschemes from
 * mbadolato/iTerm2-Color-Schemes (MIT), packed by scripts/import-schemes.mjs.
 * Loaded on demand — the settings panel is the only reader — and a pick
 * is adopted into the theme's "yours" slot, so boot never needs it.
 */

export interface CatalogEntry {
  scheme: Colorscheme
  dark: boolean
}

export const CATALOG_SOURCE = {
  name: 'iTerm2-Color-Schemes',
  url: 'https://github.com/mbadolato/iTerm2-Color-Schemes',
  license: 'MIT',
}

let loading: Promise<CatalogEntry[]> | undefined

export function loadCatalog(): Promise<CatalogEntry[]> {
  loading ??= import('./assets/schemes-catalog.json').then((mod) => {
    const doc = mod.default as { schemes: Array<{ id: string; name: string; colors: string }> }
    const out: CatalogEntry[] = []
    for (const e of doc.schemes) {
      // 'cat-' keeps a catalog Dracula apart from the curated one.
      const scheme = unpackScheme('cat-' + e.id, e.name, e.colors)
      if (scheme !== null) out.push({ scheme, dark: isDarkScheme(scheme) })
    }
    return out
  })
  return loading
}
