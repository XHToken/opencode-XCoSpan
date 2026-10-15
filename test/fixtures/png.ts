import { crc32, deflateSync } from "node:zlib"

export function solidPng(width: number, height: number, rgb: readonly [number, number, number]) {
  return png(width, height, () => rgb)
}

export function quadrantPng(width: number, height: number) {
  const colors = [
    [255, 0, 0],
    [0, 0, 255],
    [0, 255, 0],
    [255, 255, 0],
  ] as const
  return png(width, height, (x, y) => colors[Number(x >= width / 2) + 2 * Number(y >= height / 2)]!)
}

function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number],
) {
  function chunk(type: string, data: Buffer) {
    const body = Buffer.concat([Buffer.from(type), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const rows = Array.from({ length: height }, (_, y) => {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x++) row.set(pixel(x, y), 1 + x * 3)
    return row
  })
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ])
}
