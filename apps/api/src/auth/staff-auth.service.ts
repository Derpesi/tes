import { randomInt } from 'node:crypto';
import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Pool } from 'pg';
import { AuditService } from '../audit/audit.service';
import { dekripsi, enkripsi, hmac, sha256, tokenAcak } from '../common/crypto/crypto';
import { ENV, KUNCI, Kunci } from '../config/config.module';
import type { Env } from '../config/env';
import { POOL } from '../database/tokens';
import { NotificationService } from '../notifications/notification.service';
import { KUNCI_AKUN, PESAN_LOGIN_GAGAL, PESAN_MFA_GAGAL, TTL, normalisasiEmail } from './auth.constants';
import { PasswordService, validasiPassword } from './password.service';
import { SesiAktif, SesiBaru, SessionService } from './session.service';
import { TotpService } from './totp.service';

export interface Konteks {
  ip?: string;
  userAgent?: string;
}

const ABJAD_PEMULIHAN = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // tanpa karakter mirip (I, L, O, 0, 1)

@Injectable()
export class StaffAuthService {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(KUNCI) private readonly kunci: Kunci,
    @Inject(ENV) private readonly env: Env,
    private readonly sesi: SessionService,
    private readonly password: PasswordService,
    private readonly totp: TotpService,
    private readonly notif: NotificationService,
    private readonly audit: AuditService,
  ) {}

  // ---------- util ----------
  private emailRef(email: string): Buffer {
    return hmac(this.kunci.hmac, `email:${email}`);
  }
  private ipRef(ip?: string): Buffer | null {
    return ip ? hmac(this.kunci.hmac, `ip:${ip}`) : null;
  }
  private ref(b: Buffer): string {
    return b.toString('hex').slice(0, 16);
  }

  private async terkunci(emailRef: Buffer): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM login_attempts WHERE email_hmac = $1 AND realm = 'staff' AND reason = 'TERKUNCI'
          AND occurred_at > now() - ($2 * interval '1 millisecond') LIMIT 1`,
      [emailRef, KUNCI_AKUN.kunciMs],
    );
    return !!r.rowCount;
  }

  /** Mencatat kegagalan; pada kegagalan ke-5 berturut-turut menulis penanda TERKUNCI. Berlaku juga untuk email tak dikenal. */
  private async catatGagal(userId: string | null, emailRef: Buffer, ip: Buffer | null, alasan: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO login_attempts (user_id, realm, email_hmac, ip_hmac, succeeded, reason) VALUES ($1, 'staff', $2, $3, false, $4)`,
      [userId, emailRef, ip, alasan],
    );
    const n = await this.pool.query(
      `SELECT count(*)::int AS n FROM login_attempts
        WHERE email_hmac = $1 AND realm = 'staff' AND succeeded = false AND reason <> 'TERKUNCI'
          AND occurred_at > COALESCE((SELECT max(occurred_at) FROM login_attempts
                WHERE email_hmac = $1 AND realm = 'staff' AND ((succeeded AND reason = 'LOGIN_OK') OR reason = 'TERKUNCI')), '-infinity')`,
      [emailRef],
    );
    if (n.rows[0].n >= KUNCI_AKUN.maksGagal) {
      await this.pool.query(`INSERT INTO login_attempts (user_id, realm, email_hmac, ip_hmac, succeeded, reason) VALUES ($1, 'staff', $2, $3, false, 'TERKUNCI')`, [userId, emailRef, ip]);
      await this.audit.catat({ aksi: 'auth.login.locked', aktorId: userId, detail: { emailRef: this.ref(emailRef) } });
    }
    await this.audit.catat({ aksi: 'auth.login.failed', aktorId: userId, detail: { alasan, emailRef: this.ref(emailRef) } });
  }

  private async catatBerhasil(userId: string, emailRef: Buffer, ip: Buffer | null, alasan: 'PASSWORD_OK' | 'LOGIN_OK'): Promise<void> {
    await this.pool.query(
      `INSERT INTO login_attempts (user_id, realm, email_hmac, ip_hmac, succeeded, reason) VALUES ($1, 'staff', $2, $3, true, $4)`,
      [userId, emailRef, ip, alasan],
    );
  }

  private kodePemulihanBaru(): string {
    const potong = () => Array.from({ length: 5 }, () => ABJAD_PEMULIHAN[randomInt(ABJAD_PEMULIHAN.length)]).join('');
    return `${potong()}-${potong()}`;
  }
  private hashKodePemulihan(kode: string): Buffer {
    return hmac(this.kunci.hmac, `rc:${kode.toUpperCase().replace(/[^A-Z0-9]/g, '')}`);
  }

  // ---------- undangan ----------
  async terimaUndangan(token: string, password: string, ctx: Konteks): Promise<SesiBaru> {
    const tidakValid = () => new BadRequestException({ kode: 'UNDANGAN_TIDAK_VALID', message: 'Undangan tidak valid atau sudah kedaluwarsa' });
    const th = sha256(token);
    const cari = (c: Pool | import('pg').PoolClient, kunciBaris = false) =>
      c.query(
        `SELECT i.id AS inv_id, u.id AS user_id, u.email FROM staff_invitations i JOIN users u ON u.id = i.user_id
          WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() AND u.status = 'DIUNDANG' AND u.realm = 'staff'
          ${kunciBaris ? 'FOR UPDATE OF i' : ''}`,
        [th],
      );
    const awal = await cari(this.pool);
    if (!awal.rowCount) throw tidakValid();
    const galat = validasiPassword(password, awal.rows[0].email);
    if (galat.length) throw new BadRequestException({ kode: 'PASSWORD_LEMAH', message: galat.join('; ') });
    const hash = await this.password.hash(password); // di luar transaksi (mahal)

    const c = await this.pool.connect();
    let userId: string;
    try {
      await c.query('BEGIN');
      const r = await cari(c, true);
      if (!r.rowCount) throw tidakValid();
      userId = r.rows[0].user_id;
      await c.query(`INSERT INTO staff_credentials (user_id, password_hash) VALUES ($1, $2)`, [userId, hash]);
      await c.query(`UPDATE staff_invitations SET used_at = now() WHERE id = $1`, [r.rows[0].inv_id]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      if ((e as { code?: string }).code === '23505') throw tidakValid(); // kredensial sudah ada (balapan)
      throw e;
    } finally {
      c.release();
    }
    await this.audit.catat({ aksi: 'auth.invitation.accepted', aktorId: userId, objek: 'user', objekId: userId });
    return this.sesi.buat({ userId, realm: 'staff', state: 'MENUNGGU_ENROLL_MFA', userAgent: ctx.userAgent });
  }

  // ---------- login ----------
  async login(emailMasuk: string, password: string, ctx: Konteks): Promise<{ nextStep: 'MFA' | 'ENROLL_MFA'; sesi: SesiBaru }> {
    const email = normalisasiEmail(emailMasuk);
    const eref = this.emailRef(email);
    const iref = this.ipRef(ctx.ip);
    const gagal = () => new UnauthorizedException({ kode: 'LOGIN_GAGAL', message: PESAN_LOGIN_GAGAL });

    if (await this.terkunci(eref)) {
      await this.password.verifikasiTiruan(password);
      throw gagal();
    }
    const u = await this.pool.query(
      `SELECT u.id, u.status, c.password_hash,
              EXISTS (SELECT 1 FROM staff_mfa_factors f WHERE f.user_id = u.id AND f.status = 'AKTIF') AS punya_mfa
         FROM users u LEFT JOIN staff_credentials c ON c.user_id = u.id WHERE u.realm = 'staff' AND u.email = $1`,
      [email],
    );
    const baris = u.rows[0] as { id: string; status: string; password_hash: string | null; punya_mfa: boolean } | undefined;
    let ok = false;
    if (baris?.password_hash) ok = await this.password.verify(baris.password_hash, password);
    else await this.password.verifikasiTiruan(password);
    if (!ok || !baris || baris.status === 'NONAKTIF') {
      await this.catatGagal(baris?.id ?? null, eref, iref, 'PASSWORD_SALAH');
      throw gagal();
    }
    await this.catatBerhasil(baris.id, eref, iref, 'PASSWORD_OK');
    const state = baris.punya_mfa ? 'MENUNGGU_MFA' : 'MENUNGGU_ENROLL_MFA';
    const sesi = await this.sesi.buat({ userId: baris.id, realm: 'staff', state, userAgent: ctx.userAgent });
    return { nextStep: baris.punya_mfa ? 'MFA' : 'ENROLL_MFA', sesi };
  }

  // ---------- MFA ----------
  async verifikasiMfa(s: SesiAktif, kodeMasuk: string, ctx: Konteks): Promise<SesiBaru> {
    const eref = this.emailRef(s.email);
    const iref = this.ipRef(ctx.ip);
    const gagal = async () => {
      await this.catatGagal(s.userId, eref, iref, 'MFA_SALAH');
      if (await this.terkunci(eref)) await this.sesi.cabutSemuaUser(s.userId, 'TERKUNCI');
      return new UnauthorizedException({ kode: 'MFA_GAGAL', message: PESAN_MFA_GAGAL });
    };
    if (await this.terkunci(eref)) {
      await this.sesi.cabut(s.id, 'TERKUNCI');
      throw new UnauthorizedException({ kode: 'MFA_GAGAL', message: PESAN_MFA_GAGAL });
    }
    const kode = kodeMasuk.trim();
    let sukses = false;
    let via: 'totp' | 'pemulihan' = 'totp';
    if (/^\d{6}$/.test(kode)) {
      const f = await this.pool.query(`SELECT id, secret_enc, last_used_step FROM staff_mfa_factors WHERE user_id = $1 AND status = 'AKTIF'`, [s.userId]);
      if (f.rowCount) {
        const secret = dekripsi(f.rows[0].secret_enc, this.kunci.enkripsi, `mfa:${s.userId}`).toString();
        const terakhir = f.rows[0].last_used_step === null ? undefined : Number(f.rows[0].last_used_step);
        const h = this.totp.verifikasi(secret, kode, terakhir);
        if (h.valid) {
          // Atomik: hanya satu permintaan yang dapat memakai time-step ini (anti pakai-ulang/balapan).
          const up = await this.pool.query(
            `UPDATE staff_mfa_factors SET last_used_step = $2 WHERE id = $1 AND (last_used_step IS NULL OR last_used_step < $2) RETURNING id`,
            [f.rows[0].id, h.timeStep],
          );
          sukses = !!up.rowCount;
        }
      }
    } else if (kode.length >= 8) {
      via = 'pemulihan';
      const up = await this.pool.query(`UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`, [s.userId, this.hashKodePemulihan(kode)]);
      sukses = !!up.rowCount;
    }
    if (!sukses) throw await gagal();

    await this.catatBerhasil(s.userId, eref, iref, 'LOGIN_OK');
    await this.audit.catat({ aksi: 'auth.login.success', aktorId: s.userId, detail: { via } });
    if (via === 'pemulihan') await this.audit.catat({ aksi: 'auth.recovery_code.used', aktorId: s.userId });
    return this.sesi.rotasi(s, 'PENUH', ctx.userAgent);
  }

  async mulaiDaftarMfa(s: SesiAktif): Promise<{ secret: string; otpauthUri: string }> {
    const secret = this.totp.buatSecret();
    const enc = enkripsi(secret, this.kunci.enkripsi, `mfa:${s.userId}`);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`UPDATE staff_mfa_factors SET status = 'DICABUT', revoked_at = now() WHERE user_id = $1 AND status = 'PENDING'`, [s.userId]);
      await c.query(`INSERT INTO staff_mfa_factors (user_id, secret_enc, status) VALUES ($1, $2, 'PENDING')`, [s.userId, enc]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    return { secret, otpauthUri: this.totp.uri(s.email, secret) };
  }

  async konfirmasiDaftarMfa(s: SesiAktif, kode: string, ctx: Konteks): Promise<{ recoveryCodes: string[]; sesi: SesiBaru }> {
    const eref = this.emailRef(s.email);
    const iref = this.ipRef(ctx.ip);
    const gagal = () => new UnauthorizedException({ kode: 'MFA_GAGAL', message: PESAN_MFA_GAGAL });
    if (await this.terkunci(eref)) throw gagal();
    const f = await this.pool.query(`SELECT id, secret_enc FROM staff_mfa_factors WHERE user_id = $1 AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`, [s.userId]);
    if (!f.rowCount) throw new BadRequestException({ kode: 'DAFTAR_MFA_BELUM_DIMULAI', message: 'Mulai pendaftaran verifikasi dua langkah terlebih dahulu' });
    const secret = dekripsi(f.rows[0].secret_enc, this.kunci.enkripsi, `mfa:${s.userId}`).toString();
    const h = this.totp.verifikasi(secret, kode.trim());
    if (!h.valid) {
      await this.catatGagal(s.userId, eref, iref, 'MFA_SALAH');
      throw gagal();
    }
    const kodeBaru = Array.from({ length: 10 }, () => this.kodePemulihanBaru());
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`UPDATE staff_mfa_factors SET status = 'DICABUT', revoked_at = now() WHERE user_id = $1 AND status = 'AKTIF'`, [s.userId]);
      await c.query(`UPDATE staff_mfa_factors SET status = 'AKTIF', confirmed_at = now(), last_used_step = $2 WHERE id = $1`, [f.rows[0].id, h.timeStep]);
      await c.query(`UPDATE users SET status = 'AKTIF', updated_at = now() WHERE id = $1 AND status = 'DIUNDANG'`, [s.userId]);
      await c.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL`, [s.userId]);
      for (const k of kodeBaru) await c.query(`INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [s.userId, this.hashKodePemulihan(k)]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    await this.catatBerhasil(s.userId, eref, iref, 'LOGIN_OK');
    await this.audit.catat({ aksi: 'auth.mfa.enrolled', aktorId: s.userId });
    await this.audit.catat({ aksi: 'auth.login.success', aktorId: s.userId, detail: { via: 'pendaftaran_mfa' } });
    return { recoveryCodes: kodeBaru, sesi: await this.sesi.rotasi(s, 'PENUH', ctx.userAgent) };
  }

  // ---------- keluar & info ----------
  async logout(s: SesiAktif): Promise<void> {
    await this.sesi.cabut(s.id, 'LOGOUT');
    await this.audit.catat({ aksi: 'auth.logout', aktorId: s.userId });
  }

  // ---------- reset password ----------
  /** Selalu selesai tanpa membocorkan apakah email terdaftar. Dibatasi 3 permintaan per jam per akun. */
  async lupaPassword(emailMasuk: string): Promise<void> {
    const email = normalisasiEmail(emailMasuk);
    const u = await this.pool.query(
      `SELECT u.id, p.display_name FROM users u JOIN staff_credentials c ON c.user_id = u.id LEFT JOIN persons p ON p.id = u.person_id
        WHERE u.realm = 'staff' AND u.email = $1 AND u.status = 'AKTIF'`,
      [email],
    );
    if (!u.rowCount) return;
    const userId = u.rows[0].id as string;
    const n = await this.pool.query(`SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [userId]);
    if (n.rows[0].n >= 3) return;
    const token = tokenAcak();
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
      await c.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + ($3 * interval '1 millisecond'))`, [userId, sha256(token), TTL.resetPasswordMs]);
      await this.notif.enqueueEmail({ to: email, template: 'reset_password', data: { link: `${this.env.APP_BASE_URL}/staff/reset?token=${token}` } }, c);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    await this.audit.catat({ aksi: 'auth.password.reset_requested', aktorId: userId });
  }

  async resetPassword(token: string, passwordBaru: string): Promise<void> {
    const tidakValid = () => new BadRequestException({ kode: 'RESET_TIDAK_VALID', message: 'Tautan atur ulang tidak valid atau sudah kedaluwarsa' });
    const th = sha256(token);
    const cek = await this.pool.query(
      `SELECT r.user_id, u.email FROM password_reset_tokens r JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now() AND u.status = 'AKTIF'`,
      [th],
    );
    if (!cek.rowCount) throw tidakValid();
    const galat = validasiPassword(passwordBaru, cek.rows[0].email);
    if (galat.length) throw new BadRequestException({ kode: 'PASSWORD_LEMAH', message: galat.join('; ') });
    const hash = await this.password.hash(passwordBaru);
    const c = await this.pool.connect();
    let userId: string;
    try {
      await c.query('BEGIN');
      // Atomik: token hanya dapat dipakai sekali.
      const t = await c.query(`UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`, [th]);
      if (!t.rowCount) throw tidakValid();
      userId = t.rows[0].user_id;
      await c.query(`UPDATE staff_credentials SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE user_id = $1`, [userId, hash]);
      await c.query(`UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
      await c.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'RESET_PASSWORD' WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    await this.audit.catat({ aksi: 'auth.password.reset_completed', aktorId: userId });
  }
}
