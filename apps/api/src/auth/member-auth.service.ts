import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { dekripsi, enkripsi, hmac, sha256, tokenAcak } from '../common/crypto/crypto';
import { ENV, KUNCI, Kunci } from '../config/config.module';
import type { Env } from '../config/env';
import { POOL } from '../database/tokens';
import { TTL, normalisasiEmail } from './auth.constants';
import { KlaimGoogle, OidcService } from './oidc.service';
import { SesiAktif, SesiBaru, SessionService } from './session.service';

export type KodeGalat = 'sesi_kedaluwarsa' | 'dibatalkan' | 'email_belum_terverifikasi' | 'akun_nonaktif' | 'konflik_akun' | 'gagal';
export type HasilCallback = { ok: true; sesi: SesiBaru; returnTo: string } | { ok: false; galat: KodeGalat };

/** Hanya jalur relatif satu-origin yang diterima (cegah open redirect). */
export function returnToAman(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 200) return '/';
  if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\') || [...v].some((ch) => ch.charCodeAt(0) < 32)) return '/';
  try {
    const u = new URL(v, 'https://basis.invalid');
    if (u.origin !== 'https://basis.invalid') return '/';
    return u.pathname + u.search;
  } catch {
    return '/';
  }
}

@Injectable()
export class MemberAuthService {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(KUNCI) private readonly kunci: Kunci,
    @Inject(ENV) private readonly env: Env,
    private readonly oidc: OidcService,
    private readonly sesi: SessionService,
    private readonly audit: AuditService,
  ) {}

  tersedia(): boolean {
    return this.oidc.tersedia();
  }

  /** Memulai login: menyimpan transaksi dan mengembalikan URL Google + token pengikat untuk cookie. */
  async mulai(returnToMentah?: unknown): Promise<{ url: string; bindingToken: string }> {
    const state = this.oidc.buatState();
    const nonce = this.oidc.buatNonce();
    const verifier = this.oidc.buatVerifier();
    const challenge = await this.oidc.buatChallenge(verifier);
    const binding = tokenAcak();
    const id = randomUUID();
    const url = await this.oidc.buatUrlOtorisasi({ state, nonce, codeChallenge: challenge });
    await this.pool.query(
      `INSERT INTO oidc_transactions (id, state_hash, binding_hash, nonce, code_verifier_enc, return_to, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 * interval '1 millisecond'))`,
      [id, sha256(state), sha256(binding), nonce, enkripsi(verifier, this.kunci.enkripsi, `oidc:${id}`), returnToAman(returnToMentah), TTL.oidcTransaksiMs],
    );
    await this.pool.query(`DELETE FROM oidc_transactions WHERE expires_at < now() - interval '1 day'`); // bersih-bersih oportunistik
    return { url, bindingToken: binding };
  }

  /** Menyelesaikan login. Semua kegagalan dipetakan ke kode galat ramah-pengguna tanpa detail internal. */
  async selesai(p: { query: URLSearchParams; bindingToken?: string; sesiLama?: SesiAktif; userAgent?: string }): Promise<HasilCallback> {
    const state = p.query.get('state');
    if (!state || !p.bindingToken) return { ok: false, galat: 'sesi_kedaluwarsa' };

    // Konsumsi atomik: hanya satu callback yang dapat memakai transaksi, dan hanya dari browser yang memulainya.
    const t = await this.pool.query(
      `UPDATE oidc_transactions SET consumed_at = now()
        WHERE state_hash = $1 AND binding_hash = $2 AND consumed_at IS NULL AND expires_at > now()
        RETURNING id, nonce, code_verifier_enc, return_to`,
      [sha256(state), sha256(p.bindingToken)],
    );
    if (!t.rowCount) return { ok: false, galat: 'sesi_kedaluwarsa' };

    const galatIdp = p.query.get('error');
    if (galatIdp) {
      await this.audit.catat({ aksi: 'auth.member.login.failed', detail: { alasan: galatIdp === 'access_denied' ? 'dibatalkan' : 'galat_idp' } });
      return { ok: false, galat: galatIdp === 'access_denied' ? 'dibatalkan' : 'gagal' };
    }

    let klaim: KlaimGoogle;
    try {
      const verifier = dekripsi(t.rows[0].code_verifier_enc, this.kunci.enkripsi, `oidc:${t.rows[0].id}`).toString();
      klaim = await this.oidc.tukarKode(p.query, { codeVerifier: verifier, state, nonce: t.rows[0].nonce });
    } catch {
      await this.audit.catat({ aksi: 'auth.member.login.failed', detail: { alasan: 'validasi_token' } });
      return { ok: false, galat: 'gagal' };
    }

    if (klaim.email_verified !== true) {
      await this.audit.catat({ aksi: 'auth.member.login.failed', detail: { alasan: 'email_belum_terverifikasi' } });
      return { ok: false, galat: 'email_belum_terverifikasi' };
    }
    if (typeof klaim.sub !== 'string' || !klaim.sub || klaim.sub.length > 255 || typeof klaim.email !== 'string' || !klaim.email || klaim.email.length > 254) {
      await this.audit.catat({ aksi: 'auth.member.login.failed', detail: { alasan: 'klaim_tidak_lengkap' } });
      return { ok: false, galat: 'gagal' };
    }

    const akun = await this.masukAtauBuat(klaim);
    if (!akun.ok) return { ok: false, galat: akun.galat };

    if (p.sesiLama) await this.sesi.cabut(p.sesiLama.id, 'LOGIN_MEMBER'); // satu browser, satu sesi
    const sesi = await this.sesi.buat({ userId: akun.userId, realm: 'member', state: 'PENUH', userAgent: p.userAgent });
    await this.audit.catat({ aksi: 'auth.member.login.success', aktorId: akun.userId, detail: { baru: akun.baru } });
    return { ok: true, sesi, returnTo: t.rows[0].return_to };
  }

  private async masukAtauBuat(k: KlaimGoogle): Promise<{ ok: true; userId: string; baru: boolean } | { ok: false; galat: KodeGalat }> {
    const email = normalisasiEmail(k.email!);
    for (let percobaan = 0; percobaan < 2; percobaan++) {
      const c = await this.pool.connect();
      try {
        await c.query('BEGIN');
        const hasil = await this.cariAtauBuat(c, k, email);
        await c.query('COMMIT');
        if (!hasil.ok) await this.catatKonflikBilaPerlu(hasil, k, email);
        return hasil.ok ? hasil : { ok: false, galat: hasil.galat };
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        if ((e as { code?: string }).code === '23505' && percobaan === 0) continue; // balapan pembuatan akun: ulangi pencarian
        throw e;
      } finally {
        c.release();
      }
    }
    return { ok: false, galat: 'gagal' };
  }

  private async cariAtauBuat(c: PoolClient, k: KlaimGoogle, email: string): Promise<{ ok: true; userId: string; baru: boolean } | { ok: false; galat: KodeGalat; konflikUserId?: string }> {
    const ada = await c.query(`SELECT u.id, u.status FROM google_identities g JOIN users u ON u.id = g.user_id WHERE g.google_sub = $1`, [k.sub]);
    if (ada.rowCount) {
      if (ada.rows[0].status === 'NONAKTIF') return { ok: false, galat: 'akun_nonaktif' };
      await c.query(`UPDATE google_identities SET last_login_at = now(), email_at_login = $2 WHERE google_sub = $1`, [k.sub, email]);
      return { ok: true, userId: ada.rows[0].id, baru: false };
    }
    // Email sudah dimiliki member lain (sub berbeda): JANGAN tautkan otomatis; masuk antrean tinjauan.
    const sama = await c.query(`SELECT id FROM users WHERE realm = 'member' AND email = $1`, [email]);
    if (sama.rowCount) return { ok: false, galat: 'konflik_akun', konflikUserId: sama.rows[0].id };

    const nama = (typeof k.name === 'string' && k.name.trim() ? k.name.trim() : email.split('@')[0]).slice(0, 100);
    const person = await c.query(`INSERT INTO persons (display_name) VALUES ($1) RETURNING id`, [nama]);
    const user = await c.query(`INSERT INTO users (person_id, realm, email, status) VALUES ($1, 'member', $2, 'AKTIF') RETURNING id`, [person.rows[0].id, email]);
    await c.query(`INSERT INTO google_identities (user_id, google_sub, email_at_login, last_login_at) VALUES ($1, $2, $3, now())`, [user.rows[0].id, k.sub, email]);
    await this.audit.catat({ aksi: 'auth.member.created', aktorId: user.rows[0].id, objek: 'user', objekId: user.rows[0].id });
    return { ok: true, userId: user.rows[0].id, baru: true };
  }

  private async catatKonflikBilaPerlu(h: { galat: KodeGalat; konflikUserId?: string }, k: KlaimGoogle, email: string): Promise<void> {
    if (h.galat !== 'konflik_akun' || !h.konflikUserId) return;
    await this.pool.query(
      `INSERT INTO member_account_conflicts (existing_user_id, sub_hmac, email_hmac)
       VALUES ($1, $2, $3) ON CONFLICT (existing_user_id, sub_hmac) WHERE status = 'MENUNGGU' DO NOTHING`,
      [h.konflikUserId, hmac(this.kunci.hmac, `sub:${k.sub}`), hmac(this.kunci.hmac, `email:${email}`)],
    );
    await this.audit.catat({ aksi: 'auth.member.conflict', objek: 'user', objekId: h.konflikUserId, detail: { alasan: 'email_sudah_dimiliki_akun_google_lain' } });
  }

  get urlAplikasi(): string {
    return this.env.APP_BASE_URL;
  }

  get urlMasuk(): string {
    return `${this.env.APP_BASE_URL}/masuk`;
  }
}
