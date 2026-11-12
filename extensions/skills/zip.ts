import { inflateRawSync } from 'node:zlib'

// A small reader for .zip and .skill files (a .skill is a zip), so importing needs no unzip program. It reads stored and
// deflated entries only, refuses encrypted and zip64 archives, leaves out symlinks, and caps what it unpacks, so a zip
// bomb or an entry naming ../ can't do harm. Paths come back as the archive has them, with / between parts; the caller
// checks them before writing anything.

export type ZipEntry = { path: string; data: Buffer }

export const MAX_UNPACKED = 50 * 1024 * 1024
export const MAX_ENTRIES = 5000

const END = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

export function readZip(zip: Buffer, limit = MAX_UNPACKED): ZipEntry[] {
  let end = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === END) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error("It isn't a zip file")
  const count = zip.readUInt16LE(end + 10)
  const at = zip.readUInt32LE(end + 16)
  if (count === 0xffff || at === 0xffffffff) throw new Error('Zip64 archives are not supported')
  if (count > MAX_ENTRIES) throw new Error(`It has more than ${MAX_ENTRIES} files`)
  const entries: ZipEntry[] = []
  let total = 0
  let offset = at
  for (let n = 0; n < count; n++) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== CENTRAL) throw new Error('The zip file is damaged')
    const flags = zip.readUInt16LE(offset + 8)
    const method = zip.readUInt16LE(offset + 10)
    const packed = zip.readUInt32LE(offset + 20)
    const size = zip.readUInt32LE(offset + 24)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const mode = zip.readUInt32LE(offset + 38) >>> 16
    const local = zip.readUInt32LE(offset + 42)
    const path = zip.toString('utf8', offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength
    if (path.endsWith('/')) continue
    if ((mode & 0o170000) === 0o120000) continue
    if (flags & 1) throw new Error('Encrypted zip files are not supported')
    if (packed === 0xffffffff || size === 0xffffffff) throw new Error('Zip64 archives are not supported')
    total += size
    if (total > limit) throw new Error(`It unpacks to more than ${Math.round(limit / 1024 / 1024)} MB`)
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== LOCAL) throw new Error('The zip file is damaged')
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const raw = zip.subarray(start, start + packed)
    if (raw.length !== packed) throw new Error('The zip file is damaged')
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) })
    else throw new Error(`${path} uses a kind of compression that isn't supported`)
    if (data.length !== size) throw new Error('The zip file is damaged')
    entries.push({ path, data })
  }
  return entries
}
