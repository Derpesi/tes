-- Up Migration
-- Koreksi matriks (Fase 4A), mengikuti docs/rbac.md:
--  * Perusahaan: IT Administrator mendapat C (membuat perusahaan; aktivasi disetujui Direktur).
--  * Rekanan & lokasi: Manager Operasional mendapat D (menonaktifkan rekanan/lokasi).
--  * Modul baru "Dokumen legalitas perusahaan" (akta/NIB lebih sensitif daripada profil perusahaan).
INSERT INTO permissions (code, description) VALUES
  ('company.create', 'Perusahaan: create'),
  ('partner.deactivate', 'Rekanan & lokasi: deactivate'),
  ('company_document.view', 'Dokumen legalitas perusahaan: view'),
  ('company_document.create', 'Dokumen legalitas perusahaan: create'),
  ('company_document.update', 'Dokumen legalitas perusahaan: update');
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('IT_ADMIN', 'company.create'),
  ('MANAGER_OPERASIONAL', 'partner.deactivate'),
  ('DIREKTUR', 'company_document.view'),
  ('IT_ADMIN', 'company_document.view'),
  ('IT_ADMIN', 'company_document.create'),
  ('IT_ADMIN', 'company_document.update'),
  ('STAFF_ADMINISTRASI', 'company_document.view'),
  ('STAFF_ADMINISTRASI', 'company_document.create'),
  ('STAFF_ADMINISTRASI', 'company_document.update'),
  ('STAFF_KEUANGAN', 'company_document.view');

-- Down Migration
DELETE FROM role_permissions WHERE permission_code IN ('company.create', 'partner.deactivate', 'company_document.view', 'company_document.create', 'company_document.update');
DELETE FROM permissions WHERE code IN ('company.create', 'partner.deactivate', 'company_document.view', 'company_document.create', 'company_document.update');
