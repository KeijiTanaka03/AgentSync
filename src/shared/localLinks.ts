export const isWindowsDrivePath = (value: string): boolean => /^[a-z]:[\\/](?![\\/])/i.test(value)
export const isFileUrl = (value: string): boolean => /^file:\/\/\/(?![\\/])/i.test(value)

export function isLocalLink(value: string): boolean {
  return isFileUrl(value) || isWindowsDrivePath(value) || /^\/(?![\\/])/.test(value)
}
