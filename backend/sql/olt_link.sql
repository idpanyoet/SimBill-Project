-- olt_link: mapping ONU (per OLT) -> pelanggan SimBill
-- Catatan: tabel ini OTOMATIS dibuat oleh service saat sync/link pertama.
-- SQL ini cuma referensi kalau mau bikin manual.
CREATE TABLE IF NOT EXISTS olt_link (
  olt_id       varchar(32)  NOT NULL,
  onu_index    varchar(32)  NOT NULL,
  pelanggan_id int(10) unsigned DEFAULT NULL,
  sn           varchar(64)  DEFAULT NULL,
  onu_name     varchar(150) DEFAULT NULL,
  source       enum('manual','sn','username','nama') DEFAULT NULL,
  updated_at   timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (olt_id, onu_index),
  KEY idx_pelanggan (pelanggan_id),
  KEY idx_sn (sn)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
