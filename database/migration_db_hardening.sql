-- ============================================================
-- SimBill — Migrasi DB Hardening (hasil audit DB, 9 Jul 2026)
-- Jalankan pada DB produksi EXISTING:
--     mysqldump billing_radius > /root/backup-sebelum-hardening.sql   # BACKUP DULU
--     mysql billing_radius < database/migration_db_hardening.sql
-- Aman diulang (idempoten). TIDAK menghapus data pada bagian WAJIB.
-- ============================================================

-- ------------------------------------------------------------
-- [WAJIB #1] radacct.nasportid : VARCHAR(15) -> VARCHAR(64)   (HIGH)
-- NAS-Port-Id dari OLT/MikroTik bisa > 15 karakter. Kalau kolom hanya 15,
-- INSERT accounting GAGAL ("Data too long for column 'nasportid'") -> sesi
-- tidak tercatat di radacct (traffic/laporan bolong). Produksi nyOet sudah
-- dipatch manual, TAPI schema.sql fresh-install masih 15 -> VPS customer baru
-- kena bug lagi. Migrasi ini menyamakan semua ke 64.
-- Perubahan metadata-only (VARCHAR <= 255) => INSTANT/INPLACE, praktis tanpa lock
-- walau radacct jutaan baris.
-- ------------------------------------------------------------
SET @len := (SELECT CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='radacct' AND COLUMN_NAME='nasportid');
SET @sql := IF(@len IS NOT NULL AND @len < 64,
    'ALTER TABLE radacct MODIFY nasportid VARCHAR(64) DEFAULT NULL, ALGORITHM=INPLACE, LOCK=NONE',
    'SELECT ''nasportid sudah >= 64, dilewati''');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
-- Catatan: bila server menolak ALGORITHM=INPLACE (versi lama), jalankan manual:
--   ALTER TABLE radacct MODIFY nasportid VARCHAR(64) DEFAULT NULL;

-- ------------------------------------------------------------
-- [WAJIB #2] Index komposit pelanggan(status, tgl_expired)     (perf)
-- Cron auto-suspend & generate-bulanan memfilter status='aktif' + rentang
-- tgl_expired. Dua index tunggal (status, tgl_expired) tak seefisien satu
-- komposit. Ringan, tak mengubah data.
-- ------------------------------------------------------------
SET @idx := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pelanggan'
             AND INDEX_NAME='pelanggan_status_expired');
SET @sql := IF(@idx=0,
    'ALTER TABLE pelanggan ADD KEY pelanggan_status_expired (status, tgl_expired)',
    'SELECT ''index pelanggan_status_expired sudah ada, dilewati''');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ------------------------------------------------------------
-- [WAJIB #3] Index komposit invoice(pelanggan_id, status)      (perf)
-- Query portal pelanggan & tagihan per-pelanggan sering filter pelanggan_id
-- + status. Membantu /perpanjang (cari invoice unpaid pelanggan).
-- ------------------------------------------------------------
SET @idx := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='invoice'
             AND INDEX_NAME='invoice_pelanggan_status');
SET @sql := IF(@idx=0,
    'ALTER TABLE invoice ADD KEY invoice_pelanggan_status (pelanggan_id, status)',
    'SELECT ''index invoice_pelanggan_status sudah ada, dilewati''');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SELECT '✅ Migrasi WAJIB selesai (nasportid 64 + 2 index komposit).' AS hasil;

-- ============================================================
-- ============================================================
--  BAGIAN OPSIONAL — INTEGRITAS REFERENSIAL (FK)
--  JANGAN jalankan membabi buta. Baca dulu, cek orphan, baru eksekusi.
--  Tabel "era-app" (tiket, tiket_reply, acs_device, acs_task) dibuat dengan
--  kolom INT (signed) tanpa FOREIGN KEY, sedangkan pelanggan.id = INT UNSIGNED.
--  Akibat: (a) tak ada FK -> hapus pelanggan meninggalkan baris yatim (orphan);
--          (b) mismatch signed/unsigned -> tak bisa pasang FK sebelum diselaraskan.
--  Fix: selaraskan tipe -> INT UNSIGNED, bersihkan orphan, lalu tambah FK.
--  Semua tabel ini kecil (bukan radacct) jadi ALTER cepat.
-- ============================================================

-- ---- Langkah A: LIHAT orphan dulu (hanya SELECT, tak mengubah apa pun) ----
-- SELECT COUNT(*) AS tiket_orphan FROM tiket t
--   LEFT JOIN pelanggan p ON t.pelanggan_id=p.id WHERE p.id IS NULL;
-- SELECT COUNT(*) AS acs_orphan FROM acs_device a
--   LEFT JOIN pelanggan p ON a.pelanggan_id=p.id WHERE a.pelanggan_id IS NOT NULL AND p.id IS NULL;
-- SELECT COUNT(*) AS reply_orphan FROM tiket_reply r
--   LEFT JOIN tiket t ON r.tiket_id=t.id WHERE t.id IS NULL;
-- SELECT COUNT(*) AS task_orphan FROM acs_task k
--   LEFT JOIN acs_device d ON k.device_id=d.id WHERE d.id IS NULL;

-- ---- Langkah B: BERSIHKAN orphan (setelah yakin dari langkah A) ----
-- acs_device: pelanggan_id nullable -> set NULL saja (jangan hapus device):
-- UPDATE acs_device a LEFT JOIN pelanggan p ON a.pelanggan_id=p.id
--   SET a.pelanggan_id=NULL WHERE a.pelanggan_id IS NOT NULL AND p.id IS NULL;
-- tiket / reply / task: hapus yatim (tak ada induk valid):
-- DELETE r FROM tiket_reply r LEFT JOIN tiket t ON r.tiket_id=t.id WHERE t.id IS NULL;
-- DELETE t FROM tiket t LEFT JOIN pelanggan p ON t.pelanggan_id=p.id WHERE p.id IS NULL;
-- DELETE k FROM acs_task k LEFT JOIN acs_device d ON k.device_id=d.id WHERE d.id IS NULL;

-- ---- Langkah C: SELARASKAN TIPE + PASANG FK ----
-- ALTER TABLE tiket        MODIFY pelanggan_id INT UNSIGNED NOT NULL;
-- ALTER TABLE acs_device   MODIFY pelanggan_id INT UNSIGNED DEFAULT NULL;
-- ALTER TABLE tiket_reply  MODIFY tiket_id     INT UNSIGNED NOT NULL;
-- ALTER TABLE tiket        MODIFY id INT UNSIGNED NOT NULL AUTO_INCREMENT;
-- ALTER TABLE acs_device   MODIFY id INT UNSIGNED NOT NULL AUTO_INCREMENT;
-- ALTER TABLE acs_task     MODIFY device_id INT UNSIGNED NOT NULL;
-- ALTER TABLE tiket
--   ADD CONSTRAINT fk_tiket_pelanggan FOREIGN KEY (pelanggan_id) REFERENCES pelanggan(id) ON DELETE CASCADE;
-- ALTER TABLE acs_device
--   ADD CONSTRAINT fk_acs_pelanggan FOREIGN KEY (pelanggan_id) REFERENCES pelanggan(id) ON DELETE SET NULL;
-- ALTER TABLE tiket_reply
--   ADD CONSTRAINT fk_reply_tiket FOREIGN KEY (tiket_id) REFERENCES tiket(id) ON DELETE CASCADE;
-- ALTER TABLE acs_task
--   ADD CONSTRAINT fk_task_device FOREIGN KEY (device_id) REFERENCES acs_device(id) ON DELETE CASCADE;

-- ============================================================
--  BAGIAN OPSIONAL — IDEMPOTENSI LOG PEMBAYARAN (defense-in-depth)
--  payment_log.order_id TIDAK unik. Webhook memakai cek "SELECT lalu INSERT"
--  (check-then-insert) yang rawan baris log dobel saat gateway retry cepat.
--  UNIQUE(order_id, status) membuat log idempoten di level DB. TAPI kalau sudah
--  ada baris dobel, tambah UNIQUE akan GAGAL -> dedupe dulu.
--  Ini tabel LOG (bukan uang), jadi murni kerapian. Opsional.
-- ============================================================
-- -- dedupe (sisakan id terkecil per order_id+status):
-- DELETE pl FROM payment_log pl
--   JOIN payment_log keep
--     ON pl.order_id<=>keep.order_id AND pl.status<=>keep.status AND pl.id>keep.id;
-- ALTER TABLE payment_log ADD UNIQUE KEY uniq_order_status (order_id, status);
