import { FileIcon } from './icons'

export function AttachmentLabel({ name, size, thumbnail }: { name: string; size: number; thumbnail?: string }) {
  const units = size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`
  return (
    <>
      {thumbnail
        ? <img className="attachment-thumbnail" src={thumbnail} alt="" />
        : <FileIcon size={18} className="attachment-icon" />}
      <span className="attachment-info">
        <span className="attachment-name">{name}</span>
        <small>{units}</small>
      </span>
    </>
  )
}
