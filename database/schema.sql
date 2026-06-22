-- ============================================================
-- BILLING RADIUS PPPoE/HOTSPOT - DATABASE SCHEMA
-- Database: MariaDB / MySQL 8+
-- Compatible with FreeRADIUS raddb/mods-config/sql/main/mysql
-- ============================================================

CREATE DATABASE IF NOT EXISTS billing_radius CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE billing_radius;

-- ============================================================
-- FREERADIUS CORE TABLES (required by FreeRADIUS)
-- ============================================================

CREATE TABLE IF NOT EXISTS radcheck (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    username     VARCHAR(64) NOT NULL DEFAULT '',
    attribute    VARCHAR(64) NOT NULL DEFAULT '',
    op           CHAR(2)     NOT NULL DEFAULT '==',
    value        VARCHAR(253) NOT NULL DEFAULT '',
    PRIMARY KEY (id),
    KEY radcheck_username (username(32))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS radreply (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    username     VARCHAR(64) NOT NULL DEFAULT '',
    attribute    VARCHAR(64) NOT NULL DEFAULT '',
    op           CHAR(2)     NOT NULL DEFAULT '=',
    value        VARCHAR(253) NOT NULL DEFAULT '',
    PRIMARY KEY (id),
    KEY radreply_username (username(32))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS radgroupcheck (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    groupname    VARCHAR(64) NOT NULL DEFAULT '',
    attribute    VARCHAR(64) NOT NULL DEFAULT '',
    op           CHAR(2)     NOT NULL DEFAULT '==',
    value        VARCHAR(253) NOT NULL DEFAULT '',
    PRIMARY KEY (id),
    KEY radgroupcheck_groupname (groupname(32))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS radgroupreply (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    groupname    VARCHAR(64) NOT NULL DEFAULT '',
    attribute    VARCHAR(64) NOT NULL DEFAULT '',
    op           CHAR(2)     NOT NULL DEFAULT '=',
    value        VARCHAR(253) NOT NULL DEFAULT '',
    PRIMARY KEY (id),
    KEY radgroupreply_groupname (groupname(32))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS radusergroup (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    username     VARCHAR(64) NOT NULL DEFAULT '',
    groupname    VARCHAR(64) NOT NULL DEFAULT '',
    priority     INT NOT NULL DEFAULT 1,
    PRIMARY KEY (id),
    KEY radusergroup_username (username(32))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS radacct (
    radacctid         BIGINT(21) NOT NULL AUTO_INCREMENT,
    acctsessionid     VARCHAR(64) NOT NULL DEFAULT '',
    acctuniqueid      VARCHAR(32) NOT NULL DEFAULT '',
    username          VARCHAR(64) NOT NULL DEFAULT '',
    groupname         VARCHAR(64) NOT NULL DEFAULT '',
    realm             VARCHAR(64) DEFAULT '',
    nasipaddress      VARCHAR(15) NOT NULL DEFAULT '',
    nasportid         VARCHAR(15) DEFAULT NULL,
    nasporttype       VARCHAR(32) DEFAULT NULL,
    acctstarttime     DATETIME NULL DEFAULT NULL,
    acctupdatetime    DATETIME NULL DEFAULT NULL,
    acctstoptime      DATETIME NULL DEFAULT NULL,
    acctinterval      INT(12) DEFAULT NULL,
    acctsessiontime   INT(12) UNSIGNED DEFAULT NULL,
    acctauthentic     VARCHAR(32) DEFAULT NULL,
    connectinfo_start VARCHAR(50) DEFAULT NULL,
    connectinfo_stop  VARCHAR(50) DEFAULT NULL,
    acctinputoctets   BIGINT(20) DEFAULT NULL,
    acctoutputoctets  BIGINT(20) DEFAULT NULL,
    calledstationid   VARCHAR(50) NOT NULL DEFAULT '',
    callingstationid  VARCHAR(50) NOT NULL DEFAULT '',
    acctterminatecause VARCHAR(32) NOT NULL DEFAULT '',
    servicetype       VARCHAR(32) DEFAULT NULL,
    framedprotocol    VARCHAR(32) DEFAULT NULL,
    framedipaddress   VARCHAR(15) NOT NULL DEFAULT '',
    framedipv6address   VARCHAR(45) DEFAULT NULL,
    framedipv6prefix    VARCHAR(45) DEFAULT NULL,
    framedinterfaceid   VARCHAR(44) DEFAULT NULL,
    delegatedipv6prefix VARCHAR(45) DEFAULT NULL,
    PRIMARY KEY (radacctid),
    UNIQUE KEY radacct_acctuniqueid (acctuniqueid),
    KEY radacct_username (username),
    KEY radacct_framedipaddress (framedipaddress),
    KEY radacct_acctsessionid (acctsessionid),
    KEY radacct_acctstarttime (acctstarttime),
    KEY radacct_acctstoptime (acctstoptime),
    KEY radacct_nasipaddress (nasipaddress)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS nas (
    id           INT(10) NOT NULL AUTO_INCREMENT,
    nasname      VARCHAR(128) NOT NULL,
    shortname    VARCHAR(32),
    type         VARCHAR(30) DEFAULT 'other',
    ports        INT(5),
    secret       VARCHAR(60) NOT NULL DEFAULT 'secret',
    server       VARCHAR(64),
    community    VARCHAR(50),
    description  VARCHAR(200) DEFAULT 'RADIUS Client',
    PRIMARY KEY (id),
    KEY nas_nasname (nasname)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS radpostauth (
    id           INT(11) NOT NULL AUTO_INCREMENT,
    username     VARCHAR(64) NOT NULL DEFAULT '',
    pass         VARCHAR(64) NOT NULL DEFAULT '',
    reply        VARCHAR(32) NOT NULL DEFAULT '',
    authdate     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY radpostauth_username (username),
    KEY radpostauth_authdate (authdate)
) ENGINE=InnoDB;

-- ============================================================
-- BILLING APPLICATION TABLES
-- ============================================================

-- Paket Internet
CREATE TABLE paket (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    nama         VARCHAR(100) NOT NULL,
    kecepatan_up INT UNSIGNED NOT NULL COMMENT 'Upload Mbps',
    kecepatan_dn INT UNSIGNED NOT NULL COMMENT 'Download Mbps',
    harga        DECIMAL(12,2) NOT NULL,
    masa_aktif   INT NOT NULL DEFAULT 30 COMMENT 'nilai masa berlaku',
    satuan_masa  ENUM('jam','hari','bulan') NOT NULL DEFAULT 'hari' COMMENT 'satuan masa berlaku',
    pool_name    VARCHAR(64) COMMENT 'RADIUS IP Pool',
    tipe         ENUM('pppoe','hotspot','keduanya') NOT NULL DEFAULT 'keduanya',
    burst_limit  VARCHAR(32) COMMENT 'MikroTik burst limit',
    burst_time   VARCHAR(32) COMMENT 'MikroTik burst time',
    aktif        TINYINT(1) NOT NULL DEFAULT 1,
    deskripsi    TEXT,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB;

-- Pelanggan
CREATE TABLE pelanggan (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    nama         VARCHAR(150) NOT NULL,
    username     VARCHAR(64) NOT NULL UNIQUE COMMENT 'RADIUS username',
    password     VARCHAR(255) NOT NULL COMMENT 'bcrypt hash untuk login ke aplikasi (jika reseller/portal pelanggan login)',
    radius_password_enc VARCHAR(255) COMMENT 'Password RADIUS terenkripsi AES (reversible), dipulihkan saat suspend->aktif',
    no_hp        VARCHAR(20) NOT NULL COMMENT 'Format 628xxx untuk WA',
    email        VARCHAR(150),
    alamat       TEXT,
    paket_id     INT UNSIGNED NOT NULL,
    tipe_koneksi ENUM('pppoe','hotspot') NOT NULL DEFAULT 'pppoe',
    tgl_aktif    DATE,
    tgl_expired  DATE,
    status       ENUM('aktif','suspended','nonaktif') NOT NULL DEFAULT 'aktif',
    ip_tetap     VARCHAR(15) COMMENT 'Opsional static IP',
    notes        TEXT,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY pelanggan_paket_id (paket_id),
    KEY pelanggan_status (status),
    KEY pelanggan_tgl_expired (tgl_expired),
    FOREIGN KEY (paket_id) REFERENCES paket(id)
) ENGINE=InnoDB;

-- Invoice / Tagihan
-- pelanggan_id NULLABLE: invoice voucher hotspot (dibeli publik tanpa akun
-- pelanggan) disimpan dengan pelanggan_id = NULL. Lihat routes/voucher-publik.js.
CREATE TABLE invoice (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    no_invoice   VARCHAR(30) NOT NULL UNIQUE COMMENT 'Format: INV-YYYY-NNNN',
    pelanggan_id INT UNSIGNED NULL COMMENT 'NULL untuk invoice voucher hotspot publik',
    paket_id     INT UNSIGNED NOT NULL,
    jumlah       DECIMAL(12,2) NOT NULL,
    tgl_invoice  DATE NOT NULL,
    tgl_jatuh_tempo DATE NOT NULL,
    tgl_bayar    DATETIME,
    metode_bayar VARCHAR(50) COMMENT 'qris, va_bca, va_bri, tunai, dll',
    payment_id   VARCHAR(100) COMMENT 'ID transaksi dari payment gateway',
    payment_url  TEXT COMMENT 'Link pembayaran Midtrans/Xendit',
    status       ENUM('unpaid','paid','overdue','cancelled') NOT NULL DEFAULT 'unpaid',
    keterangan   TEXT,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY invoice_pelanggan_id (pelanggan_id),
    KEY invoice_status (status),
    KEY invoice_tgl_jatuh_tempo (tgl_jatuh_tempo),
    FOREIGN KEY (pelanggan_id) REFERENCES pelanggan(id) ON DELETE SET NULL,
    FOREIGN KEY (paket_id) REFERENCES paket(id)
) ENGINE=InnoDB;

-- Log WhatsApp Gateway
CREATE TABLE wa_log (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    pelanggan_id INT UNSIGNED,
    no_tujuan    VARCHAR(20) NOT NULL,
    pesan        TEXT NOT NULL,
    tipe         ENUM('reminder','suspend','konfirmasi_bayar','otp','manual','broadcast') NOT NULL,
    status       ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending',
    response     TEXT COMMENT 'Response dari API WA',
    invoice_id   INT UNSIGNED,
    sent_at      DATETIME,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY wa_log_pelanggan_id (pelanggan_id),
    KEY wa_log_status (status),
    KEY wa_log_tipe (tipe)
) ENGINE=InnoDB;

-- Log Pembayaran
-- invoice_id NULLABLE: jaga-jaga jika suatu saat payment_log dipakai untuk
-- mencatat transaksi yang tidak terhubung ke invoice (mis. topup reseller
-- yang gagal dicocokkan), agar INSERT tidak crash karena constraint NOT NULL.
CREATE TABLE payment_log (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    invoice_id      INT UNSIGNED NULL,
    payment_gateway VARCHAR(30) NOT NULL COMMENT 'midtrans, xendit, manual',
    order_id        VARCHAR(100),
    transaction_id  VARCHAR(100),
    payment_type    VARCHAR(50),
    gross_amount    DECIMAL(12,2),
    status          VARCHAR(30),
    raw_response    JSON,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY payment_log_invoice_id (invoice_id),
    KEY payment_log_order_id (order_id),
    FOREIGN KEY (invoice_id) REFERENCES invoice(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Konfigurasi Sistem
CREATE TABLE setting (
    kunci        VARCHAR(100) NOT NULL,
    nilai        TEXT,
    deskripsi    VARCHAR(255),
    PRIMARY KEY (kunci)
) ENGINE=InnoDB;

-- Migrasi otomatis: jika tabel voucher LAMA masih ada (kolom `kode`),
-- migrasikan dulu ke skema baru (username/password) sebelum tabel
-- dibuat di bawah (statement berikutnya tidak akan menyentuh tabel
-- yang sudah ada karena pakai IF NOT EXISTS).
-- Aman dijalankan berkali-kali — jika kolom `kode` sudah tidak ada
-- (skema sudah baru, atau tabel belum pernah dibuat), blok ini dilewati.
SET @kode_ada = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'voucher' AND COLUMN_NAME = 'kode'
);
SET @sql := IF(@kode_ada > 0,
    'ALTER TABLE voucher ADD COLUMN username VARCHAR(32) NULL AFTER id, ADD COLUMN password VARCHAR(32) NULL AFTER username',
    'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@kode_ada > 0,
    'UPDATE voucher SET username = kode, password = kode WHERE username IS NULL',
    'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@kode_ada > 0,
    'ALTER TABLE voucher DROP COLUMN kode, MODIFY COLUMN username VARCHAR(32) NOT NULL, MODIFY COLUMN password VARCHAR(32) NOT NULL, ADD UNIQUE KEY username (username)',
    'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Voucher Hotspot
CREATE TABLE voucher (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    username     VARCHAR(32) NOT NULL UNIQUE,
    password     VARCHAR(32) NOT NULL,
    paket_id     INT UNSIGNED NOT NULL,
    status       ENUM('unused','used','expired') NOT NULL DEFAULT 'unused',
    digunakan_oleh VARCHAR(64) COMMENT 'no WA/MAC yang pakai',
    tgl_digunakan DATETIME,
    tgl_expired  DATETIME,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY voucher_status (status),
    KEY voucher_paket_id (paket_id),
    FOREIGN KEY (paket_id) REFERENCES paket(id)
) ENGINE=InnoDB;

-- Admin Users
CREATE TABLE admin (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    username     VARCHAR(64) NULL UNIQUE,
    nama         VARCHAR(100) NOT NULL,
    email        VARCHAR(150) NULL UNIQUE,
    password     VARCHAR(255) NOT NULL,
    role         ENUM('superadmin','admin','operator','teknisi') NOT NULL DEFAULT 'operator',
    no_hp        VARCHAR(20) NULL,
    aktif        TINYINT(1) NOT NULL DEFAULT 1,
    last_login   DATETIME,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
) ENGINE=InnoDB;

-- ============================================================
-- DATA AWAL (SEED)
-- ============================================================

INSERT INTO setting (kunci, nilai, deskripsi) VALUES
('app_name',        'Nexbill',               'Nama aplikasi'),
('app_url',         'https://billing.anda.id',  'URL aplikasi'),
('wa_number',       '6282273309190',            'Nomor WA kontak bantuan (tampil di storefront)'),
('alamat',          'Dusun Mesjid Lama Desa Keude Aceh no 59 Kec. Idi Rayeuk Kab. Aceh Timur Prov. Aceh', 'Alamat usaha (tampil di storefront)'),
('wa_mode',         'api',                       'Mode WhatsApp: api (provider berbayar) atau qr (scan barcode)'),
('wa_provider',     'fonnte',                   'Provider WA: fonnte/wablas/wanotif/wa_business'),
('wa_token',        '',                          'API token WhatsApp gateway'),
('wa_sender',       '',                          'Nomor pengirim WA (628xxx)'),
('wa_phone_id',     '',                          'Phone Number ID untuk WhatsApp Cloud API (Meta), hanya jika provider=wa_business'),
('pg_provider',     'midtrans',                 'Payment gateway: midtrans/xendit/duitku/tripay'),
('pg_server_key',   '',                          'Server key Midtrans'),
('pg_client_key',   '',                          'Client key Midtrans (opsional)'),
('pg_secret_key',   '',                          'Secret key Xendit'),
('pg_webhook_token','',                          'Webhook verification token Xendit'),
('pg_merchant_code','',                          'Merchant code Duitku/Tripay'),
('pg_api_key',      '',                          'API key Duitku/Tripay'),
('pg_private_key',  '',                          'Private key Tripay'),
('pg_sandbox',      '1',                         '1=sandbox, 0=production'),
('radius_host',     '127.0.0.1',                'IP FreeRADIUS / DB host'),
('radius_secret',   'testing123',               'RADIUS shared secret default'),
('suspend_h',       '3',                         'Suspend otomatis H+N setelah jatuh tempo'),
('reminder_h',      '3',                         'Kirim reminder H-N sebelum jatuh tempo'),
('invoice_prefix',  'INV',                       'Prefix nomor invoice'),
('pajak_persen',    '0',                         'PPN dalam persen (0 = tidak ada)'),
('radius_auth_mode','pap,mschapv2',              'Mode autentikasi RADIUS yang diizinkan (pap,chap,mschapv1,mschapv2)'),
('radius_single_session','1',                    'Single session enforcement: 1=aktif, 0=nonaktif'),
('admin_no_hp',          '',                      'Nomor HP admin untuk notifikasi tiket'),
('acs_url',              '',                      'URL ACS TR-069 untuk konfigurasi router pelanggan');

INSERT INTO paket (nama, kecepatan_up, kecepatan_dn, harga, pool_name, tipe) VALUES
('Paket Hemat 5Mbps',   5,  5,  100000, 'pool-5mbps',  'keduanya'),
('Paket Standar 10Mbps',10, 10, 150000, 'pool-10mbps', 'keduanya'),
('Paket Plus 20Mbps',   20, 20, 250000, 'pool-20mbps', 'pppoe'),
('Paket Pro 50Mbps',    50, 50, 400000, 'pool-50mbps', 'pppoe'),
('Voucher Hotspot 1Hr', 5,  5,  5000,   'pool-voucher','hotspot');

INSERT INTO nas (nasname, shortname, type, secret, description) VALUES
('192.168.88.1',  'MikroTik-Main',   'other', 'testing123', 'Router utama PPPoE'),
('192.168.88.10', 'AP-Timur',        'other', 'testing123', 'Access Point Hotspot Timur'),
('192.168.88.11', 'AP-Barat',        'other', 'testing123', 'Access Point Hotspot Barat');

INSERT INTO admin (username, nama, email, password, role) VALUES
('admin', 'Super Admin', 'admin@billing.id', '$2b$12$placeholder_hash_ganti_dulu', 'superadmin');

-- ============================================================
-- VIEWS BERGUNA
-- ============================================================

CREATE OR REPLACE VIEW v_pelanggan_aktif AS
SELECT
    p.id, p.nama, p.username, p.no_hp, p.tipe_koneksi,
    p.tgl_expired, p.status,
    pk.nama AS nama_paket, pk.kecepatan_dn, pk.harga,
    DATEDIFF(p.tgl_expired, CURDATE()) AS sisa_hari
FROM pelanggan p
JOIN paket pk ON p.paket_id = pk.id
WHERE p.status != 'nonaktif';

CREATE OR REPLACE VIEW v_tagihan_jatuh_tempo AS
SELECT
    i.id, i.no_invoice, i.jumlah, i.tgl_jatuh_tempo, i.status,
    p.nama AS nama_pelanggan, p.no_hp, p.username,
    DATEDIFF(i.tgl_jatuh_tempo, CURDATE()) AS sisa_hari
FROM invoice i
JOIN pelanggan p ON i.pelanggan_id = p.id
WHERE i.status IN ('unpaid','overdue')
ORDER BY i.tgl_jatuh_tempo ASC;

CREATE OR REPLACE VIEW v_sesi_aktif AS
SELECT
    ra.username, ra.framedipaddress AS ip,
    ra.nasipaddress AS nas_ip,
    ra.acctstarttime AS mulai,
    TIMESTAMPDIFF(MINUTE, ra.acctstarttime, NOW()) AS durasi_menit,
    ROUND((ra.acctinputoctets + ra.acctoutputoctets) / 1048576, 2) AS total_mb,
    n.shortname AS nas_name
FROM radacct ra
LEFT JOIN nas n ON ra.nasipaddress = n.nasname
WHERE ra.acctstoptime IS NULL;

-- ============================================================
-- TABEL RESELLER (tambahan)
-- ============================================================
-- Drop dulu jika ada sisa dari percobaan import sebelumnya yang mungkin
-- berhenti di tengah jalan (misalnya karena versi schema lama sempat
-- berhasil membuat sebagian tabel ini dengan nama index yang berbeda).
-- Ini membuat keseluruhan blok reseller aman untuk diimpor ulang berkali-kali.
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS reseller_harga;
DROP TABLE IF EXISTS reseller_transaksi;
DROP TABLE IF EXISTS reseller_topup;
DROP TABLE IF EXISTS reseller_mutasi;
DROP TABLE IF EXISTS reseller;
SET FOREIGN_KEY_CHECKS = 1;

-- Akun reseller
CREATE TABLE IF NOT EXISTS reseller (
    id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
    nama            VARCHAR(150) NOT NULL,
    username        VARCHAR(64)  NOT NULL UNIQUE,
    password        VARCHAR(255) NOT NULL,
    no_hp           VARCHAR(20)  NOT NULL,
    email           VARCHAR(150) UNIQUE,
    saldo           DECIMAL(14,2) NOT NULL DEFAULT 0.00,
    komisi_persen   DECIMAL(5,2) NOT NULL DEFAULT 0.00 COMMENT 'Diskon harga dari harga normal',
    level           ENUM('silver','gold','platinum') NOT NULL DEFAULT 'silver',
    status          ENUM('aktif','nonaktif','suspend') NOT NULL DEFAULT 'aktif',
    token_api       VARCHAR(64) UNIQUE COMMENT 'Token untuk API reseller',
    last_login      DATETIME,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY reseller_status (status)
) ENGINE=InnoDB;

-- Mutasi saldo reseller (topup & penggunaan)
CREATE TABLE IF NOT EXISTS reseller_mutasi (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    reseller_id     INT UNSIGNED NOT NULL,
    tipe            ENUM('topup','pembelian','refund','bonus','koreksi') NOT NULL,
    jumlah          DECIMAL(14,2) NOT NULL,
    saldo_sebelum   DECIMAL(14,2) NOT NULL,
    saldo_sesudah   DECIMAL(14,2) NOT NULL,
    keterangan      VARCHAR(255),
    ref_id          VARCHAR(100) COMMENT 'order_id topup atau id transaksi',
    payment_method  VARCHAR(50),
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY reseller_mutasi_reseller_id (reseller_id),
    KEY reseller_mutasi_tipe (tipe),
    FOREIGN KEY (reseller_id) REFERENCES reseller(id)
) ENGINE=InnoDB;

-- Topup saldo reseller (request pembayaran)
CREATE TABLE IF NOT EXISTS reseller_topup (
    id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
    reseller_id     INT UNSIGNED NOT NULL,
    order_id        VARCHAR(100) NOT NULL UNIQUE,
    jumlah          DECIMAL(14,2) NOT NULL,
    payment_url     TEXT,
    payment_method  VARCHAR(50),
    status          ENUM('pending','paid','expired','cancelled') NOT NULL DEFAULT 'pending',
    paid_at         DATETIME,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY reseller_topup_reseller_id (reseller_id),
    KEY reseller_topup_order_id (order_id),
    FOREIGN KEY (reseller_id) REFERENCES reseller(id)
) ENGINE=InnoDB;

-- Transaksi pembelian oleh reseller
CREATE TABLE IF NOT EXISTS reseller_transaksi (
    id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
    reseller_id     INT UNSIGNED NOT NULL,
    tipe            ENUM('voucher','pppoe','hotspot') NOT NULL,
    paket_id        INT UNSIGNED NOT NULL,
    jumlah_item     INT NOT NULL DEFAULT 1,
    harga_normal    DECIMAL(12,2) NOT NULL,
    harga_reseller  DECIMAL(12,2) NOT NULL COMMENT 'Harga setelah diskon',
    total_bayar     DECIMAL(14,2) NOT NULL,
    status          ENUM('success','refunded') NOT NULL DEFAULT 'success',
    detail          JSON COMMENT 'Data voucher/user yang dibuat',
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY reseller_transaksi_reseller_id (reseller_id),
    KEY reseller_transaksi_created_at (created_at),
    FOREIGN KEY (reseller_id) REFERENCES reseller(id),
    FOREIGN KEY (paket_id) REFERENCES paket(id)
) ENGINE=InnoDB;

-- Harga khusus reseller per paket (opsional, override komisi_persen)
CREATE TABLE IF NOT EXISTS reseller_harga (
    id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
    reseller_id     INT UNSIGNED NOT NULL,
    paket_id        INT UNSIGNED NOT NULL,
    harga_reseller  DECIMAL(12,2) NOT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY (reseller_id, paket_id),
    FOREIGN KEY (reseller_id) REFERENCES reseller(id),
    FOREIGN KEY (paket_id)    REFERENCES paket(id)
) ENGINE=InnoDB;

-- ============================================================
-- MIGRATION: tambah satuan_masa di tabel paket
-- Aman dijalankan berkali-kali (cek kolom sebelum ALTER)
-- ============================================================
SET @col_exists = (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'paket'
    AND COLUMN_NAME = 'satuan_masa'
);
SET @sql = IF(@col_exists = 0,
    "ALTER TABLE paket ADD COLUMN satuan_masa ENUM('jam','hari','bulan') NOT NULL DEFAULT 'hari' COMMENT 'satuan masa berlaku' AFTER masa_aktif",
    'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================================================
-- TABEL VPN ACCOUNTS (NAS VPN)
-- ============================================================
CREATE TABLE IF NOT EXISTS vpn_account (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    nama        VARCHAR(100) NOT NULL COMMENT 'Label/nama akun VPN',
    protokol    ENUM('wireguard','l2tp') NOT NULL DEFAULT 'wireguard',
    server      VARCHAR(255) NOT NULL COMMENT 'Endpoint/IP server VPN',
    port        INT NOT NULL DEFAULT 51820,
    username    VARCHAR(100) NOT NULL,
    password    TEXT COMMENT 'Password / PSK (terenkripsi AES-256-GCM)',
    pubkey      TEXT COMMENT 'Public key WireGuard peer',
    allowed_ips VARCHAR(255) DEFAULT '0.0.0.0/0' COMMENT 'WireGuard allowed IPs',
    ipsec_psk   TEXT COMMENT 'IPSec Pre-Shared Key untuk L2TP',
    nas_id      INT DEFAULT NULL COMMENT 'NAS terkait (opsional)',
    status      ENUM('aktif','nonaktif') NOT NULL DEFAULT 'aktif',
    catatan     TEXT,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY vpn_nas (nas_id)
) ENGINE=InnoDB COMMENT='Akun VPN untuk koneksi NAS/Mikrotik';

-- ============================================================
-- CLIENT PORTAL
-- ============================================================
CREATE TABLE IF NOT EXISTS client_otp (
    no_hp       VARCHAR(20) PRIMARY KEY,
    otp         VARCHAR(6) NOT NULL,
    expired_at  DATETIME NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS tiket (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    pelanggan_id INT NOT NULL,
    judul        VARCHAR(200) NOT NULL,
    pesan        TEXT NOT NULL,
    kategori     ENUM('umum','gangguan','billing','lainnya') DEFAULT 'umum',
    foto         VARCHAR(255) DEFAULT NULL,
    status       ENUM('open','proses','selesai') DEFAULT 'open',
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY tiket_pelanggan (pelanggan_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS tiket_reply (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    tiket_id     INT NOT NULL,
    dari         ENUM('pelanggan','admin') DEFAULT 'admin',
    pesan        TEXT NOT NULL,
    foto         VARCHAR(255) DEFAULT NULL,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY reply_tiket (tiket_id)
) ENGINE=InnoDB;

-- ============================================================
-- ACS TR-069 TABLES
-- ============================================================
CREATE TABLE IF NOT EXISTS acs_device (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    serial_number   VARCHAR(100) NOT NULL UNIQUE,
    product_class   VARCHAR(100),
    manufacturer    VARCHAR(100),
    oui             VARCHAR(20),
    software_version VARCHAR(50),
    hardware_version VARCHAR(50),
    ip_address      VARCHAR(45),
    mac_address     VARCHAR(20),
    connection_url  VARCHAR(255),
    pelanggan_id    INT DEFAULT NULL,
    last_inform     DATETIME,
    status          ENUM('online','offline') DEFAULT 'offline',
    inform_interval INT DEFAULT 300,
    param_cache     LONGTEXT COMMENT 'JSON cache parameter device',
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY acs_pelanggan (pelanggan_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS acs_task (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    device_id       INT NOT NULL,
    type            VARCHAR(50) NOT NULL COMMENT 'SetParameterValues, Reboot, GetParameterValues',
    params          TEXT COMMENT 'JSON params untuk task',
    status          ENUM('pending','running','done','failed') DEFAULT 'pending',
    result          TEXT,
    created_by      VARCHAR(50) DEFAULT 'admin',
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    done_at         DATETIME DEFAULT NULL,
    KEY acs_task_device (device_id)
) ENGINE=InnoDB;

-- ============================================================
-- VOUCHER TEMPLATE
-- ============================================================
CREATE TABLE IF NOT EXISTS voucher_template (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    nama        VARCHAR(100) NOT NULL,
    header_html TEXT,
    row_html    TEXT NOT NULL,
    footer_html TEXT,
    is_default  TINYINT(1) DEFAULT 0,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

INSERT IGNORE INTO voucher_template (id, nama, header_html, row_html, footer_html, is_default) VALUES
(1, 'Default', 
'<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Segoe UI,Arial,sans-serif;padding:16px;background:#fff}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}@media print{.noprint{display:none}body{padding:8px;-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body><div class="noprint" style="text-align:center;padding:0 0 12px"><button onclick="window.print()" style="padding:7px 22px;background:#3b82f6;color:#fff;border:none;border-radius:7px;font-size:13px;cursor:pointer;font-weight:600">Print</button> <button onclick="window.close()" style="padding:7px 14px;background:#f1f4f8;color:#333;border:none;border-radius:7px;font-size:13px;cursor:pointer;margin-left:8px">Tutup</button></div><div class="grid">',
'<div style="border:0.5px solid #d0d7e3;border-radius:10px;overflow:hidden;page-break-inside:avoid"><div style="padding:9px 12px;background:#185FA5;display:flex;align-items:center;justify-content:space-between"><span style="font-size:11px;font-weight:700;color:#fff">Nexbill</span><span style="font-size:9px;padding:2px 7px;border-radius:20px;background:rgba(255,255,255,.2);color:#fff">Aktif</span></div><div style="padding:9px 12px"><div style="font-size:10px;color:#888;margin-bottom:4px">%profile% &nbsp;·&nbsp; %validity%</div><div style="font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:#aaa;margin-bottom:3px">Kode Voucher</div><div style="font-size:20px;font-weight:700;letter-spacing:.1em;font-family:Courier New,monospace;color:#185FA5;margin-bottom:7px">%username%</div><div style="border-top:0.5px dashed #e5e9f0;padding-top:6px;font-size:9px;color:#aaa">Sambung WiFi lalu masukkan kode</div></div></div>',
'</div></body></html>',
1);
