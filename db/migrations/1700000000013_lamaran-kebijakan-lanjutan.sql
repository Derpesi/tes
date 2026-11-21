-- Up Migration
-- Fase 5D: (1) member tetap dapat membaca lowongan yang PERNAH ia lamar (mis. sudah ditutup) agar daftar lamarannya bermakna;
-- (2) melamar hanya ke lowongan yang SEDANG DIBUKA (sebelumnya cukup "terlihat", yang kini mencakup lowongan yang pernah dilamar).
CREATE POLICY lowongan_baca_pelamar ON job_vacancies FOR SELECT
  USING (EXISTS (SELECT 1 FROM job_applications a WHERE a.vacancy_id = job_vacancies.id AND a.person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid));

DROP POLICY lamaran_buat_milik ON job_applications;
CREATE POLICY lamaran_buat_milik ON job_applications FOR INSERT
  WITH CHECK (
    person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid
    AND status = 'DIAJUKAN'
    AND EXISTS (
      SELECT 1 FROM job_vacancies v
       WHERE v.id = vacancy_id AND v.company_id = job_applications.company_id
         AND v.status = 'DIBUKA' AND (v.closes_on IS NULL OR v.closes_on >= current_date)));

-- Down Migration
DROP POLICY lamaran_buat_milik ON job_applications;
CREATE POLICY lamaran_buat_milik ON job_applications FOR INSERT
  WITH CHECK (
    person_id = NULLIF(current_setting('app.member_person_id', true), '')::uuid
    AND status = 'DIAJUKAN'
    AND EXISTS (SELECT 1 FROM job_vacancies v WHERE v.id = vacancy_id AND v.company_id = job_applications.company_id));
DROP POLICY lowongan_baca_pelamar ON job_vacancies;
