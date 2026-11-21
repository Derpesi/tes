import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalObjectStorage } from './local-storage';
import { buatKunciObjek, ObjekTidakDitemukan, POLA_KUNCI } from './object-storage';

describe('LocalObjectStorage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hris-penyimpanan-'));
  const s = new LocalObjectStorage(dir);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('simpan, baca, dan hapus; kunci tidak memuat nama berkas pengguna', async () => {
    const kunci = buatKunciObjek(randomUUID());
    expect(kunci).toMatch(POLA_KUNCI);
    await s.simpan(kunci, Buffer.from('isi-sintetis'));
    expect((await s.baca(kunci)).toString()).toBe('isi-sintetis');
    await s.hapus(kunci);
    await expect(s.baca(kunci)).rejects.toBeInstanceOf(ObjekTidakDitemukan);
    await expect(s.hapus(kunci)).resolves.toBeUndefined(); // idempoten
  });

  it('izin berkas 0600 dan direktori 0700', async () => {
    const kunci = buatKunciObjek(randomUUID());
    await s.simpan(kunci, Buffer.from('x'));
    expect(statSync(join(dir, kunci)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, kunci.split('/')[0])).mode & 0o777).toBe(0o700);
  });

  it('tidak pernah menimpa objek yang sudah ada', async () => {
    const kunci = buatKunciObjek(randomUUID());
    await s.simpan(kunci, Buffer.from('asli'));
    await expect(s.simpan(kunci, Buffer.from('timpa'))).rejects.toThrow();
    expect((await s.baca(kunci)).toString()).toBe('asli');
  });

  it.each(['../x', '/etc/passwd', 'a/b', `${randomUUID()}/../../${randomUUID()}`, `${randomUUID()}//${randomUUID()}`, '', `${randomUUID()}/${randomUUID()}/extra`, 'C:\\x'])('menolak kunci tidak valid/traversal: %s', async (kunci) => {
    await expect(s.simpan(kunci, Buffer.from('x'))).rejects.toThrow(/Kunci objek/);
    await expect(s.baca(kunci)).rejects.toThrow(/Kunci objek/);
    await expect(s.hapus(kunci)).rejects.toThrow(/Kunci objek/);
  });

  it('buatKunciObjek menolak companyId yang bukan UUID', () => {
    expect(() => buatKunciObjek('../../x')).toThrow(/tidak valid/);
  });
});
