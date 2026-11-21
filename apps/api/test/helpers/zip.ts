import { crc32, inflateRawSync } from 'node:zlib';

/** Pembaca ZIP minimal untuk tes: membaca direktori pusat dan memeriksa ukuran serta CRC setiap berkas. */
export function bacaZip(buf: Buffer): Record<string, string> {
  const akhir = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(akhir + 10);
  let p = buf.readUInt32LE(akhir + 16);
  const hasil: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Direktori pusat ZIP rusak');
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const crc = buf.readUInt32LE(p + 16);
    const nl = buf.readUInt16LE(p + 28);
    const off = buf.readUInt32LE(p + 42);
    const nama = buf.subarray(p + 46, p + 46 + nl).toString('utf8');
    const ds = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const isi = inflateRawSync(buf.subarray(ds, ds + csize));
    if (isi.length !== size || crc32(isi) !== crc) throw new Error(`Berkas ZIP ${nama} rusak`);
    hasil[nama] = isi.toString('utf8');
    p += 46 + nl + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return hasil;
}
