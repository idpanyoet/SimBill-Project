-- migration_voucher_username_password.sql
-- ============================================================
-- Migrasi tabel `voucher` dari skema LAMA (kolom tunggal `kode`)
-- ke skema BARU (kolom terpisah `username` + `password`).
--
-- Aman dijalankan di database yang sudah berjalan — data voucher
-- yang sudah ada TIDAK akan hilang. Voucher lama akan otomatis
-- diisi username = password = kode lama, supaya tetap bisa dipakai
-- (mode "Username = Password").
--
-- Jika database Anda sudah memakai skema baru (baru install dari
-- schema.sql terbaru), script ini akan langsung berhenti tanpa
-- melakukan apapun — aman dijalankan berkali-kali.
-- ============================================================

-- Cek dulu: apakah kolom `kode` masih ada? Jika tidak ada, berarti
-- tabel sudah memakai skema baru, dan migrasi ini tidak diperlukan.
SET @kode_ada = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'voucher' AND COLUMN_NAME = 'kode'
);

-- 1. Tambah kolom username & password (nullable dulu, supaya tidak
--    gagal saat tabel sudah berisi data dari skema lama).
SET @sql := IF(@kode_ada > 0,
    'ALTER TABLE voucher ADD COLUMN username VARCHAR(32) NULL AFTER id, ADD COLUMN password VARCHAR(32) NULL AFTER username',
    'SELECT "Kolom kode tidak ditemukan, skema sudah terbaru — migrasi dilewati" AS info');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. Salin data lama: username = password = kode (mode username=password)
SET @sql := IF(@kode_ada > 0,
    'UPDATE voucher SET username = kode, password = kode WHERE username IS NULL',
    'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. Hapus kolom `kode` yang lama, lalu jadikan username/password NOT NULL + UNIQUE
SET @sql := IF(@kode_ada > 0,
    'ALTER TABLE voucher DROP COLUMN kode, MODIFY COLUMN username VARCHAR(32) NOT NULL, MODIFY COLUMN password VARCHAR(32) NOT NULL, ADD UNIQUE KEY username (username)',
    'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'Migrasi voucher selesai. Voucher lama tetap bisa dipakai dengan username=password=kode lama.' AS hasil;
