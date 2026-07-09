// routes/sistem.js — Pengaturan Sistem (maintenance, info server, pembersihan, reset DB)
const router = require('express').Router();
const os = require('os');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { pool, query } = require('../config/db');
const { authMiddleware, requireAdmin, requireRole } = require('../middleware/auth');

// bcrypt opsional (untuk verifikasi password superadmin saat reset DB)
let bcrypt = null;
try { bcrypt = require('bcrypt'); } catch (e) { try { bcrypt = require('bcryptjs'); } catch (e2) { bcrypt = null; } }

router.use(authMiddleware);

const DB_NAME = process.env.DB_NAME || 'billing_radius';

// ── Daftar tabel yang DIKOSONGKAN saat Reset Database (Opsi A: pertahankan config/infra) ──
// SATU sumber kebenaran, dipakai /reset-database & /reset-preview. Default-KEEP:
// tabel/VIEW di luar daftar ini (termasuk tabel baru nanti) OTOMATIS dipertahankan.
// Pemisahan RADIUS: radcheck/radreply/radusergroup/radacct/radpostauth = per-user -> WIPE;
// radgroupcheck/radgroupreply + nas = policy paket & definisi router -> KEEP (tak masuk daftar).
const RESET_WIPE_TABLES = new Set([
    'pelanggan', 'invoice', 'voucher', 'tiket', 'tiket_reply',
    'radcheck', 'radreply', 'radusergroup', 'radacct', 'radpostauth',
    'payment_log', 'wa_log', 'admin_log', 'client_otp',
    'acs_link', 'acs_task', 'nasreload', 'olt_action_log',
    'reseller_mutasi', 'reseller_topup', 'reseller_transaksi', 'vpn_account'
]);

// Daftar BASE TABLE (VIEW v_* otomatis terskip) + perkiraan baris dari information_schema (read-only, ringan).
async function _classifyResetTables() {
    const rows = await query(
        "SELECT TABLE_NAME AS t, TABLE_ROWS AS n FROM information_schema.TABLES " +
        "WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME",
        [DB_NAME]
    );
    const wipe = [], keep = [];
    for (const r of rows) {
        (RESET_WIPE_TABLES.has(String(r.t).toLowerCase()) ? wipe : keep)
            .push({ tabel: r.t, perkiraan_baris: Number(r.n || 0) });
    }
    return { wipe, keep };
}

function _uptimeStr(sec) {
    sec = Math.floor(sec);
    const d = Math.floor(sec / 86400); sec -= d * 86400;
    const h = Math.floor(sec / 3600); sec -= h * 3600;
    const m = Math.floor(sec / 60);
    return `${d}d ${h}h ${m}m`;
}
const _gb = b => +(b / 1073741824).toFixed(1);
const _run = cmd => new Promise(r => exec(cmd, { timeout: 3500 }, (e, o) => r(e ? '' : String(o).trim())));
async function _one(sql, params) { const rows = await query(sql, params || []); return Array.isArray(rows) ? rows[0] : rows; }

// ── GET /info ──────────────────────────────────────────────
router.get('/info', requireAdmin, async (req, res, next) => {
    try {
        const totalMem = os.totalmem(), freeMem = os.freemem(), usedMem = totalMem - freeMem;
        const [nginxV, mariaV] = await Promise.all([
            _run("nginx -v 2>&1 | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1"),
            _run("mysql --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1"),
        ]);
        const software = [
            nginxV ? `nginx/${nginxV}` : null,
            `Node ${process.version.replace(/^v/, '')}`,
            mariaV ? `MariaDB ${mariaV}` : 'MariaDB',
        ].filter(Boolean).join(' \u00B7 ');
        res.json({
            os_name: (os.type() === 'Linux') ? `Linux ${os.release()}` : `${os.type()} ${os.release()}`,
            arch: os.arch(),
            uptime: _uptimeStr(os.uptime()),
            ram_total_gb: _gb(totalMem),
            ram_used_gb: _gb(usedMem),
            ram_pct: Math.round(usedMem / totalMem * 100),
            server_software: software,
            node: process.version.replace(/^v/, ''),
            nginx: nginxV || null,
            mariadb: mariaV || null,
        });
    } catch (e) { next(e); }
});

// ── Maintenance ────────────────────────────────────────────
router.get('/maintenance', requireAdmin, async (req, res, next) => {
    try {
        const r = await _one("SELECT nilai FROM setting WHERE kunci='maintenance_mode' LIMIT 1");
        res.json({ aktif: !!(r && r.nilai === '1') });
    } catch (e) { next(e); }
});

router.post('/maintenance', requireAdmin, async (req, res, next) => {
    try {
        const on = req.body && (req.body.aktif === true || req.body.aktif === 1 || req.body.aktif === '1');
        const v = on ? '1' : '0';
        await query("INSERT INTO setting (kunci,nilai) VALUES ('maintenance_mode',?) ON DUPLICATE KEY UPDATE nilai=?", [v, v]);
        res.json({ aktif: on, pesan: on ? 'Mode maintenance AKTIF \u2014 pelanggan melihat halaman pemeliharaan.' : 'Mode maintenance NONAKTIF.' });
    } catch (e) { next(e); }
});

// ── Pembersihan ────────────────────────────────────────────
router.post('/hapus-log', requireAdmin, (req, res) => {
    exec('pm2 flush >/dev/null 2>&1; true', { timeout: 8000 }, () => {
        res.json({ ok: true, pesan: 'Log aplikasi dibersihkan.' });
    });
});

router.post('/hapus-cache', requireAdmin, (req, res) => {
    exec('rm -rf /opt/simbill/backend/tmp/* /tmp/simbill-* 2>/dev/null; true', { timeout: 8000 }, () => {
        res.json({ ok: true, pesan: 'Cache / file sementara dibersihkan.' });
    });
});

// ── Helper dump SQL ke file (auto-backup sebelum reset) ────
function _sqlVal(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
    if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`;
    return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
}

async function _dumpAllToFile(filePath) {
    const tabelSah = (await query('SHOW TABLES')).map(r => Object.values(r)[0]);
    const out = fs.createWriteStream(filePath, { encoding: 'utf8' });
    // Handler error dipasang SEKALI (bukan tiap write) — cegah MaxListenersExceededWarning pada dump besar.
    let streamErr = null;
    out.on('error', e => { streamErr = e; });
    const w = s => new Promise((resolve, reject) => {
        if (streamErr) return reject(streamErr);
        out.write(s, err => err ? reject(err) : resolve());
    });
    await w(`-- SimBill PRE-RESET Backup\n-- Generated: ${new Date().toISOString()}\n-- Database: ${DB_NAME}\n\n`);
    await w(`SET FOREIGN_KEY_CHECKS=0;\nSET SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\nSET NAMES utf8mb4;\n\n`);
    const CHUNK = 2000; // baca per-batch supaya tabel besar (mis. radacct jutaan baris) tidak di-load sekaligus -> anti-OOM
    for (const tabel of tabelSah) {
        try {
            const [createRow] = await query(`SHOW CREATE TABLE \`${tabel}\``);
            const createSQL = Object.values(createRow)[1];
            await w(`DROP TABLE IF EXISTS \`${tabel}\`;\n${createSQL};\n\n`);
            let offset = 0, cols = null;
            for (;;) {
                // CHUNK & offset = integer yang dikontrol server (bukan input user) -> aman di-interpolasi
                const rows = await query(`SELECT * FROM \`${tabel}\` LIMIT ${CHUNK} OFFSET ${offset}`);
                if (!rows.length) break;
                if (!cols) cols = Object.keys(rows[0]).map(c => `\`${c}\``).join(', ');
                const values = rows.map(row => '(' + Object.values(row).map(_sqlVal).join(', ') + ')').join(',\n');
                await w(`INSERT INTO \`${tabel}\` (${cols}) VALUES\n${values};\n`);
                offset += rows.length;
                if (rows.length < CHUNK) break;
            }
            await w('\n');
        } catch (e) { await w(`-- ERROR tabel ${tabel}: ${e.message}\n\n`); }
    }
    await w(`SET FOREIGN_KEY_CHECKS=1;\n-- End of backup\n`);
    await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
    if (streamErr) throw streamErr; // gagal tulis backup -> lempar, JANGAN lanjut reset tanpa backup
}

// ── POST /reset-database (SUPER-KETAT) ─────────────────────
// Guard: requireRole('superadmin') + ketik "RESET" + verifikasi password bcrypt (STRICT/fail-closed) + AUTO-BACKUP.
// Strategi AMAN (Opsi A): TIDAK re-seed. WIPE hanya data transaksi (allow-list); config/infra + setting + admin
// dipertahankan (default-KEEP) -> anti-lockout & tidak perlu bangun ulang paket/ODP/policy RADIUS.
router.post('/reset-database', requireRole('superadmin'), async (req, res, next) => {
    try {
        const konfirmasi = ((req.body && req.body.konfirmasi) || '').trim();
        const password = (req.body && req.body.password) || '';
        const dryrun = !!(req.body && (req.body.dryrun === true || req.body.dryrun === 1 || req.body.dryrun === '1'));
        if (!dryrun && konfirmasi !== 'RESET') return res.status(400).json({ error: 'Ketik RESET untuk konfirmasi' });
        if (!password) return res.status(400).json({ error: 'Masukkan password superadmin' });

        // Verifikasi password superadmin — STRICT / fail-closed.
        // Kalau identitas / format password TIDAK bisa diverifikasi -> TOLAK reset.
        // JANGAN pernah lanjut menghapus data ketika verifikasi tak bisa dijalankan.
        const a = req.admin || {};
        const adminId = a.id ?? a.userId ?? a.admin_id ?? a.sub ?? null;
        const uname = a.username || a.user || null;
        let adminRow = null;
        if (adminId != null) adminRow = await _one('SELECT * FROM admin WHERE id=? LIMIT 1', [adminId]);
        if (!adminRow && uname) adminRow = await _one('SELECT * FROM admin WHERE username=? LIMIT 1', [uname]);
        if (!adminRow)
            return res.status(401).json({ error: 'Tidak bisa memverifikasi identitas dari sesi. Login ulang lalu coba lagi.' });

        const hash = adminRow.password || adminRow.password_hash || adminRow.pass || '';
        if (!hash)
            return res.status(500).json({ error: 'Akun superadmin tidak punya password tersimpan — reset ditolak demi keamanan.' });
        if (!/^\$2[aby]\$/.test(hash))
            return res.status(500).json({ error: 'Format password bukan bcrypt — reset ditolak demi keamanan. Hubungi pengembang.' });
        if (!bcrypt)
            return res.status(500).json({ error: 'bcrypt tidak terpasang di server — verifikasi password tak bisa dijalankan.' });
        const ok = await bcrypt.compare(password, hash);
        if (!ok) return res.status(403).json({ error: 'Password superadmin salah' });
        const password_verified = true;

        // 1) AUTO-BACKUP semua tabel ke file
        const dir = path.join(__dirname, '..', 'backups');
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
        const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
        const backupFile = path.join(dir, `pre-reset-${ts}.sql`);
        await _dumpAllToFile(backupFile);

        // 2) Klasifikasi tabel (Opsi A) via daftar WIPE modul. VIEW & tabel tak dikenal auto-KEEP.
        const { wipe, keep } = await _classifyResetTables();
        const target = wipe.map(x => x.tabel);

        // 2b) DRY-RUN: backup sudah dibuat & password sudah diverifikasi, tapi TIDAK menghapus apa pun.
        //     Dipakai untuk validasi AMAN langsung di produksi (tak ada staging).
        if (dryrun) {
            return res.json({
                ok: true, dryrun: true, password_verified,
                backup: path.basename(backupFile),
                akan_dikosongkan: wipe,
                akan_dipertahankan: keep,
                pesan: `DRY-RUN: TIDAK ada data dihapus. ${wipe.length} tabel AKAN dikosongkan, ${keep.length} dipertahankan. Backup uji tersimpan: ${path.basename(backupFile)}`
            });
        }

        // 3) Kosongkan (TRUNCATE, fallback DELETE) dalam 1 koneksi (FK checks off)
        const conn = await pool.getConnection();
        const dikosongkan = [];
        try {
            await conn.query('SET FOREIGN_KEY_CHECKS=0');
            for (const t of target) {
                try { await conn.query(`TRUNCATE TABLE \`${t}\``); dikosongkan.push(t); }
                catch (e) { try { await conn.query(`DELETE FROM \`${t}\``); dikosongkan.push(t); } catch (e2) {} }
            }
            await conn.query('SET FOREIGN_KEY_CHECKS=1');
        } finally { conn.release(); }

        res.json({
            ok: true,
            backup: path.basename(backupFile),
            password_verified,
            dikosongkan: dikosongkan.length,
            dipertahankan: keep.map(x => x.tabel),
            pesan: `Database direset (data transaksi). ${dikosongkan.length} tabel dikosongkan, ${keep.length} tabel config dipertahankan. Backup: ${path.basename(backupFile)}`
        });
    } catch (e) { next(e); }
});

// ── GET /reset-preview (READ-ONLY) ─────────────────────────
// Tampilkan rencana reset (tabel WIPE vs KEEP + perkiraan baris) TANPA menghapus / menulis apa pun.
// Aman dipanggil di produksi kapan saja untuk mengonfirmasi klasifikasi sebelum eksekusi nyata.
router.get('/reset-preview', requireRole('superadmin'), async (req, res, next) => {
    try {
        const { wipe, keep } = await _classifyResetTables();
        const totalHapus = wipe.reduce((s, x) => s + (x.perkiraan_baris || 0), 0);
        res.json({
            ok: true,
            akan_dikosongkan: wipe,
            akan_dipertahankan: keep,
            ringkas: {
                tabel_wipe: wipe.length,
                tabel_keep: keep.length,
                perkiraan_baris_terhapus: totalHapus,
            },
            catatan: 'Perkiraan baris dari information_schema (bisa meleset utk InnoDB). Tidak ada data yang diubah.'
        });
    } catch (e) { next(e); }
});

module.exports = router;
