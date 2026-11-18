import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isFileUrl, isLocalLink, isWindowsDrivePath } from '../shared/localLinks'

/** Resolves a link to a local filesystem path for the system file manager. */
export function localLinkPath(href: string, windows = process.platform === 'win32'): string | null {
  if (!isLocalLink(href)) return null
  try {
    const target = isFileUrl(href) ? fileURLToPath(href, { windows }) : decodeURIComponent(href)
    if (windows) return isWindowsDrivePath(target) ? path.win32.normalize(target) : null
    return /^\/(?![\\/])/.test(target) ? target : null
  } catch {
    return null
  }
}
