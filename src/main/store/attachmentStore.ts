import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type AttachmentMediaType, type FileAttachment } from '../../shared/types'
import { isConversationId } from '../../shared/validate'

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const EXTENSIONS: Record<AttachmentMediaType, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
}

function nameOf(value: string): string {
  return value.split(/[\\/]/).at(-1)?.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 240) || 'ファイル'
}

function identify(bytes: Buffer): AttachmentMediaType | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf'
  return undefined
}

export function parseFileAttachment(raw: unknown): FileAttachment | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { id, name, size, mediaType, thumbnail } = raw as Partial<FileAttachment>
  if (typeof id !== 'string' || !UUID.test(id) || typeof name !== 'string' || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null
  const file: FileAttachment = { id, name: nameOf(name), size }
  if (typeof mediaType === 'string' && Object.hasOwn(EXTENSIONS, mediaType)) file.mediaType = mediaType
  if (typeof thumbnail === 'string' && thumbnail.length <= 60_000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(thumbnail)) file.thumbnail = thumbnail
  return file
}

/** Stores the bytes beside the conversation records. Message JSON contains only metadata and a small preview. */
export class AttachmentStore {
  constructor(private readonly directory: string) {}

  save(conversationId: string, uploads: unknown, thumbnail?: (bytes: Buffer) => string | undefined): FileAttachment[] {
    if (uploads === undefined) return []
    if (!Array.isArray(uploads) || uploads.length > MAX_ATTACHMENTS) throw new Error(`添付は1回に${MAX_ATTACHMENTS}件までです`)
    let total = 0
    const incoming = uploads.map((upload: unknown) => {
      if (typeof upload !== 'object' || upload === null) throw new Error('添付ファイルの指定が不正です')
      const { name, bytes } = upload as { name?: unknown; bytes?: unknown }
      if (typeof name !== 'string' || !ArrayBuffer.isView(bytes) || Object.prototype.toString.call(bytes) !== '[object Uint8Array]') throw new Error('添付ファイルの指定が不正です')
      total += bytes.byteLength
      if (total > MAX_ATTACHMENT_BYTES) throw new Error('添付ファイルは合計50 MBまでです')
      return { name: nameOf(name), bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
    })
    if (incoming.length === 0) return []

    mkdirSync(this.conversationDirectory(conversationId), { recursive: true, mode: 0o700 })
    const written: string[] = []
    try {
      return incoming.map(({ name, bytes }) => {
        const file: FileAttachment = { id: randomUUID(), name, size: bytes.length }
        const mediaType = identify(bytes)
        if (mediaType) file.mediaType = mediaType
        if (mediaType?.startsWith('image/')) {
          const preview = thumbnail?.(bytes)
          if (preview) file.thumbnail = preview
        }
        const destination = this.file(conversationId, file)
        const folder = path.dirname(destination)
        mkdirSync(folder, { mode: 0o700 })
        written.push(folder)
        writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 })
        return file
      })
    } catch (error) {
      for (const folder of written) rmSync(folder, { recursive: true, force: true })
      throw error
    }
  }

  file(conversationId: string, file: FileAttachment): string {
    if (!UUID.test(file.id)) throw new Error('添付の ID が不正です')
    const safeName = file.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '')
    const suffix = path.extname(safeName)
    const extension = file.mediaType === 'image/jpeg' && suffix.toLowerCase() === '.jpeg' ? suffix : file.mediaType ? EXTENSIONS[file.mediaType] : suffix.slice(0, 12)
    const stem = suffix.toLowerCase() === extension.toLowerCase() ? safeName.slice(0, safeName.length - suffix.length) : safeName
    const clipped = Array.from(stem).slice(0, 50).join('')
    const name = clipped && !/^(?:\.|CON$|PRN$|AUX$|NUL$|COM[1-9]$|LPT[1-9]$)/i.test(clipped) ? clipped : `添付${clipped ? `-${clipped}` : ''}`
    return path.join(this.conversationDirectory(conversationId), file.id, name + extension)
  }

  existingFile(conversationId: string, file: FileAttachment): string | null {
    const filename = this.file(conversationId, file)
    return existsSync(filename) ? filename : null
  }

  remove(conversationId: string): void {
    rmSync(this.conversationDirectory(conversationId), { recursive: true, force: true })
  }

  private conversationDirectory(id: string): string {
    if (!isConversationId(id)) throw new Error('会話の ID が不正です')
    return path.join(this.directory, id)
  }
}
