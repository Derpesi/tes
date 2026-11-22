const apiUrl = process.env.API_URL ?? 'http://localhost:3001';
const dev = process.env.NODE_ENV !== 'production';
// Selfie absensi ditiadakan sementara (bawaan off). Izin kamera hanya dibuka bila ABSENSI_SELFIE=on saat BUILD (header ditanam saat build; samakan dengan API).
const kameraUntukAbsen = process.env.ABSENSI_SELFIE === 'on' ? 'camera=(self)' : 'camera=()';

// Catatan CSP: Next.js menyisipkan skrip/gaya inline sehingga 'unsafe-inline' masih diperlukan (tanpa nonce).
// 'unsafe-eval' hanya di pengembangan. Pengetatan dengan nonce menjadi pekerjaan lanjutan.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", // blob: untuk pratinjau selfie di halaman absen (dibuat dari kamera di perangkat sendiri)
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Same-origin: browser hanya berbicara ke web; /api/* diteruskan ke API (cookie __Host- dan CSRF tetap sederhana).
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }];
  },
  async headers() {
    const umum = [
      { key: 'Content-Security-Policy', value: csp },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
    ];
    return [
      // Lokasi (dan kamera, bila selfie aktif) hanya dibuka untuk halaman absen; halaman lain tetap menutupnya.
      { source: '/absen', headers: [...umum, { key: 'Permissions-Policy', value: `${kameraUntukAbsen}, microphone=(), geolocation=(self)` }] },
      { source: '/:path((?!absen$).*)', headers: [...umum, { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' }] },
    ];
  },
};
export default nextConfig;
