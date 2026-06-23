-- Tabel mapping device GenieACS ↔ pelanggan SimBill (by serial number)
CREATE TABLE IF NOT EXISTS acs_link (
  serial_number VARCHAR(100) PRIMARY KEY,
  pelanggan_id INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pelanggan (pelanggan_id)
) ENGINE=InnoDB;
