import { Inject, Injectable, Logger } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import * as client from 'openid-client';
import { ENV } from '../config/config.module';
import { Env, redirectUriGoogle } from '../config/env';

export interface KlaimGoogle {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

/** Pembungkus openid-client (Authorization Code + PKCE). Tidak menyimpan access/refresh token Google. */
@Injectable()
export class OidcService {
  private readonly log = new Logger(OidcService.name);
  private konfig?: Promise<client.Configuration>;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(@Inject(ENV) private readonly env: Env) {}

  tersedia(): boolean {
    return !!(this.env.GOOGLE_CLIENT_ID && this.env.GOOGLE_CLIENT_SECRET);
  }

  get redirectUri(): string {
    return redirectUriGoogle(this.env);
  }

  private konfigurasi(): Promise<client.Configuration> {
    if (!this.konfig) {
      // http hanya diizinkan untuk IdP palsu di lingkungan tes; produksi dikunci ke https://accounts.google.com.
      const izinkanHttp = this.env.NODE_ENV === 'test' && this.env.GOOGLE_ISSUER.startsWith('http:');
      this.konfig = client
        .discovery(new URL(this.env.GOOGLE_ISSUER), this.env.GOOGLE_CLIENT_ID!, this.env.GOOGLE_CLIENT_SECRET!, undefined, izinkanHttp ? { execute: [client.allowInsecureRequests] } : undefined)
        .catch((e) => {
          this.konfig = undefined; // coba lagi pada permintaan berikutnya
          throw e;
        });
    }
    return this.konfig;
  }

  buatState = client.randomState;
  buatNonce = client.randomNonce;
  buatVerifier = client.randomPKCECodeVerifier;
  buatChallenge = client.calculatePKCECodeChallenge;

  async buatUrlOtorisasi(p: { state: string; nonce: string; codeChallenge: string }): Promise<string> {
    const cfg = await this.konfigurasi();
    return client
      .buildAuthorizationUrl(cfg, {
        redirect_uri: this.redirectUri,
        scope: 'openid email profile',
        code_challenge: p.codeChallenge,
        code_challenge_method: 'S256',
        state: p.state,
        nonce: p.nonce,
        prompt: 'select_account', // perangkat bersama: selalu minta pilih akun
      })
      .toString();
  }

  /**
   * Menukar kode otorisasi. openid-client memvalidasi state, nonce, PKCE, serta iss/aud/exp/tanda tangan id_token.
   * `query` adalah query string callback; URL dibangun dari konfigurasi tepercaya (bukan header Host permintaan).
   */
  async tukarKode(query: URLSearchParams, p: { codeVerifier: string; state: string; nonce: string }): Promise<KlaimGoogle> {
    const cfg = await this.konfigurasi();
    const url = new URL(this.redirectUri);
    url.search = query.toString();
    try {
      const tokens = await client.authorizationCodeGrant(cfg, url, { pkceCodeVerifier: p.codeVerifier, expectedState: p.state, expectedNonce: p.nonce, idTokenExpected: true });
      const klaim = tokens.claims();
      if (!klaim || !tokens.id_token) throw new Error('id_token tidak ada');
      // Pertahanan berlapis: openid-client mengandalkan TLS untuk id_token dari token endpoint (sah menurut
      // OIDC Core). Kita tetap memverifikasi tanda tangan, iss, dan aud dengan JWKS penerbit.
      const meta = cfg.serverMetadata();
      this.jwks ??= createRemoteJWKSet(new URL(meta.jwks_uri!));
      await jwtVerify(tokens.id_token, this.jwks, { issuer: meta.issuer, audience: this.env.GOOGLE_CLIENT_ID!, algorithms: ['RS256'], clockTolerance: 30 });
      return klaim as unknown as KlaimGoogle; // token akses dibuang; hanya klaim identitas yang dipakai
    } catch (e) {
      // Jangan mencatat pesan/respons lengkap (dapat memuat kode atau token); cukup jenis galat.
      this.log.warn(`Penukaran kode OIDC gagal: ${(e as Error).name}`);
      throw e;
    }
  }
}
