-- Jalankan ini SEBELUM import ulang schema.sql, untuk membersihkan
-- kemungkinan tabel reseller yang sudah setengah jadi dari percobaan
-- import sebelumnya (termasuk index dengan nama lama yang konflik).
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS reseller_harga;
DROP TABLE IF EXISTS reseller_transaksi;
DROP TABLE IF EXISTS reseller_topup;
DROP TABLE IF EXISTS reseller_mutasi;
DROP TABLE IF EXISTS reseller;
SET FOREIGN_KEY_CHECKS = 1;
