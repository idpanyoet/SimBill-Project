-- =============================================================================
-- Migrasi: Shared Users (Simultaneous-Use) per paket
-- Tanggal : 2026-06-23
-- Tujuan  : Menambah kolom `share_users` ke tabel paket. Nilai = jumlah maksimum
--           HP/perangkat yang boleh login bersamaan memakai 1 akun (FreeRADIUS
--           Simultaneous-Use). Default 1 (single device).
--
-- Aman dijalankan berulang: pakai prosedur cek kolom (MariaDB tak punya
-- "ADD COLUMN IF NOT EXISTS" di semua versi). Jalankan di database billing.
--   mysql -u root -p billing_radius < migration_share_users.sql
-- =============================================================================

DROP PROCEDURE IF EXISTS _add_share_users;
DELIMITER //
CREATE PROCEDURE _add_share_users()
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'paket'
          AND COLUMN_NAME = 'share_users'
    ) THEN
        ALTER TABLE paket
            ADD COLUMN share_users INT UNSIGNED NOT NULL DEFAULT 1
            COMMENT 'Max HP/perangkat simultan per akun (Simultaneous-Use)'
            AFTER tipe;
    END IF;
END //
DELIMITER ;

CALL _add_share_users();
DROP PROCEDURE IF EXISTS _add_share_users;

-- Paket lama otomatis bernilai 1 (single device) — perilaku setara seperti
-- sebelumnya. Naikkan per paket hotspot yang ingin di-share, mis.:
--   UPDATE paket SET share_users = 4 WHERE id = 7;
-- Lalu terapkan ke user existing lewat tombol "Terapkan Shared Users" di panel,
-- atau: POST /api/radius/sync-share
