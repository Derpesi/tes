-- Up Migration
-- Fase 7C: akses sempit untuk alur absen member (member tidak punya scope perusahaan). Dua kebijakan baca yang hanya terbuka bila
-- kode server menyetel variabel transaksi (tidak dapat disetel klien), serta satu fungsi untuk retensi.

-- Kode QR = pengenal titik (bukan rahasia). Member yang memindai QR harus dapat mengenali titiknya meski belum ditempatkan di sana,
-- agar dapat diberi alasan penolakan yang jelas (403). Hanya baris dengan kode yang sama persis yang terbuka.
CREATE POLICY titik_baca_kode ON attendance_points FOR SELECT USING (public_code::text = NULLIF(current_setting('app.titik_kode', true), ''));

-- Menghitung akun berbeda pada satu perangkat (deteksi berbagi perangkat). Kode server hanya menghitung; id perangkat berupa HMAC.
CREATE POLICY perangkat_baca_hash ON device_registrations FOR SELECT USING (device_hash = NULLIF(current_setting('app.perangkat_hash', true), ''));

-- Retensi selfie (hari) per perusahaan dari document_settings.selfieRetentionDays; bawaan 90, dibatasi 7..3650.
CREATE FUNCTION retensi_selfie_hari(p_company uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT GREATEST(7, LEAST(3650, COALESCE((SELECT (c.document_settings ->> 'selfieRetentionDays')::integer FROM companies c WHERE c.id = p_company AND (c.document_settings ->> 'selfieRetentionDays') ~ '^[0-9]{1,4}$'), 90)))
$$;

-- Down Migration
DROP FUNCTION retensi_selfie_hari(uuid);
DROP POLICY perangkat_baca_hash ON device_registrations;
DROP POLICY titik_baca_kode ON attendance_points;
