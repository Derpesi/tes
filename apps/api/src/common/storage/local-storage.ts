import { constants } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { ObjectStorage, ObjekTidakDitemukan, POLA_KUNCI } from './object-storage';

/** Driver sistem berkas lokal. Direktori dibuat 0700 dan berkas 0600; kunci divalidasi ketat (anti path traversal). */
export class LocalObjectStorage implements ObjectStorage {
  private readonly akar: string;

  constructor(direktori: string) {
    this.akar = resolve(direktori);
  }

  private jalur(kunci: string): string {
    if (!POLA_KUNCI.test(kunci)) throw new Error('Kunci objek tidak valid');
    const p = resolve(join(this.akar, kunci));
    if (!p.startsWith(this.akar + sep)) throw new Error('Kunci objek di luar direktori penyimpanan');
    return p;
  }

  async simpan(kunci: string, data: Buffer): Promise<void> {
    const p = this.jalur(kunci);
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    // O_EXCL: tidak pernah menimpa objek yang sudah ada.
    const fh = await open(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await fh.writeFile(data);
    } finally {
      await fh.close();
    }
  }

  async baca(kunci: string): Promise<Buffer> {
    try {
      return await readFile(this.jalur(kunci));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ObjekTidakDitemukan();
      throw e;
    }
  }

  async hapus(kunci: string): Promise<void> {
    await rm(this.jalur(kunci), { force: true });
  }
}
