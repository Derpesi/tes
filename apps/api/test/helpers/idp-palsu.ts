// IdP OIDC palsu untuk tes: tanpa jaringan eksternal dan tanpa rahasia nyata.
// Memverifikasi client credentials dan PKCE (S256) pada token endpoint, lalu menandatangani id_token (RS256).
import { createHash, randomBytes } from 'node:crypto';
import { createServer, IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

export interface KlaimUji {
  sub: string;
  email?: string;
  name?: string;
}

export interface OpsiToken {
  iss?: string;
  aud?: string;
  /** Selisih detik exp terhadap sekarang (negatif = kedaluwarsa). Bawaan +300. */
  expDetik?: number;
  nonce?: string;
  /** Tandatangani dengan kunci yang TIDAK ada di JWKS. */
  kunciLain?: boolean;
  /** Nilai email_verified (boolean atau string untuk menguji ketegasan). Bawaan true. */
  emailVerified?: boolean | string;
  /** Token endpoint menolak (invalid_grant). */
  tolakToken?: boolean;
}

interface KodeTerbit {
  klaim: KlaimUji;
  opsi: OpsiToken;
  nonce: string;
  challenge: string;
  redirectUri: string;
  dipakai: boolean;
}

export interface IdpPalsu {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Meniru Google: menerima URL otorisasi, menerbitkan kode, mengembalikan query callback (code & state). */
  terbitkanKode(urlOtorisasi: string, klaim: KlaimUji, opsi?: OpsiToken): { query: string; params: URLSearchParams };
  /** Riwayat permintaan token (untuk memastikan PKCE dikirim). */
  permintaanToken: { pkceOk: boolean; clientOk: boolean }[];
  berhenti(): Promise<void>;
}

const b64u = (b: Buffer) => b.toString('base64url');

async function bacaForm(req: IncomingMessage): Promise<URLSearchParams> {
  const potongan: Buffer[] = [];
  for await (const p of req) potongan.push(p as Buffer);
  return new URLSearchParams(Buffer.concat(potongan).toString());
}

export async function mulaiIdpPalsu(): Promise<IdpPalsu> {
  const utama = await generateKeyPair('RS256');
  const lain = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(utama.publicKey)), kid: 'kunci-utama', alg: 'RS256', use: 'sig' };
  const clientId = `klien-uji-${randomBytes(4).toString('hex')}.apps.contoh.invalid`;
  const clientSecret = randomBytes(24).toString('base64url');
  const daftarKode = new Map<string, KodeTerbit>();
  const permintaanToken: IdpPalsu['permintaanToken'] = [];
  let issuer = '';

  const server: Server = createServer(async (req, res) => {
    const kirimJson = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', issuer || 'http://127.0.0.1');
    try {
      if (url.pathname === '/.well-known/openid-configuration') {
        return kirimJson(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: ['openid', 'email', 'profile'],
        });
      }
      if (url.pathname === '/jwks') return kirimJson(200, { keys: [jwk] });
      if (url.pathname === '/token' && req.method === 'POST') {
        const f = await bacaForm(req);
        const rec = daftarKode.get(f.get('code') ?? '');
        const clientOk = f.get('client_id') === clientId && f.get('client_secret') === clientSecret;
        const pkceOk = !!rec && b64u(createHash('sha256').update(f.get('code_verifier') ?? '').digest()) === rec.challenge;
        permintaanToken.push({ pkceOk, clientOk });
        if (!clientOk) return kirimJson(401, { error: 'invalid_client' });
        if (!rec || rec.dipakai || f.get('grant_type') !== 'authorization_code' || f.get('redirect_uri') !== rec.redirectUri || !pkceOk || rec.opsi.tolakToken) {
          return kirimJson(400, { error: 'invalid_grant' });
        }
        rec.dipakai = true; // kode sekali pakai
        const o = rec.opsi;
        const sekarang = Math.floor(Date.now() / 1000);
        const idToken = await new SignJWT({
          email: rec.klaim.email,
          email_verified: o.emailVerified ?? true,
          name: rec.klaim.name,
          nonce: o.nonce ?? rec.nonce,
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'kunci-utama' })
          .setIssuer(o.iss ?? issuer)
          .setAudience(o.aud ?? clientId)
          .setSubject(rec.klaim.sub)
          .setIssuedAt(sekarang - 5)
          .setExpirationTime(sekarang + (o.expDetik ?? 300))
          .sign(o.kunciLain ? lain.privateKey : utama.privateKey);
        return kirimJson(200, { access_token: 'token-akses-sintetis', token_type: 'Bearer', expires_in: 3600, id_token: idToken });
      }
      res.writeHead(404).end();
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    permintaanToken,
    terbitkanKode(urlOtorisasi, klaim, opsi = {}) {
      const p = new URL(urlOtorisasi).searchParams;
      const code = randomBytes(16).toString('base64url');
      daftarKode.set(code, {
        klaim,
        opsi,
        nonce: p.get('nonce') ?? '',
        challenge: p.get('code_challenge') ?? '',
        redirectUri: p.get('redirect_uri') ?? '',
        dipakai: false,
      });
      const q = new URLSearchParams({ code, state: p.get('state') ?? '' });
      return { query: q.toString(), params: p };
    },
    berhenti: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
