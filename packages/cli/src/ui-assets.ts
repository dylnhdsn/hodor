/**
 * Embedded UI assets. In a dev checkout this stub is empty and the server
 * shows a pointer to the Vite dev flow; scripts/bundle.mjs replaces this
 * module with the built packages/ui/dist contents at release-bundle time,
 * so the single-file hodor.mjs carries the whole UI.
 */
export interface UiAsset {
  base64: string
  type: string
}

export const uiAssets: Record<string, UiAsset> = {}
