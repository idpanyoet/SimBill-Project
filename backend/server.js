// ============================================================
// BILLING RADIUS - SERVER UTAMA
// ============================================================
require('dotenv').config();

// ── Guard keamanan: tolak boot jika JWT_SECRET lemah/kosong ──
// Secret reseller & client diturunkan dari JWT_SECRET (+ '_reseller' / '_client'),
// jadi kalau JWT_SECRET kosong, secret jadi string tebakable ("undefined_reseller")
// → token bisa diforge. Wajib di-set & cukup panjang sebelum server jalan.
(function pastikanSecretAman() {
    const s = process.env.JWT_SECRET;
    const placeholder = 'ganti_dengan_secret_key_yang_sangat_panjang_dan_acak';
    if (!s || s.length < 32 || s === placeholder) {
        console.error('❌ JWT_SECRET tidak aman. Set JWT_SECRET di .env dengan string acak minimal 32 karakter.');
        console.error('   Contoh generate: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
        process.exit(1);
    }
})();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');

const app = express();

// ── Trust proxy ──────────────────────────────────────────────────────────────
// SimBill berjalan di belakang Nginx (loopback). Tanpa ini, req.ip = 127.0.0.1
// untuk SEMUA klien → rate-limiter jadi satu ember global: 50 percobaan login
// total bisa mengunci seluruh pengguna, dan isolasi brute-force per-IP tidak
// jalan. 'loopback' hanya mempercayai X-Forwarded-For bila berasal dari proxy
// lokal — aman juga saat diakses langsung (XFF dari internet diabaikan).
app.set('trust proxy', 'loopback');

// ── AUTO-MIGRATION: jalankan setiap start, aman untuk kolom yang sudah ada ──
async function jalankanMigration() {
    const { query } = require('./config/db');
    const migrations = [
        // Unique key radcheck (username,attribute) — WAJIB agar ON DUPLICATE KEY
        // UPDATE di tambahUser benar2 mencegah baris Cleartext-Password dobel.
        // Tanpa ini, setiap operasi menambah baris baru → user bisa punya >1
        // password → MS-CHAP/CHAP bingung → Access-Reject. Dedupe dulu baru ALTER.
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='radcheck' AND INDEX_NAME='uniq_user_attr'`,
            sql:  `DELETE r1 FROM radcheck r1 JOIN radcheck r2 ON r1.username=r2.username AND r1.attribute=r2.attribute AND r1.value=r2.value AND r1.id>r2.id`,
            nama: 'radcheck.dedupe_identik'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='radcheck' AND INDEX_NAME='uniq_user_attr'`,
            sql:  `DELETE r1 FROM radcheck r1 WHERE r1.attribute='Cleartext-Password' AND r1.value=r1.username AND EXISTS (SELECT 1 FROM (SELECT * FROM radcheck) r2 WHERE r2.username=r1.username AND r2.attribute='Cleartext-Password' AND r2.value<>r2.username)`,
            nama: 'radcheck.dedupe_username'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='radcheck' AND INDEX_NAME='uniq_user_attr'`,
            sql:  `ALTER TABLE radcheck ADD UNIQUE KEY uniq_user_attr (username, attribute)`,
            nama: 'radcheck.unique_key'
        },
        // Kolom IPv6 radacct — FreeRADIUS 3.2 menulis kolom ini saat accounting.
        // Tanpa kolom ini: ERROR 1054 → Accounting-Response tak terkirim → MikroTik
        // "accounting request not sent" & pemakaian tidak tercatat.
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='radacct' AND COLUMN_NAME='framedipv6address'`,
            sql:  `ALTER TABLE radacct
                     ADD COLUMN framedipv6address  VARCHAR(45) DEFAULT NULL AFTER framedipaddress,
                     ADD COLUMN framedipv6prefix   VARCHAR(45) DEFAULT NULL AFTER framedipv6address,
                     ADD COLUMN framedinterfaceid  VARCHAR(44) DEFAULT NULL AFTER framedipv6prefix,
                     ADD COLUMN delegatedipv6prefix VARCHAR(45) DEFAULT NULL AFTER framedinterfaceid`,
            nama: 'radacct.kolom_ipv6'
        },
        // satuan_masa di tabel paket
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paket' AND COLUMN_NAME='satuan_masa'`,
            sql:  `ALTER TABLE paket ADD COLUMN satuan_masa ENUM('jam','hari','bulan') NOT NULL DEFAULT 'hari' COMMENT 'satuan masa berlaku' AFTER masa_aktif`,
            nama: 'paket.satuan_masa'
        },
        // username + password di tabel voucher
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='voucher' AND COLUMN_NAME='username'`,
            sql:  `ALTER TABLE voucher ADD COLUMN username VARCHAR(32) UNIQUE AFTER id`,
            nama: 'voucher.username'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM setting WHERE kunci='wa_number'`,
            sql:  `INSERT IGNORE INTO setting (kunci,nilai,deskripsi) VALUES ('wa_number','6282273309190','Nomor WA kontak bantuan')`,
            nama: 'setting.wa_number'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM setting WHERE kunci='alamat'`,
            sql:  `INSERT IGNORE INTO setting (kunci,nilai,deskripsi) VALUES ('alamat','Dusun Mesjid Lama Desa Keude Aceh no 59 Kec. Idi Rayeuk Kab. Aceh Timur Prov. Aceh','Alamat usaha')`,
            nama: 'setting.alamat'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM setting WHERE kunci='radius_auth_mode'`,
            sql:  `INSERT IGNORE INTO setting (kunci, nilai, deskripsi) VALUES ('radius_auth_mode','pap,mschapv2','Mode autentikasi RADIUS yang diizinkan')`,
            nama: 'setting.radius_auth_mode'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM setting WHERE kunci='radius_single_session'`,
            sql:  `INSERT IGNORE INTO setting (kunci, nilai, deskripsi) VALUES ('radius_single_session','1','Single session enforcement: 1=aktif, 0=nonaktif')`,
            nama: 'setting.radius_single_session'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='voucher_template'`,
            sql:  `CREATE TABLE IF NOT EXISTS voucher_template (id INT AUTO_INCREMENT PRIMARY KEY, nama VARCHAR(100) NOT NULL, header_html TEXT, row_html TEXT NOT NULL, footer_html TEXT, is_default TINYINT(1) DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB`,
            nama: 'table.voucher_template'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='voucher' AND COLUMN_NAME='batch_id'`,
            sql:  `ALTER TABLE voucher ADD COLUMN batch_id VARCHAR(30) DEFAULT NULL AFTER paket_id`,
            nama: 'voucher.batch_id'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='acs_device'`,
            sql:  `CREATE TABLE IF NOT EXISTS acs_device (id INT AUTO_INCREMENT PRIMARY KEY, serial_number VARCHAR(100) NOT NULL UNIQUE, product_class VARCHAR(100), manufacturer VARCHAR(100), oui VARCHAR(20), software_version VARCHAR(50), hardware_version VARCHAR(50), ip_address VARCHAR(45), mac_address VARCHAR(20), connection_url VARCHAR(255), pelanggan_id INT DEFAULT NULL, last_inform DATETIME, status ENUM('online','offline') DEFAULT 'offline', inform_interval INT DEFAULT 300, param_cache LONGTEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, KEY acs_pelanggan (pelanggan_id)) ENGINE=InnoDB`,
            nama: 'table.acs_device'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='acs_task'`,
            sql:  `CREATE TABLE IF NOT EXISTS acs_task (id INT AUTO_INCREMENT PRIMARY KEY, device_id INT NOT NULL, type VARCHAR(50) NOT NULL, params TEXT, status ENUM('pending','running','done','failed') DEFAULT 'pending', result TEXT, created_by VARCHAR(50) DEFAULT 'admin', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, done_at DATETIME DEFAULT NULL, KEY acs_task_device (device_id)) ENGINE=InnoDB`,
            nama: 'table.acs_task'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='client_otp'`,
            sql:  `CREATE TABLE IF NOT EXISTS client_otp (no_hp VARCHAR(20) PRIMARY KEY, otp VARCHAR(6) NOT NULL, attempts INT NOT NULL DEFAULT 0, expired_at DATETIME NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`,
            nama: 'table.client_otp'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='wa_log' AND COLUMN_NAME='tipe' AND COLUMN_TYPE LIKE '%invoice_pdf%'`,
            sql:  `ALTER TABLE wa_log MODIFY COLUMN tipe ENUM('reminder','suspend','konfirmasi_bayar','otp','manual','broadcast','daftar','voucher','invoice_pdf','dokumen') NOT NULL`,
            nama: 'wa_log.tipe (+invoice_pdf,dokumen,daftar,voucher)'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='client_otp' AND COLUMN_NAME='attempts'`,
            sql:  `ALTER TABLE client_otp ADD COLUMN attempts INT NOT NULL DEFAULT 0 AFTER otp`,
            nama: 'client_otp.attempts'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tiket'`,
            sql:  `CREATE TABLE IF NOT EXISTS tiket (id INT AUTO_INCREMENT PRIMARY KEY, pelanggan_id INT NOT NULL, judul VARCHAR(200) NOT NULL, pesan TEXT NOT NULL, kategori ENUM('umum','gangguan','billing','lainnya') DEFAULT 'umum', foto VARCHAR(255) DEFAULT NULL, status ENUM('open','proses','selesai') DEFAULT 'open', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, KEY tiket_pelanggan (pelanggan_id)) ENGINE=InnoDB`,
            nama: 'table.tiket'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tiket_reply'`,
            sql:  `CREATE TABLE IF NOT EXISTS tiket_reply (id INT AUTO_INCREMENT PRIMARY KEY, tiket_id INT NOT NULL, dari ENUM('pelanggan','admin') DEFAULT 'admin', pesan TEXT NOT NULL, foto VARCHAR(255) DEFAULT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, KEY reply_tiket (tiket_id)) ENGINE=InnoDB`,
            nama: 'table.tiket_reply'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tiket' AND COLUMN_NAME='prioritas'`,
            sql:  `ALTER TABLE tiket ADD COLUMN prioritas ENUM('rendah','sedang','tinggi','urgent') DEFAULT 'sedang' AFTER kategori`,
            nama: 'tiket.prioritas'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tiket' AND COLUMN_NAME='perkiraan_perbaikan'`,
            sql:  `ALTER TABLE tiket ADD COLUMN perkiraan_perbaikan DATETIME DEFAULT NULL AFTER prioritas`,
            nama: 'tiket.perkiraan_perbaikan'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tiket' AND COLUMN_NAME='teknisi_ids'`,
            sql:  `ALTER TABLE tiket ADD COLUMN teknisi_ids VARCHAR(255) DEFAULT NULL AFTER perkiraan_perbaikan`,
            nama: 'tiket.teknisi_ids'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pelanggan' AND COLUMN_NAME='radius_password_enc'`,
            sql:  `ALTER TABLE pelanggan ADD COLUMN radius_password_enc TEXT DEFAULT NULL AFTER password`,
            nama: 'pelanggan.radius_password_enc'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='vpn_account'`,
            sql:  `CREATE TABLE IF NOT EXISTS vpn_account (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nama VARCHAR(100) NOT NULL,
                protokol ENUM('wireguard','l2tp') NOT NULL DEFAULT 'wireguard',
                server VARCHAR(255) NOT NULL,
                port INT NOT NULL DEFAULT 51820,
                username VARCHAR(100) NOT NULL,
                password TEXT,
                pubkey TEXT,
                allowed_ips VARCHAR(255) DEFAULT '0.0.0.0/0',
                ipsec_psk TEXT,
                nas_id INT DEFAULT NULL,
                status ENUM('aktif','nonaktif') NOT NULL DEFAULT 'aktif',
                catatan TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB`,
            nama: 'table.vpn_account'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='paket' AND COLUMN_NAME='harga_reseller'`,
            sql:  `ALTER TABLE paket ADD COLUMN harga_reseller DECIMAL(12,2) DEFAULT NULL COMMENT 'Harga khusus reseller (NULL = pakai komisi_persen)' AFTER harga`,
            nama: 'paket.harga_reseller'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pelanggan' AND COLUMN_NAME='reseller_id'`,
            sql:  `ALTER TABLE pelanggan ADD COLUMN reseller_id INT UNSIGNED DEFAULT NULL AFTER paket_id`,
            nama: 'pelanggan.reseller_id'
        },
        {
            cek:  `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='pelanggan' AND INDEX_NAME='pelanggan_reseller_id'`,
            sql:  `ALTER TABLE pelanggan ADD INDEX pelanggan_reseller_id (reseller_id)`,
            nama: 'pelanggan.idx_reseller_id'
        }
    ];

    for (const m of migrations) {
        try {
            const [row] = await query(m.cek);
            if (row.n === 0) {
                await query(m.sql);
                console.log(`[migration] ✅ ${m.nama} ditambahkan`);
            }
        } catch(e) {
            console.warn(`[migration] ⚠️ ${m.nama}: ${e.message}`);
        }
    }
}

jalankanMigration().catch(e => console.warn('[migration] Gagal:', e.message));

// Sync semua voucher ke radcheck saat server start
const radiusService = require('./services/radius');
radiusService.syncVoucher().catch(e => console.warn('[startup sync] Gagal:', e.message));

// Init merchant code per provider dari pg_merchant_code lama
(async () => {
    try {
        const { query: q, queryOne: qo } = require('./config/db');
        const mc = await qo("SELECT nilai FROM setting WHERE kunci='pg_merchant_code'");
        if (mc?.nilai) {
            await q("INSERT IGNORE INTO setting (kunci,nilai,deskripsi) VALUES ('pg_merchant_code_duitku',?,'Merchant code Duitku')", [mc.nilai]);
            await q("INSERT IGNORE INTO setting (kunci,nilai,deskripsi) VALUES ('pg_merchant_code_tripay',?,'Merchant code Tripay')", [mc.nilai]);
        }
    } catch(e) {}
})();

// Sync NAS ke clients.conf saat server start
setTimeout(async () => {
    try {
        const { query } = require('./config/db');
        // Bersihkan voucher 'unused' yang berasal dari flow lama (invoice sudah expired/cancelled)
        // Voucher dari flow baru tidak dibuat saat order, jadi tidak perlu cleanup khusus
        const cleaned = await query(`
            DELETE v FROM voucher v
            JOIN invoice i ON i.keterangan LIKE CONCAT('Voucher ', v.username, ' — WA:%')
            WHERE v.status = 'unused'
              AND (i.status IN ('cancelled','overdue') OR i.tgl_jatuh_tempo < CURDATE())
        `).catch(() => ({ affectedRows: 0 }));
        if (cleaned.affectedRows > 0)
            console.log(`[startup] Cleanup ${cleaned.affectedRows} voucher orphan (flow lama)`);
    } catch(e) { /* skip */ }
}, 5000);

setTimeout(async () => {
    try {
        const { query } = require('./config/db');
        const radiusRoutes = require('./routes/radius');
        // Trigger sync via direct DB query
        const rows = await query('SELECT nasname, shortname, secret FROM nas');
        const fs = require('fs');
        const CLIENTS_CONF = '/etc/freeradius/3.0/clients.conf';
        if (!fs.existsSync(CLIENTS_CONF)) return;
        let original = fs.readFileSync(CLIENTS_CONF, 'utf8');
        const MARKER = '\n# === NETBILL AUTO-GENERATED ===';
        const markerIdx = original.indexOf(MARKER);
        if (markerIdx !== -1) original = original.slice(0, markerIdx);
        const blocks = rows.map(n => {
            const name   = (n.shortname || n.nasname).replace(/[^a-zA-Z0-9_]/g, '_');
            const ipaddr = String(n.nasname).replace(/[^a-zA-Z0-9.:_-]/g, '');
            const secret = String(n.secret).replace(/[\r\n{}"]/g, '');
            return `\nclient ${name} {\n    ipaddr = ${ipaddr}\n    secret = ${secret}\n    shortname = ${name}\n}`;
        }).join('\n');
        fs.writeFileSync(CLIENTS_CONF, original + MARKER + '\n' + blocks + '\n# === END NETBILL ===\n', { mode: 0o640 });
        console.log(`[startup] clients.conf synced ${rows.length} NAS`);
    } catch(e) { console.warn('[startup clients.conf]', e.message); }
}, 3000);

// --- Middleware keamanan ---
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
// Simpan raw body (Buffer) agar verifikasi signature webhook (mis. Tripay HMAC)
// dihitung atas byte asli yang dikirim gateway, bukan hasil re-stringify.
app.use(express.json({
    limit: '12mb',
    verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));

// Rate limiting
app.use('/api/', rateLimit({
    validate: {xForwardedForHeader: false},
    windowMs: 15 * 60 * 1000,
    max: 500,
    message: { error: 'Terlalu banyak permintaan, coba lagi nanti.' }
}));
app.use('/api/auth/', rateLimit({
    validate: {xForwardedForHeader: false},
    windowMs: 15 * 60 * 1000,
    max: 50,
    message: { error: 'Terlalu banyak percobaan login.' }
}));
// Limiter ketat untuk OTP client (kirim & verifikasi) — anti spam & brute-force.
app.use('/api/client/otp/', rateLimit({
    validate: {xForwardedForHeader: false},
    windowMs: 10 * 60 * 1000,
    max: 12,
    message: { error: 'Terlalu banyak permintaan OTP, coba lagi beberapa menit.' }
}));
// Limiter pendaftaran reseller publik — cegah pembuatan akun massal otomatis.
app.use('/api/reseller/auth/register', rateLimit({
    validate: {xForwardedForHeader: false},
    windowMs: 60 * 60 * 1000,
    max: 8,
    message: { error: 'Terlalu banyak pendaftaran dari IP ini, coba lagi nanti.' }
}));

// --- Halaman publik ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// --- Halaman admin ---
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/admin.html'));
});

app.get('/client', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/client.html'));
});
// File di /uploads bisa berisi SVG yang di-upload admin. SVG = XML yang bisa
// memuat <script> dan dieksekusi di ORIGIN yang sama dengan panel bila dibuka
// langsung → bisa mencuri token admin. Set header agar SVG/aset tak bisa
// menjalankan script & MIME tidak ditebak (nosniff). Tidak mengganggu <img>.
app.use('/uploads', (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    next();
});
app.use('/uploads', express.static(path.join(__dirname, '../frontend/uploads')));

// --- API Routes ---
app.use(require('./middleware/license-guard'));   // penegakan lisensi (default nonaktif)
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/license',   require('./routes/license'));
app.use('/api/pelanggan', require('./routes/pelanggan'));
app.use('/api/paket',     require('./routes/paket'));
app.use('/api/invoice',   require('./routes/invoice'));
app.use('/api/whatsapp',  require('./routes/whatsapp'));
app.use('/api/payment',   require('./routes/payment'));
app.use('/api/radius',    require('./routes/radius'));
app.use('/api/laporan',   require('./routes/laporan'));
app.use('/api/setting',   require('./routes/setting'));
app.use('/api/update',    require('./routes/update'));
app.use('/api/backup',    require('./routes/backup'));
app.use('/api/log',       require('./routes/log').router);
app.use('/api/pengguna',  require('./routes/pengguna'));
app.use('/api/tiket',     require('./routes/tiket'));
app.use('/api/telegram',  require('./routes/telegram'));
app.use('/api/client',    require('./routes/client'));
app.use('/api/acs',            require('./routes/acs'));
app.use('/api/voucher-template', require('./routes/voucher-template'));

// ── ACS CWMP Server (TR-069) port 7547 ───────────────────────
const { createCwmpRouter } = require('./services/acs');
const cwmpApp = express();
cwmpApp.use(createCwmpRouter());
const ACS_PORT = process.env.ACS_PORT || 7547;
cwmpApp.listen(ACS_PORT, () => {
    console.log(`[ACS] CWMP server aktif di port ${ACS_PORT}`);
    console.log(`[ACS] URL untuk router: http://<IP-VPS>:${ACS_PORT}/`);
});

// Voucher: publik (tanpa auth) + admin (dengan auth)
const voucherPublik  = require('./routes/voucher-publik');
const resellerRoutes = require('./routes/reseller');
app.use('/voucher',      voucherPublik.router);
app.use('/api/voucher',  require('./routes/voucher-admin'));
app.use('/api/reseller', resellerRoutes.router);

// Webhook payment gateway (tanpa JWT)
app.use('/webhook', require('./routes/webhook'));

// --- Serve file frontend statis (CSS, JS, gambar) ---
// Dipasang SETELAH API routes agar tidak mencegat /voucher/paket dll
// No-cache untuk file HTML agar perubahan langsung terlihat
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, '../frontend')));

// Health check
app.get('/health', async (req, res) => {
    const { query } = require('./config/db');
    let db_ok = false, radius_ok = false;
    try { await query('SELECT 1'); db_ok = true; } catch(e) {}
    try { await query('SELECT 1 FROM radacct LIMIT 1'); radius_ok = true; } catch(e) {}
    // Versi app: baca file VERSION (root) → fallback package.json
    let appVer = '';
    try { appVer = require('fs').readFileSync(path.join(__dirname, '../VERSION'), 'utf8').trim(); } catch(e) {}
    if (!appVer) { try { appVer = require('./package.json').version; } catch(e) {} }
    appVer = (appVer || '1.0.0').replace(/^v/i, '');
    res.json({
        status:         'ok',
        time:           new Date().toISOString(),
        app_version:    appVer,
        node_version:   process.version,
        uptime_seconds: Math.floor(process.uptime()),
        db_ok,
        radius_ok,
        build_marker:   'pelanggan-route-step-tracking-v2'
    });
});

// 404
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint tidak ditemukan' });
});

// Error handler
app.use((err, req, res, next) => {
    // Log lengkap di server (termasuk stack trace) untuk diagnosis,
    // tapi jangan bocorkan detail teknis database ke response client.
    console.error('[ERROR]', req.method, req.originalUrl);
    console.error(err.stack || err.message);

    const isDbBindError = /Bind parameters must not contain undefined/.test(err.message || '');
    const isProd = process.env.NODE_ENV === 'production';
    let pesanUntukClient;
    if (isDbBindError) {
        pesanUntukClient = 'Terjadi kesalahan data: ada field yang tidak terisi dengan benar. Silakan cek kembali form dan coba lagi.';
    } else if (isProd) {
        // Jangan bocorkan detail teknis (pesan SQL/stack) ke client di production.
        pesanUntukClient = 'Terjadi kesalahan pada server. Silakan coba lagi atau hubungi admin.';
    } else {
        pesanUntukClient = err.message || 'Terjadi kesalahan pada server';
    }

    res.status(err.status || 500).json({ error: pesanUntukClient });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Billing RADIUS berjalan di port ${PORT}`);
    console.log(`   → Voucher publik : http://localhost:${PORT}/`);
    console.log(`   → Admin panel    : http://localhost:${PORT}/admin`);
    console.log(`   → Portal reseller: http://localhost:${PORT}/reseller`);
    console.log(`   Env: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   Build marker: pelanggan-route-step-tracking-v2`);
    require('./services/cron');
    try { require('./services/license').mulaiHeartbeat(); } catch (e) { console.error('Heartbeat lisensi gagal start:', e.message); }
});

module.exports = app;
