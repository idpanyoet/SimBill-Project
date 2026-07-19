-- ============================================================
-- MIGRATION: Tambah kolom-kolom baru yang mungkin belum ada
-- Jalankan: mysql -u root -p nama_database < migration_kolom_baru.sql
-- Aman dijalankan berkali-kali (cek sebelum ALTER)
-- ============================================================

-- 1. satuan_masa di tabel paket (Jam/Hari/Bulan)
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paket' AND COLUMN_NAME='satuan_masa');
SET @s = IF(@c=0,
    "ALTER TABLE paket ADD COLUMN satuan_masa ENUM('jam','hari','bulan') NOT NULL DEFAULT 'hari' AFTER masa_aktif",
    'SELECT "satuan_masa sudah ada"');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 2. username di tabel voucher
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='voucher' AND COLUMN_NAME='username');
SET @s = IF(@c=0,
    'ALTER TABLE voucher ADD COLUMN username VARCHAR(32) UNIQUE AFTER id',
    'SELECT "voucher.username sudah ada"');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- 3. password di tabel voucher
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='voucher' AND COLUMN_NAME='password');
SET @s = IF(@c=0,
    'ALTER TABLE voucher ADD COLUMN password VARCHAR(32) AFTER username',
    'SELECT "voucher.password sudah ada"');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Selesai
SELECT 'Migration selesai!' AS status;
