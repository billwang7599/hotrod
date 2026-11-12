// Files waiting to go with the next message: picked, pasted or dropped, checked against the size limits, read in.
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { IMAGE_TYPES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_TOTAL_BYTES } from '@kothar/core/shared'
import { formatBytes } from '../format.ts'
import type { Pending } from './attachments.tsx'

/** The files waiting to be sent; attach reads new ones in, telling the user (notify) about any it refuses. */
export function useAttachments(notify: (message: string) => void) {
  const [pending, setPending] = useState<Pending[]>([])
  const pendingRef = useRef(pending)
  // oxlint-disable-next-line react/refs -- the latest list, for attach's size total and the unmount cleanup
  pendingRef.current = pending

  useEffect(() => () => pendingRef.current.forEach((p) => p.preview && URL.revokeObjectURL(p.preview)), [])

  const unattach = (removed: Pending[]) => {
    removed.forEach((p) => p.preview && URL.revokeObjectURL(p.preview))
    setPending((list) => list.filter((p) => !removed.includes(p)))
  }
  const attach = async (files: File[]) => {
    let totalBytes = pendingRef.current.reduce((sum, p) => sum + p.size, 0)
    for (const file of files) {
      const name = file.name || 'attachment'
      try {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          const limit = formatBytes(MAX_ATTACHMENT_BYTES)
          notify(`${name} is ${formatBytes(file.size)}. Attachments can be at most ${limit} each.`)
          continue
        }
        if (totalBytes + file.size > MAX_ATTACHMENTS_TOTAL_BYTES) {
          const limit = formatBytes(MAX_ATTACHMENTS_TOTAL_BYTES)
          notify(`${name} doesn't fit: one message carries at most ${limit} of attachments. Send it in another.`)
          continue
        }
        totalBytes += file.size
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result).replace(/^[^,]*,/, ''))
          reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(file)
        })
        const mimeType = file.type || 'application/octet-stream'
        const preview = IMAGE_TYPES.includes(mimeType) ? URL.createObjectURL(file) : undefined
        const added = { id: crypto.randomUUID(), name, mimeType, base64, size: file.size, preview }
        setPending((list) => [...list, added])
      } catch {
        notify(`Could not read ${name}`)
      }
    }
  }
  return { pending, attach, unattach }
}

/**
 * Dropping files anywhere on the chat attaches them while canAttach. dragging is true while files are held over it;
 * dropHandlers go on the element that takes the drop.
 */
export function useFileDrop(canAttach: boolean, attach: (files: File[]) => Promise<void>) {
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const carriesFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')
  const dropHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (!carriesFiles(e)) return
      dragDepth.current++
      setDragging(true)
    },
    onDragLeave: (e: DragEvent) => {
      if (!carriesFiles(e) || --dragDepth.current > 0) return
      setDragging(false)
    },
    onDragOver: (e: DragEvent) => carriesFiles(e) && e.preventDefault(),
    onDrop: (e: DragEvent) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      if (canAttach) void attach([...e.dataTransfer.files])
    },
  }
  return { dragging, dropHandlers }
}
