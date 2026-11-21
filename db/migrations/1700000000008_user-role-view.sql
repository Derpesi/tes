-- Up Migration
-- Koreksi matriks (Fase 3D): izin melihat daftar pengguna, peran, dan persetujuan untuk Direktur dan IT Administrator.
INSERT INTO permissions (code, description) VALUES ('user_role.view', 'Pengguna & role: view');
INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('DIREKTUR', 'user_role.view'),
  ('IT_ADMIN', 'user_role.view');

-- Down Migration
DELETE FROM role_permissions WHERE permission_code = 'user_role.view';
DELETE FROM permissions WHERE code = 'user_role.view';
