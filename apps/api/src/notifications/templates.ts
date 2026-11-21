export type NamaTemplate = 'undangan_staff' | 'reset_password';

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
