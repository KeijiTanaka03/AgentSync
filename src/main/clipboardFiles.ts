import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clipboard } from 'electron'
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, type AttachmentUpload } from '../shared/types'

const FILE_URL = 'electron application/osclipboard;format="public.file-url"'
const FILE_FORMATS = ['text/uri-list', FILE_URL] as const
const IMAGE_FORMATS = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

function localFileUrl(value: string): string | null {
  try {
    const url = new URL(value.replace(/\0+$/, '').trim())
    return url.protocol === 'file:' && !url.hostname ? fileURLToPath(url) : null
  } catch {
    return null
  }
}

/** Finder sometimes supplies native paths instead of populating the DOM clipboard's FileList. */
export async function readClipboardFiles(): Promise<AttachmentUpload[]> {
  const paths = new Set<string>()
  const items = await clipboard.read()
  for (const item of items) {
    for (const format of FILE_FORMATS) {
      if (!item.types.includes(format)) continue
      const payload = await item.getType(format)
      for (const entry of (await payload.text()).split(/\r?\n/)) {
        const filename = localFileUrl(entry)
        if (filename) paths.add(filename)
      }
    }
  }
  if (paths.size === 0) {
    for (const item of items) {
      const format = IMAGE_FORMATS.find((type) => item.types.includes(type))
      if (!format) continue
      const image = await item.getType(format)
      if (image.size > MAX_ATTACHMENT_BYTES) throw new Error('添付ファイルは合計50 MBまでです')
      return [{ name: `貼り付けた画像.${format.split('/')[1]}`, bytes: new Uint8Array(await image.arrayBuffer()) }]
    }
  }
  if (paths.size > MAX_ATTACHMENTS) throw new Error(`添付は1回に${MAX_ATTACHMENTS}件までです`)
  let total = 0
  const files: AttachmentUpload[] = []
  for (const filename of paths) {
    const info = await stat(filename)
    if (!info.isFile()) throw new Error('ファイルを選択してください')
    total += info.size
    if (total > MAX_ATTACHMENT_BYTES) throw new Error('添付ファイルは合計50 MBまでです')
    files.push({ name: path.basename(filename), bytes: await readFile(filename) })
  }
  return files
}
