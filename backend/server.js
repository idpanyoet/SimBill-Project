// ============================================================
// BILLING RADIUS - SERVER UTAMA
// ============================================================
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');

const app = express();

// ── AUTO-MIGRATION: jalankan setiap start, aman untuk kolom yang sudah ada ──
async function jalankanMigration() {
    const { query } = require('./config/db');
    const migrations = [
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

// Sync NAS ke clients.conf saat server start
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
            const name = (n.shortname || n.nasname).replace(/[^a-zA-Z0-9_]/g, '_');
            return `\nclient ${name} {\n    ipaddr = ${n.nasname}\n    secret = ${n.secret}\n    shortname = ${name}\n}`;
        }).join('\n');
        fs.writeFileSync(CLIENTS_CONF, original + MARKER + '\n' + blocks + '\n# === END NETBILL ===\n', { mode: 0o640 });
        console.log(`[startup] clients.conf synced ${rows.length} NAS`);
    } catch(e) { console.warn('[startup clients.conf]', e.message); }
}, 3000);

// --- Middleware keamanan ---
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { error: 'Terlalu banyak permintaan, coba lagi nanti.' }
}));
app.use('/api/auth/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Terlalu banyak percobaan login.' }
}));

// --- Halaman publik ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// --- Halaman admin ---
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/admin.html'));
});

// --- Halaman portal reseller ---
app.get('/reseller', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/reseller.html'));
});

// --- API Routes ---
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/pelanggan', require('./routes/pelanggan'));
app.use('/api/paket',     require('./routes/paket'));
app.use('/api/invoice',   require('./routes/invoice'));
app.use('/api/whatsapp',  require('./routes/whatsapp'));
app.use('/api/payment',   require('./routes/payment'));
app.use('/api/radius',    require('./routes/radius'));
app.use('/api/laporan',   require('./routes/laporan'));
app.use('/api/setting',   require('./routes/setting'));

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
app.use(express.static(path.join(__dirname, '../frontend')));

// Health check
app.get('/health', async (req, res) => {
    const { query } = require('./config/db');
    let db_ok = false, radius_ok = false;
    try { await query('SELECT 1'); db_ok = true; } catch(e) {}
    try { await query('SELECT 1 FROM radacct LIMIT 1'); radius_ok = true; } catch(e) {}
    res.json({
        status:         'ok',
        time:           new Date().toISOString(),
        app_version:    '1.0.0',
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
    const pesanUntukClient = isDbBindError
        ? 'Terjadi kesalahan data: ada field yang tidak terisi dengan benar. Silakan cek kembali form dan coba lagi.'
        : (err.message || 'Terjadi kesalahan pada server');

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
});

module.exports = app;
