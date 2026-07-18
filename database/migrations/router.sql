-- Tabel router MikroTik — kredensial API (port 8728/8729)
-- Dipakai untuk membaca /ppp active (deteksi pelanggan nyangkut) & memutus sesi.
-- Password DISIMPAN TERENKRIPSI (AES) — lihat services/mikrotik.js.
--
-- CATATAN KEAMANAN:
--   Jangan pernah ekspos port API (8728) ke internet. Akses HANYA lewat jaringan
--   internal/VPN (mis. 10.10.29.x). Port API pernah jadi sasaran brute-force.
--   Disarankan buat user MikroTik khusus dengan hak terbatas (group: read + write
--   untuk ppp saja), bukan user `admin` penuh.

CREATE TABLE IF NOT EXISTS router (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    nama         VARCHAR(64)  NOT NULL,                  -- mis. IDI-X86
    ip           VARCHAR(64)  NOT NULL,                  -- mis. 10.10.29.2
    port         INT          NOT NULL DEFAULT 8728,     -- 8728 (API) / 8729 (API-SSL)
    pakai_ssl    TINYINT(1)   NOT NULL DEFAULT 0,
    api_user     VARCHAR(64)  NOT NULL,
    api_pass     TEXT         NOT NULL,                  -- terenkripsi
    aktif        TINYINT(1)   NOT NULL DEFAULT 1,
    keterangan   VARCHAR(191) DEFAULT NULL,
    last_ok      DATETIME     DEFAULT NULL,              -- terakhir koneksi sukses
    last_error   VARCHAR(255) DEFAULT NULL,
    dibuat       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_router_ip_port (ip, port),
    KEY idx_router_aktif (aktif)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
