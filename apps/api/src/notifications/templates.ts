export type NamaTemplate = 'undangan_staff' | 'reset_password' | 'kontrak_akan_berakhir';

export interface PesanEmail {
  to: string;
  subject: string;
  text: string;
}

/** Templat email berbahasa Indonesia. Teks polos; tautan berisi token sekali pakai. */
export function renderTemplate(nama: NamaTemplate, to: string, data: Record<string, string>): PesanEmail {
  switch (nama) {
    case 'undangan_staff':
      return {
        to,
        subject: 'Undangan akun DAMARINDO GROUP HRIS',
        text:
          `Halo ${data.nama},\n\n` +
          `Anda diundang untuk memakai DAMARINDO GROUP HRIS. Buka tautan berikut untuk membuat kata sandi dan mengaktifkan verifikasi dua langkah:\n\n` +
          `${data.link}\n\n` +
          `Tautan berlaku 7 hari dan hanya dapat dipakai satu kali. Jika Anda tidak merasa diundang, abaikan email ini.\n` +
          `Kami tidak pernah meminta kata sandi Gmail Anda.\n`,
      };
    case 'kontrak_akan_berakhir':
      return {
        to,
        subject: `Kontrak ${data.nomor} akan berakhir ${data.sisa_hari} hari lagi`,
        text:
          `Pengingat dari DAMARINDO GROUP HRIS.\n\n` +
          `Kontrak PKWT berikut akan berakhir dan belum memiliki kontrak lanjutan yang ditandatangani:\n\n` +
          `Nomor kontrak : ${data.nomor}\n` +
          `Pekerja       : ${data.nama}\n` +
          `Jabatan       : ${data.jabatan}\n` +
          `Perusahaan    : ${data.perusahaan}\n` +
          `Berakhir pada : ${data.tanggal_akhir} (${data.sisa_hari} hari lagi)\n\n` +
          `Bila kontrak akan diperpanjang, buat kontrak lanjutan lewat menu PKWT sebelum tanggal tersebut. Pengingat ini dikirim sekali per kontrak.\n`,
      };
    case 'reset_password':
      return {
        to,
        subject: 'Atur ulang kata sandi DAMARINDO GROUP HRIS',
        text:
          `Kami menerima permintaan untuk mengatur ulang kata sandi akun Anda. Buka tautan berikut:\n\n` +
          `${data.link}\n\n` +
          `Tautan berlaku 30 menit dan hanya dapat dipakai satu kali. Verifikasi dua langkah tetap diperlukan saat masuk.\n` +
          `Jika Anda tidak memintanya, abaikan email ini; kata sandi Anda tidak berubah.\n`,
      };
  }
}
