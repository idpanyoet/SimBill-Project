#!/usr/bin/env node
/* =============================================================================
 * migrate-data.js — Migrasi user dari billing lama ke SimBill
 * -----------------------------------------------------------------------------
 * Sumber  : pppoe-users-*.xlsx  (567 user)  → tabel `pelanggan` + RADIUS
 *           hotspot-users-*.xlsx (16k user)  → tabel `voucher`   + radcheck
 *
 * CARA PAKAI (jalankan DI VPS, di dalam folder backend):
 *   cd /opt/simbill/backend
 *   # taruh migrate-data.js + kedua file .xlsx di sini
 *   node migrate-data.js --dry         # PREVIEW dulu (tidak menulis apa pun)
 *   node migrate-data.js               # eksekusi sungguhan
 *
 * Opsi:
 *   --dry                 hanya preview (rencana paket, jumlah, contoh, error)
 *   --pppoe=<file.xlsx>   path file PPPoE  (default: auto-cari pppoe-users*.xlsx)
 *   --hotspot=<file.xlsx> path file Hotspot(default: auto-cari hotspot-users*.xlsx)
 *   --only=pppoe|hotspot  migrasi salah satu saja
 *
 * AMAN DI-RERUN: username yang sudah ada akan dilewati (skip), bukan ditimpa.
 * Kecepatan paket sengaja di-default tinggi (100/100) agar TIDAK men-throttle;
 * setelah migrasi, edit kecepatan & harga tiap paket di menu Paket sesuai aslinya.
 * ========================================================================== */
'use strict';
const path  = require('path');
const fs    = require('fs');

// Muat .env DULU (sama seperti server.js). Tanpa ini, DB_USER/DB_PASS kosong
// dan mysql2 jatuh ke 'root' tanpa password → "Access denied".
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ── Konfigurasi cepat ────────────────────────────────────────────────────────
const DEFAULT_DN = 100;   // Mbps download default paket auto (ubah bila perlu)
const DEFAULT_UP = 100;   // Mbps upload  default paket auto
const VOUCHER_CHUNK = 500;

// ── Argumen ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY  = args.includes('--dry');
const getArg = (k) => { const a = args.find(x => x.startsWith(k + '=')); return a ? a.split('=').slice(1).join('=') : null; };
const ONLY = getArg('--only'); // 'pppoe' | 'hotspot' | null

function autoFind(prefix) {
    const f = fs.readdirSync(__dirname).find(n => n.startsWith(prefix) && /\.xlsx$/i.test(n));
    return f ? path.join(__dirname, f) : null;
}
const PPPOE_FILE   = getArg('--pppoe')   || autoFind('pppoe-users');
const HOTSPOT_FILE = getArg('--hotspot') || autoFind('hotspot-users');

// ── Dependensi dari SimBill (harus dijalankan dari folder backend) ───────────
let db, radiusService, bcrypt, dayjs, ExcelJS;
try {
    db            = require(path.join(__dirname, 'config', 'db'));
    radiusService = require(path.join(__dirname, 'services', 'radius'));
    bcrypt        = require('bcryptjs');
    dayjs         = require('dayjs');
    ExcelJS       = require('exceljs');
} catch (e) {
    console.error('❌ Gagal load modul. Jalankan script ini DARI /opt/simbill/backend.');
    console.error('   Detail:', e.message);
    process.exit(1);
}
const { query, queryOne, pool, hitungExpired } = db;

// ── Util ─────────────────────────────────────────────────────────────────────
const log = (...a) => console.log(...a);

function normNoHp(v) {
    let s = String(v == null ? '' : v).replace(/[^\d]/g, '');
    if (!s) return '';
    if (s.startsWith('0'))  s = '62' + s.slice(1);
    if (s.startsWith('620')) s = '62' + s.slice(3);
    if (!s.startsWith('62')) s = '62' + s;
    return s;
}
function parseHarga(nama) {
    const s = String(nama).toLowerCase();
    let m = s.match(/(\d+(?:[.,]\d+)?)\s*jt/);
    if (m) return Math.round(parseFloat(m[1].replace(',', '.')) * 1_000_000);
    m = s.match(/(\d+)\s*rb/);  if (m) return parseInt(m[1]) * 1000;
    m = s.match(/(\d+)\s*k\b/); if (m) return parseInt(m[1]) * 1000;
    return 0;
}
function parseMasa(nama, tipe) {
    const s = String(nama).toLowerCase();
    let m = s.match(/(\d+)\s*bln/);    if (m) return { masa: parseInt(m[1]),     satuan: 'bulan' };
    if (s.includes('bulanan'))          return { masa: 1,                         satuan: 'bulan' };
    m = s.match(/(\d+)\s*minggu/);     if (m) return { masa: parseInt(m[1]) * 7, satuan: 'hari'  };
    m = s.match(/(\d+)\s*hari/);       if (m) return { masa: parseInt(m[1]),     satuan: 'hari'  };
    m = s.match(/(\d+)\s*jam/);        if (m) return { masa: parseInt(m[1]),     satuan: 'jam'   };
    return tipe === 'pppoe' ? { masa: 30, satuan: 'hari' } : { masa: 1, satuan: 'hari' };
}
const SATUAN2UNIT = { jam: 'hour', hari: 'day', bulan: 'month' };

// Baca xlsx → array of object (key = header baris pertama)
async function bacaXlsx(file) {
    if (!file || !fs.existsSync(file)) return [];
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = wb.worksheets[0];
    const headers = [];
    ws.getRow(1).eachCell((c, i) => { headers[i] = String(c.value ?? '').trim(); });
    const out = [];
    for (let r = 2; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const o = {}; let kosong = true;
        for (let i = 1; i < headers.length + 1; i++) {
            let v = row.getCell(i).value;
            if (v && typeof v === 'object' && 'text' in v) v = v.text;       // rich text
            if (v && typeof v === 'object' && 'result' in v) v = v.result;   // formula
            o[headers[i]] = v == null ? '' : v;
            if (o[headers[i]] !== '') kosong = false;
        }
        if (!kosong) out.push(o);
    }
    return out;
}

// Pastikan paket ada (cari by nama+tipe; buat bila belum). Kembalikan row paket.
const _paketCache = new Map();
async function ensurePaket(nama, tipe) {
    const key = tipe + '|' + nama;
    if (_paketCache.has(key)) return _paketCache.get(key);
    let p = await queryOne('SELECT * FROM paket WHERE nama=? AND (tipe=? OR tipe=?) LIMIT 1', [nama, tipe, 'keduanya']);
    if (!p) {
        const harga = parseHarga(nama);
        const { masa, satuan } = parseMasa(nama, tipe);
        if (DRY) {
            p = { id: '(baru)', nama, kecepatan_dn: DEFAULT_DN, kecepatan_up: DEFAULT_UP, harga, masa_aktif: masa, satuan_masa: satuan, tipe, pool_name: null, _baru: true };
        } else {
            const r = await query(
                `INSERT INTO paket (nama, kecepatan_up, kecepatan_dn, harga, masa_aktif, satuan_masa, tipe, aktif, deskripsi)
                 VALUES (?,?,?,?,?,?,?,1,?)`,
                [nama, DEFAULT_UP, DEFAULT_DN, harga, masa, satuan, tipe, 'Auto-import dari billing lama']
            );
            p = await queryOne('SELECT * FROM paket WHERE id=?', [r.insertId]);
            p._baru = true;
        }
    }
    _paketCache.set(key, p);
    return p;
}

async function main() {
    log('═'.repeat(64));
    log(' MIGRASI DATA → SimBill ' + (DRY ? '  [DRY-RUN: tidak menulis]' : '  [EKSEKUSI]'));
    log('═'.repeat(64));
    log(' PPPoE  file :', PPPOE_FILE   || '(tidak ditemukan)');
    log(' Hotspot file:', HOTSPOT_FILE || '(tidak ditemukan)');

    // Username yang sudah ada (pelanggan + voucher) → untuk skip & cegah tabrakan radcheck
    const ada = new Set();
    (await query('SELECT username FROM pelanggan')).forEach(r => ada.add(r.username));
    (await query('SELECT username FROM voucher')).forEach(r => ada.add(r.username));
    log(` Username eksisting (pelanggan+voucher): ${ada.size}`);

    const ringkas = {};

    // ───────────────────────── PPPoE → pelanggan ────────────────────────────
    if (ONLY !== 'hotspot' && PPPOE_FILE) {
        const rows = await bacaXlsx(PPPOE_FILE);
        log(`\n── PPPoE: ${rows.length} baris ──`);
        let ok = 0, skip = 0, gagal = 0, susp = 0; const err = [];
        const paketBaru = new Set();

        for (const row of rows) {
            const username = String(row.username || '').trim();
            const password = String(row.password || '').trim();
            const profile  = String(row.profile  || '').trim();
            try {
                if (!username || !password || !profile) throw new Error('username/password/profile kosong');
                if (ada.has(username)) { skip++; continue; }

                const paket = await ensurePaket(profile, 'pppoe');
                if (paket._baru) paketBaru.add(profile);

                const disabled = row.disabled === true || /^(true|1|ya)$/i.test(String(row.disabled));
                const status   = disabled ? 'suspended' : 'aktif';
                const nama     = String(row.full_name || username).trim();
                const no_hp    = normNoHp(row.whatsapp);
                const email    = String(row.email   || '').trim() || null;
                const alamat   = String(row.address || '').trim() || null;

                // Expiry asli: pakai billing_start sebagai tgl_expired bila ada.
                let tgl_expired;
                const bs = String(row.billing_start || '').trim();
                if (bs) tgl_expired = dayjs(bs).format('YYYY-MM-DD');
                if (!tgl_expired || tgl_expired === 'Invalid Date')
                    tgl_expired = hitungExpired(paket.masa_aktif, paket.satuan_masa).format('YYYY-MM-DD');
                const tgl_aktif = dayjs().format('YYYY-MM-DD');

                if (DRY) { ok++; if (disabled) susp++; continue; }

                const hash = await bcrypt.hash(password, 10);
                const ins = await query(
                    `INSERT INTO pelanggan (nama, username, password, no_hp, email, alamat,
                        paket_id, tipe_koneksi, tgl_aktif, tgl_expired, status, notes)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [nama, username, hash, no_hp, email, alamat,
                     paket.id, 'pppoe', tgl_aktif, tgl_expired, status, 'Migrasi billing lama']
                );

                // RADIUS: buat user (radcheck + group + radreply + password terenkripsi)
                await radiusService.tambahUser(username, password, paket, 'pppoe', null)
                    .catch(async e => { await query('DELETE FROM pelanggan WHERE id=?', [ins.insertId]); throw new Error('RADIUS: ' + e.message); });

                // Hormati status disabled → suspend (Auth-Type Reject, hapus password radcheck)
                if (disabled) { await radiusService.suspendUser(username).catch(()=>{}); susp++; }

                ada.add(username); ok++;
            } catch (e) {
                gagal++; if (err.length < 25) err.push(`${username}: ${e.message}`);
            }
        }
        ringkas.pppoe = { total: rows.length, ok, skip, gagal, suspended: susp, paketBaru: [...paketBaru] };
        log(`   sukses=${ok} skip(eksisting)=${skip} gagal=${gagal} di-suspend=${susp}`);
        if (paketBaru.size) log(`   paket dibuat: ${[...paketBaru].join(', ')}`);
        if (err.length) { log('   contoh error:'); err.forEach(x => log('     -', x)); }
    }

    // ───────────────────────── Hotspot → voucher ────────────────────────────
    if (ONLY !== 'pppoe' && HOTSPOT_FILE) {
        const rows = await bacaXlsx(HOTSPOT_FILE);
        log(`\n── Hotspot: ${rows.length} baris ──`);

        // Apakah tabel voucher punya kolom batch_id? (beberapa instalasi punya)
        let punyaBatch = false;
        try {
            const c = await queryOne(
                `SELECT 1 AS ada FROM information_schema.columns
                 WHERE table_schema=DATABASE() AND table_name='voucher' AND column_name='batch_id' LIMIT 1`);
            punyaBatch = !!c;
        } catch (_) {}
        const batchId = 'IMPORT-HS-' + dayjs().format('YYMMDD');

        const STATUS_MAP = { new: 'unused', active: 'used', disabled: 'expired' };
        const paketBaru = new Set();
        let ok = 0, skip = 0, gagal = 0; const err = [];
        let batch = [];

        const flush = async () => {
            if (!batch.length || DRY) { ok += DRY ? batch.length : 0; batch = []; return; }
            const cols = punyaBatch
                ? '(username,password,paket_id,status,tgl_expired,batch_id)'
                : '(username,password,paket_id,status,tgl_expired)';
            const ph = batch.map(() => punyaBatch ? '(?,?,?,?,?,?)' : '(?,?,?,?,?)').join(',');
            const vals = [];
            for (const b of batch) {
                vals.push(b.username, b.password, b.paket_id, b.status, b.tgl_expired);
                if (punyaBatch) vals.push(batchId);
            }
            // INSERT IGNORE → baris duplikat (UNIQUE username) dilewati, bukan error
            const r = await query(`INSERT IGNORE INTO voucher ${cols} VALUES ${ph}`, vals);
            ok += r.affectedRows; skip += (batch.length - r.affectedRows);
            batch = [];
        };

        const seen = new Set();
        for (const row of rows) {
            const username = String(row.username || '').trim();
            const password = String(row.password || '').trim();
            const profile  = String(row.profile  || '').trim();
            try {
                if (!username || !password || !profile) throw new Error('field kosong');
                if (username.length > 32 || password.length > 32) throw new Error('username/password > 32 char');
                if (ada.has(username) || seen.has(username)) { skip++; continue; } // skip eksisting/tabrakan
                seen.add(username);

                const paket = await ensurePaket(profile, 'hotspot');
                if (paket._baru) paketBaru.add(profile);

                const status = STATUS_MAP[String(row.status || '').toLowerCase()] || 'unused';
                let tgl_expired = null;
                const ca = String(row.created_at || '').trim();
                if (ca) {
                    const d = dayjs(ca);
                    if (d.isValid()) tgl_expired = d.add(paket.masa_aktif, SATUAN2UNIT[paket.satuan_masa]).format('YYYY-MM-DD HH:mm:ss');
                }
                batch.push({ username, password, paket_id: paket.id, status, tgl_expired });
                if (batch.length >= VOUCHER_CHUNK) await flush();
            } catch (e) {
                gagal++; if (err.length < 25) err.push(`${username}: ${e.message}`);
            }
        }
        await flush();

        // Daftarkan semua voucher ke radcheck agar bisa autentikasi
        if (!DRY) { log('   sync voucher → radcheck...'); await radiusService.syncVoucher(); }

        ringkas.hotspot = { total: rows.length, ok, skip, gagal, paketBaru: [...paketBaru] };
        log(`   masuk=${ok} skip(eksisting/dup)=${skip} gagal=${gagal}`);
        if (paketBaru.size) log(`   paket dibuat: ${[...paketBaru].join(', ')}`);
        if (err.length) { log('   contoh error:'); err.forEach(x => log('     -', x)); }
    }

    log('\n' + '═'.repeat(64));
    log(' RINGKASAN:', JSON.stringify(ringkas, null, 2));
    if (DRY) log(' (DRY-RUN — tidak ada data ditulis. Jalankan tanpa --dry untuk eksekusi.)');
    else     log(' Selesai. Cek menu Pelanggan & Voucher di panel. Lalu EDIT kecepatan/harga paket auto.');
    log('═'.repeat(64));
}

main()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch(e => { console.error('FATAL:', e); try { pool.end(); } catch(_){} process.exit(1); });
