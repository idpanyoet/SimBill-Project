// routes/reseller.js — API untuk portal reseller
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { query, queryOne, withTransaction } = require('../config/db');
const { resellerAuth }    = require('../middleware/reseller-auth');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const paymentService = require('../services/payment');
const radiusService  = require('../services/radius');
const waService      = require('../services/whatsapp');
const dayjs = require('dayjs');

// Escape pencegah CSV/formula injection saat export Excel.
function sf(v) {
    return (typeof v === 'string' && /^[=+\-@\t\r]/.test(v)) ? "'" + v : v;
}
// Cek apakah sebuah batch_id milik reseller ini (penanda RSL-<id>-...).
function _batchMilikReseller(batchId, resellerId) {
    return typeof batchId === 'string' && batchId.startsWith(`RSL-${resellerId}-`);
}

// ── Helper hitung harga reseller (terima db handle opsional untuk dipakai dalam transaksi) ──
async function hitungHarga(resellerId, paketId, hargaNormal, db = { query, queryOne }) {
    // 1) Harga khusus per reseller (override tertinggi)
    const khusus = await db.queryOne(
        'SELECT harga_reseller FROM reseller_harga WHERE reseller_id=? AND paket_id=?',
        [resellerId, paketId]
    );
    if (khusus) return Math.max(0, parseFloat(khusus.harga_reseller) || 0);

    // 2) Harga reseller global per paket (diatur admin di profil paket)
    const pk = await db.queryOne('SELECT harga_reseller FROM paket WHERE id=?', [paketId]);
    if (pk && pk.harga_reseller != null && pk.harga_reseller !== '')
        return Math.max(0, parseFloat(pk.harga_reseller) || 0);

    // 3) Tidak ada Harga Reseller yang diset → pakai harga normal
    return Math.max(0, Math.round(hargaNormal));
}

// ── Helper catat mutasi saldo. WAJIB dipanggil dengan db handle dari withTransaction
//    saat melibatkan pengurangan saldo akibat pembelian, agar FOR UPDATE + rollback bekerja. ──
async function catatMutasi(db, resellerId, tipe, jumlah, keterangan, refId = null, method = null) {
    const r = await db.queryOne('SELECT saldo FROM reseller WHERE id=? FOR UPDATE', [resellerId]);
    if (!r) throw new Error('Reseller tidak ditemukan');

    // PENTING: paksa angka. Bila 'jumlah' berupa string (mis. "220000"),
    // operasi sebelum + jumlah akan menjadi penggabungan teks
    // ("2239" + "220000" = "2239220000"), bukan penjumlahan.
    const sebelum = parseFloat(r.saldo) || 0;
    const nilai   = parseFloat(jumlah);
    if (isNaN(nilai)) throw new Error('Jumlah mutasi tidak valid');
    const mengurangi = tipe === 'pembelian' || tipe === 'koreksi';
    const sesudah = mengurangi ? sebelum - nilai : sebelum + nilai;

    if (mengurangi && sesudah < 0)
        throw new Error('Saldo tidak mencukupi');

    await db.query('UPDATE reseller SET saldo=? WHERE id=?', [sesudah, resellerId]);
    await db.query(`
        INSERT INTO reseller_mutasi
          (reseller_id, tipe, jumlah, saldo_sebelum, saldo_sesudah, keterangan, ref_id, payment_method)
        VALUES (?,?,?,?,?,?,?,?)
    `, [resellerId, tipe, nilai, sebelum, sesudah, keterangan, refId, method]);

    return sesudah;
}

// ============================================================
// AUTH
// ============================================================

// POST /reseller/auth/login
router.post('/auth/login', async (req, res, next) => {
    try {
        const { username, password } = req.body;
        if (!username || !password)
            return res.status(400).json({ error: 'Username dan password wajib' });

        const r = await queryOne(
            "SELECT * FROM reseller WHERE (username=? OR no_hp=?) AND status='aktif'",
            [username, username]
        );
        if (!r) return res.status(401).json({ error: 'Username atau password salah' });

        const valid = await bcrypt.compare(password, r.password);
        if (!valid) return res.status(401).json({ error: 'Username atau password salah' });

        await query('UPDATE reseller SET last_login=NOW() WHERE id=?', [r.id]);

        const token = jwt.sign(
            { id: r.id, nama: r.nama, username: r.username, role: 'reseller', level: r.level },
            process.env.JWT_SECRET + '_reseller',
            { expiresIn: '12h' }
        );

        res.json({
            token,
            reseller: {
                id: r.id, nama: r.nama, username: r.username,
                level: r.level, saldo: r.saldo, no_hp: r.no_hp
            }
        });
    } catch (e) { next(e); }
});

// POST /reseller/auth/register (publik, perlu approve admin)
router.post('/auth/register', async (req, res, next) => {
    try {
        let { nama, username, password, no_hp, email } = req.body;
        if (!nama || !username || !password || !no_hp)
            return res.status(400).json({ error: 'Semua field wajib diisi' });
        // Pendaftaran publik — netralkan input sebelum admin melihatnya di panel.
        nama  = String(nama).replace(/[<>]/g, '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 100);
        email = email ? String(email).replace(/[<>]/g, '').trim().slice(0, 254) : null;
        username = String(username).trim();
        if (!nama) return res.status(400).json({ error: 'Nama tidak valid' });
        if (!/^[A-Za-z0-9._-]{3,32}$/.test(username))
            return res.status(400).json({ error: 'Username 3-32 karakter, hanya huruf/angka . _ -' });
        if (!/^[0-9+]{8,16}$/.test(String(no_hp).trim()))
            return res.status(400).json({ error: 'Nomor HP tidak valid' });
        no_hp = String(no_hp).trim();
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
            return res.status(400).json({ error: 'Format email tidak valid' });

        const ada = await queryOne('SELECT id FROM reseller WHERE username=?', [username]);
        if (ada) return res.status(400).json({ error: 'Username sudah digunakan' });

        const hash = await bcrypt.hash(password, 12);
        const token_api = require('crypto').randomBytes(32).toString('hex');

        const _ins = await query(`
            INSERT INTO reseller (nama, username, password, no_hp, email, token_api, status)
            VALUES (?,?,?,?,?,?,'nonaktif')
        `, [nama, username, hash, no_hp, email || null, token_api]);

        res.status(201).json({
            pesan: 'Registrasi berhasil, menunggu persetujuan admin',
            id: _ins ? _ins.insertId : undefined,
        });
    } catch (e) { next(e); }
});

// GET /reseller/profil
router.get('/profil', resellerAuth, async (req, res, next) => {
    try {
        const r = await queryOne(
            'SELECT id,nama,username,no_hp,alamat,email,saldo,komisi_persen,level,status,created_at FROM reseller WHERE id=?',
            [req.reseller.id]
        );
        res.json(r);
    } catch (e) { next(e); }
});

// PUT /reseller/profil — reseller mengubah profilnya sendiri
// (nama, no_hp, alamat, email). Tidak boleh ubah username/level/saldo/status.
router.put('/profil', resellerAuth, async (req, res, next) => {
    try {
        let { nama, no_hp, alamat, email } = req.body;
        nama   = (nama  == null ? '' : String(nama)).replace(/[<>]/g, '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 150);
        no_hp  = (no_hp == null ? '' : String(no_hp)).trim();
        alamat = (alamat == null || alamat === '') ? null : String(alamat).replace(/[<>]/g, '').trim().slice(0, 255);
        email  = (email  == null || email  === '') ? null : String(email).replace(/[<>]/g, '').trim().slice(0, 150);

        if (!nama) return res.status(400).json({ error: 'Nama wajib diisi' });
        if (!/^[0-9+]{8,16}$/.test(no_hp)) return res.status(400).json({ error: 'Nomor HP tidak valid' });
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
            return res.status(400).json({ error: 'Format email tidak valid' });

        // Email unik (kecuali milik sendiri)
        if (email) {
            const bentrok = await queryOne('SELECT id FROM reseller WHERE email=? AND id<>?', [email, req.reseller.id]);
            if (bentrok) return res.status(400).json({ error: 'Email sudah dipakai reseller lain' });
        }

        await query(
            'UPDATE reseller SET nama=?, no_hp=?, alamat=?, email=? WHERE id=?',
            [nama, no_hp, alamat, email, req.reseller.id]
        );
        res.json({ pesan: 'Profil berhasil diperbarui', nama, no_hp, alamat, email });
    } catch (e) { next(e); }
});

// PUT /reseller/password — reseller ganti password sendiri (verifikasi password lama)
router.put('/password', resellerAuth, async (req, res, next) => {
    try {
        const { password_lama, password_baru } = req.body || {};
        if (!password_lama || !password_baru)
            return res.status(400).json({ error: 'Password lama & baru wajib diisi' });
        if (String(password_baru).length < 6)
            return res.status(400).json({ error: 'Password baru minimal 6 karakter' });

        const r = await queryOne('SELECT password FROM reseller WHERE id=?', [req.reseller.id]);
        if (!r) return res.status(404).json({ error: 'Reseller tidak ditemukan' });

        const cocok = await bcrypt.compare(String(password_lama), r.password);
        if (!cocok) return res.status(400).json({ error: 'Password lama salah' });

        const hash = await bcrypt.hash(String(password_baru), 10);
        await query('UPDATE reseller SET password=? WHERE id=?', [hash, req.reseller.id]);
        res.json({ pesan: 'Password berhasil diganti' });
    } catch (e) { next(e); }
});

// ============================================================
// SALDO & TOPUP
// ============================================================

// GET /reseller/saldo
router.get('/saldo', resellerAuth, async (req, res, next) => {
    try {
        const r     = await queryOne('SELECT saldo FROM reseller WHERE id=?', [req.reseller.id]);
        const mutasi = await query(`
            SELECT * FROM reseller_mutasi WHERE reseller_id=?
            ORDER BY created_at DESC LIMIT 20
        `, [req.reseller.id]);
        res.json({ saldo: r.saldo, mutasi });
    } catch (e) { next(e); }
});

// POST /reseller/topup — buat request topup saldo via payment gateway
router.post('/topup', resellerAuth, async (req, res, next) => {
    try {
        const { jumlah } = req.body;
        if (!jumlah || jumlah < 10000)
            return res.status(400).json({ error: 'Minimum topup Rp 10.000' });
        if (jumlah > 50000000)
            return res.status(400).json({ error: 'Maksimum topup Rp 50.000.000' });

        const r        = await queryOne('SELECT * FROM reseller WHERE id=?', [req.reseller.id]);
        const order_id = `TOP-${req.reseller.id}-${Date.now()}`;

        // Provider mengikuti konfigurasi admin (Setting > Payment Gateway)
        const pg = await paymentService.buatTransaksi({
            order_id,
            gross_amount: jumlah,
            pelanggan: {
                nama:      r.nama,
                no_hp:     r.no_hp,
                username:  r.username,
                email:     r.email || `${r.username}@reseller.id`,
                paket_id:  null,
                nama_paket: 'Topup Saldo Reseller'
            }
        });

        if (!pg?.payment_url) {
            const detail = (typeof paymentService.getLastError === 'function')
                ? paymentService.getLastError() : null;
            console.error(`[RESELLER] Topup gagal buat link untuk ${order_id}:`, detail || '(tanpa detail)');
            return res.status(400).json({
                error: 'Gagal membuat link pembayaran. Pastikan payment gateway sudah dikonfigurasi admin di Setting > Payment Gateway.',
                detail: detail || undefined
            });
        }

        const prov = await queryOne("SELECT nilai FROM setting WHERE kunci='pg_provider'");
        await query(`
            INSERT INTO reseller_topup (reseller_id, order_id, jumlah, payment_url, payment_method, status)
            VALUES (?,?,?,?,?,'pending')
        `, [req.reseller.id, order_id, jumlah, pg.payment_url, prov?.nilai || 'gateway']);

        res.json({
            order_id,
            jumlah,
            payment_url: pg.payment_url,
            pesan: 'Silakan selesaikan pembayaran'
        });
    } catch (e) { next(e); }
});

// GET /reseller/topup — riwayat topup
router.get('/topup', resellerAuth, async (req, res, next) => {
    try {
        const per = Math.min(Math.max(parseInt(req.query.per, 10) || 10, 1), 50);
        const hal = Math.max(parseInt(req.query.hal, 10) || 1, 1);
        const off = (hal - 1) * per;
        const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM reseller_topup WHERE reseller_id=?`, [req.reseller.id]);
        const rows = await query(`
            SELECT * FROM reseller_topup WHERE reseller_id=?
            ORDER BY created_at DESC LIMIT ? OFFSET ?
        `, [req.reseller.id, per, off]);
        res.json({ data: rows, total: totalRow?.total || 0, hal, per });
    } catch (e) { next(e); }
});

// ============================================================
// PAKET (harga reseller)
// ============================================================

// GET /reseller/paket
router.get('/paket', resellerAuth, async (req, res, next) => {
    try {
        // Cek apakah reseller punya daftar izin paket.
        // - Ada baris izin → tampilkan HANYA paket yang diizinkan.
        // - Tidak ada baris izin → tampilkan semua (sesuai aturan "kosongkan = semua").
        let izinRows = [];
        try {
            izinRows = await query(
                `SELECT paket_id FROM reseller_izin_paket WHERE reseller_id=?`,
                [req.reseller.id]
            );
        } catch (_) { izinRows = []; }

        let filterIzin = '';
        const params = [req.reseller.id];
        if (izinRows.length) {
            const ids = izinRows.map(r => parseInt(r.paket_id)).filter(Number.isInteger);
            const ph = ids.map(() => '?').join(', ');
            filterIzin = ` AND p.id IN (${ph})`;
            params.push(...ids);
        }

        const paket = await query(`
            SELECT p.*,
                COALESCE(rh.harga_reseller, p.harga_reseller, p.harga) AS harga_jual
            FROM paket p
            LEFT JOIN reseller_harga rh ON rh.paket_id=p.id AND rh.reseller_id=?
            WHERE p.aktif=1${filterIzin}
            ORDER BY p.harga
        `, params);
        res.json(paket);
    } catch (e) { next(e); }
});

// ============================================================
// BELI VOUCHER (pakai saldo)
// ============================================================

// POST /reseller/beli/voucher
router.post('/beli/voucher', resellerAuth, async (req, res, next) => {
    try {
        const { paket_id, jumlah = 1 } = req.body;
        if (!paket_id) return res.status(400).json({ error: 'paket_id wajib' });
        if (jumlah < 1 || jumlah > 100)
            return res.status(400).json({ error: 'Jumlah 1–100 voucher per transaksi' });

        const paket = await queryOne('SELECT * FROM paket WHERE id=? AND aktif=1', [paket_id]);
        if (!paket) return res.status(404).json({ error: 'Paket tidak ditemukan' });

        // Validasi izin paket: jika reseller punya daftar izin, paket harus termasuk.
        try {
            const izin = await query(`SELECT 1 FROM reseller_izin_paket WHERE reseller_id=?`, [req.reseller.id]);
            if (izin.length) {
                const boleh = await queryOne(`SELECT 1 FROM reseller_izin_paket WHERE reseller_id=? AND paket_id=?`, [req.reseller.id, paket_id]);
                if (!boleh) return res.status(403).json({ error: 'Paket ini tidak diizinkan untuk akun Anda' });
            }
        } catch (_) { /* tabel belum ada = izinkan semua */ }

        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const genKode = () => {
            const b = () => Array.from({ length: 4 }, () => chars[require('crypto').randomInt(chars.length)]).join('');
            return `${b()}-${b()}-${b()}`;
        };

        // Seluruh proses dalam SATU transaksi: hitung harga, kunci saldo, potong saldo,
        // generate voucher, dan catat transaksi. Jika saldo tidak cukup di tengah jalan,
        // semua di-rollback otomatis termasuk voucher yang sudah dibuat.
        const hasil = await withTransaction(async (db) => {
            const hargaReseller = await hitungHarga(req.reseller.id, paket_id, paket.harga, db);
            const totalBayar    = hargaReseller * jumlah;

            // catatMutasi mengunci baris reseller (FOR UPDATE) dan akan throw
            // jika saldo tidak cukup — ini cek final yang aman dari race condition.
            const refId = `TRX-${Date.now()}`;
            const saldoSisa = await catatMutasi(db, req.reseller.id, 'pembelian', totalBayar,
                `Beli ${jumlah}x voucher ${paket.nama}`, refId);

            // batch_id penanda reseller: RSL-<resellerId>-<timestamp> → dipakai
            // untuk panel "Riwayat Batch Generate" + scoping export milik reseller.
            const batchId = `RSL-${req.reseller.id}-${Date.now().toString(36).toUpperCase()}`;

            const kodes = [];
            for (let i = 0; i < jumlah; i++) {
                const kode = genKode();
                // Skema voucher baru memakai username+password (mode username=password),
                // bukan kolom `kode` yang sudah dihapus. Tanpa ini INSERT gagal & seluruh
                // transaksi rollback (saldo tidak terpotong, voucher tidak terbuat).
                await db.query(`
                    INSERT INTO voucher (username, password, paket_id, status, tgl_expired, batch_id)
                    VALUES (?,?,?,'unused', NULL, ?)
                `, [kode, kode, paket_id, batchId]);
                kodes.push(kode);
            }

            await db.query(`
                INSERT INTO reseller_transaksi
                  (reseller_id, tipe, paket_id, jumlah_item, harga_normal, harga_reseller, total_bayar, detail)
                VALUES (?,?,?,?,?,?,?,?)
            `, [req.reseller.id, 'voucher', paket_id, jumlah,
                paket.harga, hargaReseller, totalBayar, JSON.stringify({ voucher: kodes, batch_id: batchId })]);

            return { kodes, hargaReseller, totalBayar, saldoSisa, batch_id: batchId };
        });

        // Daftarkan voucher ke radcheck SETELAH transaksi commit, supaya
        // FreeRADIUS bisa mengautentikasi voucher saat dipakai login hotspot.
        for (const kode of hasil.kodes) {
            radiusService.syncVoucher(kode).catch(err =>
                console.warn(`[RESELLER] Sync radcheck voucher ${kode} gagal:`, err.message));
        }

        // Kirim via WA jika hanya 1 voucher (di luar transaksi — gagal kirim WA tidak boleh rollback pembelian)
        if (jumlah === 1) {
            const re = await queryOne('SELECT no_hp, nama FROM reseller WHERE id=?', [req.reseller.id]);
            waService.kirimVoucher({
                no_hp: re.no_hp, nama: re.nama,
                username: hasil.kodes[0], password: hasil.kodes[0],
                paket: paket.nama,
                masa_aktif: `${paket.masa_aktif} ${paket.satuan_masa || 'hari'}`,
                kecepatan: paket.kecepatan_dn ? `${paket.kecepatan_dn} Mbps` : '-',
                voucher_list: hasil.kodes.join(', '), quantity: hasil.kodes.length
            }).catch(err => console.warn('[RESELLER] Kirim WA voucher gagal:', err.message));
        }

        res.json({
            sukses: true,
            voucher: hasil.kodes,
            paket: paket.nama,
            harga_reseller: hasil.hargaReseller,
            total_bayar: hasil.totalBayar,
            saldo_sisa: hasil.saldoSisa
        });
    } catch (e) {
        if (e.message === 'Saldo tidak mencukupi') {
            return res.status(400).json({ error: 'Saldo tidak mencukupi untuk pembelian ini' });
        }
        next(e);
    }
});

// ============================================================
// BELI USER PPPoE / Hotspot (pakai saldo)
// ============================================================

// POST /reseller/beli/user
router.post('/beli/user', resellerAuth, async (req, res, next) => {
    // Penambahan pelanggan oleh reseller dinonaktifkan (kebijakan).
    return res.status(403).json({ error: 'Penambahan pelanggan oleh reseller dinonaktifkan. Hubungi admin.' });
    // eslint-disable-next-line no-unreachable
    try {
        const { paket_id, username, password, nama_pelanggan,
                no_hp_pelanggan, tipe_koneksi = 'pppoe' } = req.body;

        if (!paket_id || !username || !password)
            return res.status(400).json({ error: 'paket_id, username, password wajib' });
        if (!['pppoe', 'hotspot'].includes(tipe_koneksi))
            return res.status(400).json({ error: 'tipe_koneksi harus pppoe atau hotspot' });

        const paket = await queryOne('SELECT * FROM paket WHERE id=? AND aktif=1', [paket_id]);
        if (!paket) return res.status(404).json({ error: 'Paket tidak ditemukan' });

        const re = await queryOne('SELECT no_hp FROM reseller WHERE id=?', [req.reseller.id]);

        // Transaksi atomik: cek username unik, kunci & potong saldo, insert pelanggan,
        // catat transaksi. RADIUS sync dilakukan SETELAH commit berhasil, karena
        // RADIUS bukan bagian dari database transaksional ini.
        const hasil = await withTransaction(async (db) => {
            // Cek duplikat username di dalam transaksi (hindari race condition antar request)
            const ada = await db.queryOne('SELECT id FROM pelanggan WHERE username=?', [username]);
            if (ada) throw new Error('USERNAME_DUPLIKAT');

            const hargaReseller = await hitungHarga(req.reseller.id, paket_id, paket.harga, db);
            const refId = `TRX-${Date.now()}`;

            // Potong saldo dulu (akan throw jika tidak cukup) sebelum membuat pelanggan
            const saldoSisa = await catatMutasi(db, req.reseller.id, 'pembelian', hargaReseller,
                `Beli user ${tipe_koneksi} "${username}" paket ${paket.nama}`, refId);

            const tgl_aktif   = dayjs().format('YYYY-MM-DD');
            const tgl_expired = dayjs().add(paket.masa_aktif, 'day').format('YYYY-MM-DD');
            const hash        = await bcrypt.hash(password, 10);

            const result = await db.query(`
                INSERT INTO pelanggan
                  (nama, username, password, no_hp, paket_id, reseller_id, tipe_koneksi,
                   tgl_aktif, tgl_expired, status, notes)
                VALUES (?,?,?,?,?,?,?,?,?,'aktif',?)
            `, [
                nama_pelanggan || username, username, hash,
                no_hp_pelanggan || re.no_hp,
                paket_id, req.reseller.id, tipe_koneksi, tgl_aktif, tgl_expired,
                `Dibuat oleh reseller: ${req.reseller.username}`
            ]);

            await db.query(`
                INSERT INTO reseller_transaksi
                  (reseller_id, tipe, paket_id, jumlah_item, harga_normal,
                   harga_reseller, total_bayar, detail)
                VALUES (?,?,?,?,?,?,?,?)
            `, [req.reseller.id, tipe_koneksi, paket_id, 1,
                paket.harga, hargaReseller, hargaReseller,
                JSON.stringify({ username, tgl_expired, pelanggan_id: result.insertId })]);

            return { hargaReseller, saldoSisa, tgl_expired, pelangganId: result.insertId };
        });

        // Sync ke RADIUS setelah transaksi DB sukses.
        // Jika ini gagal, pelanggan & saldo tetap tercatat (perlu retry manual via panel admin),
        // tapi setidaknya data finansial konsisten — tidak ada saldo hilang tanpa user dibuat.
        try {
            await radiusService.tambahUser(username, password, paket, tipe_koneksi, null);
        } catch (radiusErr) {
            console.error(`[RESELLER] Gagal sync RADIUS untuk ${username}:`, radiusErr.message);
            return res.status(207).json({
                sukses: true,
                peringatan: 'User & saldo tercatat, namun sinkronisasi RADIUS gagal. Hubungi admin untuk aktivasi manual.',
                username, password,
                paket: paket.nama,
                tgl_expired: hasil.tgl_expired,
                harga_reseller: hasil.hargaReseller,
                saldo_sisa: hasil.saldoSisa
            });
        }

        res.json({
            sukses: true,
            username,
            password,
            paket: paket.nama,
            tgl_expired: hasil.tgl_expired,
            harga_reseller: hasil.hargaReseller,
            saldo_sisa: hasil.saldoSisa
        });
    } catch (e) {
        if (e.message === 'USERNAME_DUPLIKAT' || e.code === 'ER_DUP_ENTRY')
            return res.status(400).json({ error: 'Username sudah digunakan' });
        if (e.message === 'Saldo tidak mencukupi')
            return res.status(400).json({ error: 'Saldo tidak mencukupi untuk pembelian ini' });
        next(e);
    }
});

// ============================================================
// PELANGGAN SAYA — reseller kelola pelanggan PPPoE/hotspot miliknya
// ============================================================

// GET /reseller/pelanggan — daftar pelanggan milik reseller ini
router.get('/pelanggan', resellerAuth, async (req, res, next) => {
    try {
        const cari = (req.query.cari || '').trim();
        const params = [req.reseller.id];
        let filter = '';
        if (cari) {
            filter = ` AND (p.nama LIKE ? OR p.username LIKE ? OR p.no_hp LIKE ?)`;
            const like = `%${cari}%`;
            params.push(like, like, like);
        }
        const rows = await query(`
            SELECT p.id, p.nama, p.username, p.no_hp, p.tipe_koneksi, p.status,
                   p.tgl_aktif, p.tgl_expired, pk.nama AS nama_paket, pk.id AS paket_id
            FROM pelanggan p
            LEFT JOIN paket pk ON p.paket_id = pk.id
            WHERE p.reseller_id = ?${filter}
            ORDER BY p.id DESC
        `, params);
        res.json(rows);
    } catch (e) { next(e); }
});

// Helper: pastikan pelanggan milik reseller ini
async function pelangganMilik(resellerId, id) {
    return await queryOne('SELECT * FROM pelanggan WHERE id=? AND reseller_id=?', [id, resellerId]);
}

// POST /reseller/pelanggan/:id/suspend
router.post('/pelanggan/:id/suspend', resellerAuth, async (req, res, next) => {
    try {
        const p = await pelangganMilik(req.reseller.id, req.params.id);
        if (!p) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });
        await query("UPDATE pelanggan SET status='suspended' WHERE id=?", [p.id]);
        try { await radiusService.suspendUser(p.username); } catch (e) { console.warn('[RESELLER] suspend radius:', e.message); }
        res.json({ pesan: `${p.nama} disuspend` });
    } catch (e) { next(e); }
});

// POST /reseller/pelanggan/:id/aktifkan
router.post('/pelanggan/:id/aktifkan', resellerAuth, async (req, res, next) => {
    try {
        const p = await pelangganMilik(req.reseller.id, req.params.id);
        if (!p) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });
        await query("UPDATE pelanggan SET status='aktif' WHERE id=?", [p.id]);
        try { await radiusService.aktifkanUser(p.username); } catch (e) { console.warn('[RESELLER] aktifkan radius:', e.message); }
        res.json({ pesan: `${p.nama} diaktifkan` });
    } catch (e) { next(e); }
});

// POST /reseller/pelanggan/:id/perpanjang — perpanjang masa aktif (potong saldo)
router.post('/pelanggan/:id/perpanjang', resellerAuth, async (req, res, next) => {
    try {
        const p = await pelangganMilik(req.reseller.id, req.params.id);
        if (!p) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });
        const paket = await queryOne('SELECT * FROM paket WHERE id=?', [p.paket_id]);
        if (!paket) return res.status(404).json({ error: 'Paket pelanggan tidak ditemukan' });

        const hasil = await withTransaction(async (db) => {
            const harga = await hitungHarga(req.reseller.id, p.paket_id, paket.harga, db);
            const refId = `TRX-${Date.now()}`;
            const saldoSisa = await catatMutasi(db, req.reseller.id, 'pembelian', harga,
                `Perpanjang ${p.username} paket ${paket.nama}`, refId);

            // Perpanjang dari tgl_expired (jika belum lewat) atau dari hari ini
            const mulai = (p.tgl_expired && dayjs(p.tgl_expired).isAfter(dayjs())) ? dayjs(p.tgl_expired) : dayjs();
            const tglBaru = mulai.add(paket.masa_aktif, 'day').format('YYYY-MM-DD');
            await db.query("UPDATE pelanggan SET tgl_expired=?, status='aktif' WHERE id=?", [tglBaru, p.id]);

            await db.query(`
                INSERT INTO reseller_transaksi
                  (reseller_id, tipe, paket_id, jumlah_item, harga_normal, harga_reseller, total_bayar, detail)
                VALUES (?,?,?,?,?,?,?,?)
            `, [req.reseller.id, p.tipe_koneksi, p.paket_id, 1, paket.harga, harga, harga,
                JSON.stringify({ perpanjang: p.username, tgl_expired: tglBaru })]);

            return { harga, saldoSisa, tglBaru };
        });

        try { await radiusService.aktifkanUser(p.username); } catch (e) {}
        res.json({ sukses: true, pesan: `Diperpanjang s/d ${hasil.tglBaru}`, saldo_sisa: hasil.saldoSisa, harga: hasil.harga });
    } catch (e) {
        if (e.message === 'Saldo tidak mencukupi')
            return res.status(400).json({ error: 'Saldo tidak mencukupi untuk perpanjangan' });
        next(e);
    }
});

// DELETE /reseller/pelanggan/:id
router.delete('/pelanggan/:id', resellerAuth, async (req, res, next) => {
    // Penghapusan pelanggan oleh reseller dinonaktifkan (kebijakan).
    return res.status(403).json({ error: 'Penghapusan pelanggan oleh reseller dinonaktifkan. Hubungi admin.' });
    // eslint-disable-next-line no-unreachable
    try {
        const p = await pelangganMilik(req.reseller.id, req.params.id);
        if (!p) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });
        try { await radiusService.hapusUser(p.username); } catch (e) { console.warn('[RESELLER] hapus radius:', e.message); }
        await query('DELETE FROM pelanggan WHERE id=?', [p.id]);
        res.json({ pesan: `${p.nama} dihapus` });
    } catch (e) { next(e); }
});

// GET /reseller/laporan — ringkasan untuk halaman Laporan
router.get('/laporan', resellerAuth, async (req, res, next) => {
    try {
        const id = req.reseller.id;
        const [tot] = await query(
            "SELECT COUNT(*) AS jml, COALESCE(SUM(total_bayar),0) AS total FROM reseller_transaksi WHERE reseller_id=? AND status='success'", [id]);
        const [bulan] = await query(
            `SELECT COALESCE(SUM(total_bayar),0) AS total FROM reseller_transaksi WHERE reseller_id=? AND status='success'
               AND YEAR(created_at)=YEAR(CURDATE()) AND MONTH(created_at)=MONTH(CURDATE())`, [id]);
        const perTipe = await query(
            "SELECT tipe, COUNT(*) AS jml, COALESCE(SUM(total_bayar),0) AS total FROM reseller_transaksi WHERE reseller_id=? AND status='success' GROUP BY tipe", [id]);
        const r = await queryOne('SELECT saldo FROM reseller WHERE id=?', [id]);
        res.json({ total_transaksi: tot.jml, total_pengeluaran: tot.total, bulan_ini: bulan.total, saldo: r?.saldo || 0, per_tipe: perTipe });
    } catch (e) { next(e); }
});

// ============================================================
// RIWAYAT TRANSAKSI RESELLER
// ============================================================

// GET /reseller/transaksi
router.get('/transaksi', resellerAuth, async (req, res, next) => {
    try {
        const { halaman = 1, limit = 20, tipe } = req.query;
        const offset = (parseInt(halaman) - 1) * parseInt(limit);
        const cond = ['rt.reseller_id=?']; const params = [req.reseller.id];
        if (tipe && ['voucher','pppoe','hotspot'].includes(tipe)) { cond.push('rt.tipe=?'); params.push(tipe); }
        const whereStr = cond.join(' AND ');
        const rows = await query(`
            SELECT rt.*, p.nama AS nama_paket
            FROM reseller_transaksi rt
            JOIN paket p ON rt.paket_id = p.id
            WHERE ${whereStr}
            ORDER BY rt.created_at DESC LIMIT ? OFFSET ?
        `, [...params, parseInt(limit), offset]);
        const [{ total }] = await query(
            `SELECT COUNT(*) AS total FROM reseller_transaksi rt WHERE ${whereStr}`,
            params
        );
        res.json({ data: rows, total });
    } catch (e) { next(e); }
});

// POST /reseller/invoice/:no/bayar-saldo — bayar invoice pelanggan pakai saldo reseller
router.post('/invoice/:no/bayar-saldo', resellerAuth, async (req, res, next) => {
    try {
        // Invoice harus milik pelanggan reseller ini
        const inv = await queryOne(`
            SELECT i.*, p.username, p.reseller_id, p.tgl_expired, p.paket_id AS pel_paket_id,
                   p.tipe_koneksi, pk.masa_aktif, pk.nama AS nama_paket
            FROM invoice i
            JOIN pelanggan p ON i.pelanggan_id = p.id
            LEFT JOIN paket pk ON i.paket_id = pk.id
            WHERE i.no_invoice = ? AND p.reseller_id = ?`,
            [req.params.no, req.reseller.id]);
        if (!inv) return res.status(404).json({ error: 'Invoice tidak ditemukan atau bukan milik pelanggan Anda' });
        if (inv.status === 'paid') return res.status(400).json({ error: 'Invoice sudah dibayar' });

        const hasil = await withTransaction(async (db) => {
            const jumlah = Number(inv.jumlah);
            const refId = `INV-${inv.no_invoice}`;
            // Potong saldo reseller (throw 'Saldo tidak mencukupi' jika kurang)
            const saldoSisa = await catatMutasi(db, req.reseller.id, 'pembelian', jumlah,
                `Bayar invoice ${inv.no_invoice} (${inv.username})`, refId);

            // Tandai invoice lunas
            await db.query(
                `UPDATE invoice SET status='paid', tgl_bayar=NOW(), metode_bayar='saldo_reseller' WHERE id=?`,
                [inv.id]);

            // Perpanjang masa aktif pelanggan
            let tglBaru = null;
            if (inv.masa_aktif) {
                const mulai = (inv.tgl_expired && dayjs(inv.tgl_expired).isAfter(dayjs())) ? dayjs(inv.tgl_expired) : dayjs();
                tglBaru = mulai.add(inv.masa_aktif, 'day').format('YYYY-MM-DD');
                await db.query("UPDATE pelanggan SET tgl_expired=?, status='aktif' WHERE id=?", [tglBaru, inv.pelanggan_id]);
            }

            // Catat transaksi reseller
            await db.query(`
                INSERT INTO reseller_transaksi
                  (reseller_id, tipe, paket_id, jumlah_item, harga_normal, harga_reseller, total_bayar, detail)
                VALUES (?,?,?,?,?,?,?,?)
            `, [req.reseller.id, inv.tipe_koneksi || 'pppoe', inv.paket_id, 1, jumlah, jumlah, jumlah,
                JSON.stringify({ bayar_invoice: inv.no_invoice, pelanggan: inv.username, tgl_expired: tglBaru })]);

            return { saldoSisa, tglBaru, jumlah };
        });

        try { await radiusService.aktifkanUser(inv.username); } catch (e) {}
        res.json({
            sukses: true,
            pesan: `Invoice ${inv.no_invoice} lunas` + (hasil.tglBaru ? `, aktif s/d ${hasil.tglBaru}` : ''),
            saldo_sisa: hasil.saldoSisa,
            jumlah: hasil.jumlah
        });
    } catch (e) {
        if (e.message === 'Saldo tidak mencukupi')
            return res.status(400).json({ error: 'Saldo tidak mencukupi untuk membayar invoice ini' });
        next(e);
    }
});

// GET /reseller/cari-transaksi?q= — cari INVOICE pelanggan milik reseller sendiri
router.get('/cari-transaksi', resellerAuth, async (req, res, next) => {
    try {
        const id = req.reseller.id;
        const q = (req.query.q || '').trim();
        if (!q) return res.json([]);
        const like = `%${q}%`;
        // Cari invoice dari pelanggan yang reseller_id-nya = reseller ini.
        // Bisa cari: no_invoice, nama pelanggan, username, atau nama paket.
        const rows = await query(`
            SELECT i.no_invoice, i.jumlah, i.status, i.tgl_jatuh_tempo, i.tgl_bayar,
                   i.created_at, i.pelanggan_id, p.nama AS nama_pelanggan, p.username,
                   pk.nama AS nama_paket
            FROM invoice i
            JOIN pelanggan p ON i.pelanggan_id = p.id
            LEFT JOIN paket pk ON i.paket_id = pk.id
            WHERE p.reseller_id = ?
              AND (
                i.no_invoice LIKE ?
                OR p.nama LIKE ?
                OR p.username LIKE ?
                OR pk.nama LIKE ?
              )
            ORDER BY i.created_at DESC
            LIMIT 50
        `, [id, like, like, like, like]);
        res.json(rows);
    } catch (e) { next(e); }
});

// GET /reseller/dashboard — ringkasan untuk dashboard reseller
router.get('/dashboard', resellerAuth, async (req, res, next) => {
    try {
        const id = req.reseller.id;
        const r = await queryOne('SELECT nama, username, saldo, level FROM reseller WHERE id=?', [id]);
        const [hariIni] = await query(
            `SELECT COUNT(*) AS jml, COALESCE(SUM(total_bayar),0) AS total
             FROM reseller_transaksi WHERE reseller_id=? AND status='success' AND DATE(created_at)=CURDATE()`, [id]);
        const [bulanIni] = await query(
            `SELECT COUNT(*) AS jml, COALESCE(SUM(total_bayar),0) AS total
             FROM reseller_transaksi WHERE reseller_id=? AND status='success'
               AND YEAR(created_at)=YEAR(CURDATE()) AND MONTH(created_at)=MONTH(CURDATE())`, [id]);
        const [totalItem] = await query(
            `SELECT COALESCE(SUM(jumlah_item),0) AS total FROM reseller_transaksi WHERE reseller_id=? AND status='success'`, [id]);
        const [pelangganku] = await query(
            `SELECT COUNT(*) AS jml FROM pelanggan WHERE reseller_id=?`, [id]);
        // Total voucher yang pernah dijual/dibuat reseller (jumlah item dari transaksi voucher)
        const [voucherku] = await query(
            `SELECT COALESCE(SUM(jumlah_item),0) AS jml FROM reseller_transaksi
             WHERE reseller_id=? AND status='success' AND tipe='voucher'`, [id]);
        const terbaru = await query(
            `SELECT rt.tipe, rt.jumlah_item, rt.total_bayar, rt.created_at, p.nama AS nama_paket
             FROM reseller_transaksi rt LEFT JOIN paket p ON rt.paket_id=p.id
             WHERE rt.reseller_id=? ORDER BY rt.created_at DESC LIMIT 8`, [id]);
        res.json({
            reseller: r,
            hari_ini: hariIni, bulan_ini: bulanIni,
            total_item_terjual: totalItem.total,
            jml_pelanggan: pelangganku.jml,
            total_voucher: voucherku.jml,
            transaksi_terbaru: terbaru
        });
    } catch (e) { next(e); }
});

// ============================================================
// ADMIN — kelola reseller
// ============================================================

// GET /reseller/admin/topup-pending — semua topup pending (cross-reseller)
router.get('/admin/topup-pending', authMiddleware, async (req, res, next) => {
    try {
        const rows = await query(`
            SELECT rt.*, r.nama AS nama_reseller, r.no_hp
            FROM reseller_topup rt
            JOIN reseller r ON rt.reseller_id = r.id
            WHERE rt.status = 'pending'
            ORDER BY rt.created_at DESC
        `);
        res.json(rows);
    } catch (e) { next(e); }
});

// GET /reseller/admin/topup-sukses — topup yang sudah lunas (cross-reseller)
router.get('/admin/topup-sukses', authMiddleware, async (req, res, next) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
        const rows = await query(`
            SELECT rt.*, r.nama AS nama_reseller, r.no_hp
            FROM reseller_topup rt
            JOIN reseller r ON rt.reseller_id = r.id
            WHERE rt.status = 'paid'
            ORDER BY COALESCE(rt.paid_at, rt.created_at) DESC
            LIMIT ?
        `, [limit]);
        res.json(rows);
    } catch (e) { next(e); }
});

// GET /reseller/admin/list
router.get('/admin/list', authMiddleware, async (req, res, next) => {
    try {
        const rows = await query(`
            SELECT r.*,
                (SELECT COUNT(*) FROM reseller_transaksi WHERE reseller_id=r.id) AS total_transaksi,
                (SELECT SUM(total_bayar) FROM reseller_transaksi WHERE reseller_id=r.id) AS total_omset,
                (SELECT SUM(jumlah) FROM reseller_topup WHERE reseller_id=r.id AND status='paid') AS total_topup
            FROM reseller r ORDER BY r.created_at DESC
        `);
        res.json(rows);
    } catch (e) { next(e); }
});

// POST /reseller/admin/approve/:id
router.post('/admin/approve/:id', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        await query("UPDATE reseller SET status='aktif' WHERE id=?", [req.params.id]);
        const r = await queryOne('SELECT nama, no_hp FROM reseller WHERE id=?', [req.params.id]);
        // Kirim WA notifikasi
        await waService.kirimPesan(r.no_hp,
            `Halo *${r.nama}*, akun reseller Anda telah *disetujui* ✅\nSilakan login dan topup saldo untuk mulai berjualan.`,
            null, 'manual');
        res.json({ pesan: 'Reseller disetujui' });
    } catch (e) { next(e); }
});

// PUT /reseller/admin/:id
router.put('/admin/:id', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        const { level, status, saldo_tambah, saldo_set, keterangan_koreksi,
                nama, username, no_hp, password } = req.body;

        // Ubah identitas akun (nama/username/no_hp/password) bila dikirim admin
        {
            const sets = [], vals = [];
            if (nama !== undefined) {
                const n = String(nama).replace(/[<>]/g, '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 150);
                if (!n) return res.status(400).json({ error: 'Nama tidak boleh kosong' });
                sets.push('nama=?'); vals.push(n);
            }
            if (username !== undefined) {
                const u = String(username).trim();
                if (!/^[A-Za-z0-9._-]{3,32}$/.test(u))
                    return res.status(400).json({ error: 'Username 3-32 karakter (huruf/angka . _ -)' });
                const bentrok = await queryOne('SELECT id FROM reseller WHERE username=? AND id<>?', [u, req.params.id]);
                if (bentrok) return res.status(400).json({ error: 'Username sudah dipakai reseller lain' });
                sets.push('username=?'); vals.push(u);
            }
            if (no_hp !== undefined) {
                const h = String(no_hp).trim();
                if (!/^[0-9+]{8,16}$/.test(h)) return res.status(400).json({ error: 'Nomor HP tidak valid' });
                sets.push('no_hp=?'); vals.push(h);
            }
            if (password !== undefined && password !== '') {
                if (String(password).length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });
                sets.push('password=?'); vals.push(await bcrypt.hash(String(password), 10));
            }
            if (sets.length) {
                vals.push(req.params.id);
                await query(`UPDATE reseller SET ${sets.join(', ')} WHERE id=?`, vals);
            }
        }

        if (level !== undefined || status !== undefined) {
            await query(`
                UPDATE reseller SET
                    level         = COALESCE(?, level),
                    status        = COALESCE(?, status)
                WHERE id=?
            `, [level ?? null, status ?? null, req.params.id]);
        }

        // Koreksi saldo: SET nilai pasti (prioritas) ATAU tambah/kurang delta.
        if (saldo_set !== undefined && saldo_set !== null && saldo_set !== '') {
            const target = parseFloat(saldo_set);
            if (isNaN(target) || target < 0)
                return res.status(400).json({ error: 'Nilai saldo tidak valid' });
            await withTransaction(async (db) => {
                const r = await db.queryOne('SELECT saldo FROM reseller WHERE id=? FOR UPDATE', [req.params.id]);
                if (!r) throw new Error('Reseller tidak ditemukan');
                const sekarang = parseFloat(r.saldo) || 0;
                const selisih  = target - sekarang;
                if (selisih === 0) return; // tidak ada perubahan
                const tipe = selisih > 0 ? 'bonus' : 'koreksi';
                await catatMutasi(db, req.params.id, tipe, Math.abs(selisih),
                    keterangan_koreksi || `Set saldo ke Rp ${target.toLocaleString('id-ID')} oleh admin`);
            });
        } else if (saldo_tambah && parseFloat(saldo_tambah) !== 0) {
            const delta = parseFloat(saldo_tambah);
            const tipe = delta > 0 ? 'bonus' : 'koreksi';
            await withTransaction(db =>
                catatMutasi(db, req.params.id, tipe, Math.abs(delta),
                    keterangan_koreksi || `Koreksi saldo oleh admin`)
            );
        }

        res.json({ pesan: 'Data reseller diperbarui' });
    } catch (e) { next(e); }
});

// POST /reseller/admin/topup-konfirmasi/:order_id (konfirmasi topup manual)
router.post('/admin/topup-konfirmasi/:order_id', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        const hasil = await withTransaction(async (db) => {
            // Lock baris topup agar tidak diproses dua kali bersamaan
            const t = await db.queryOne(
                "SELECT * FROM reseller_topup WHERE order_id=? FOR UPDATE",
                [req.params.order_id]
            );
            if (!t) throw new Error('TOPUP_NOT_FOUND');
            if (t.status !== 'pending') throw new Error('TOPUP_ALREADY_PROCESSED');

            await db.query(
                "UPDATE reseller_topup SET status='paid', paid_at=NOW() WHERE order_id=?",
                [req.params.order_id]
            );

            const saldo_baru = await catatMutasi(db, t.reseller_id, 'topup', t.jumlah,
                `Topup saldo via ${t.payment_method || 'manual'}`, t.order_id);

            return { reseller_id: t.reseller_id, jumlah: t.jumlah, saldo_baru };
        });

        const re = await queryOne('SELECT nama, no_hp FROM reseller WHERE id=?', [hasil.reseller_id]);
        waService.kirimPesan(re.no_hp,
            `Halo *${re.nama}*, topup saldo *Rp ${Number(hasil.jumlah).toLocaleString('id-ID')}* berhasil ✅\nSaldo sekarang: *Rp ${Number(hasil.saldo_baru).toLocaleString('id-ID')}*`,
            null, 'konfirmasi_bayar'
        ).catch(err => console.warn('[RESELLER] Kirim WA konfirmasi topup gagal:', err.message));

        res.json({ pesan: 'Topup dikonfirmasi', saldo_baru: hasil.saldo_baru });
    } catch (e) {
        if (e.message === 'TOPUP_NOT_FOUND')
            return res.status(404).json({ error: 'Topup tidak ditemukan' });
        if (e.message === 'TOPUP_ALREADY_PROCESSED')
            return res.status(400).json({ error: 'Topup sudah diproses sebelumnya' });
        next(e);
    }
});

// GET /reseller/admin/mutasi/:id
router.get('/admin/mutasi/:id', authMiddleware, async (req, res, next) => {
    try {
        const rows = await query(`
            SELECT * FROM reseller_mutasi WHERE reseller_id=?
            ORDER BY created_at DESC LIMIT 50
        `, [req.params.id]);
        res.json(rows);
    } catch (e) { next(e); }
});

// ── WEBHOOK TOPUP (dipanggil dari webhook.js) ─────────────────
// Idempotent: jika payment gateway mengirim webhook duplikat untuk order_id
// yang sama, panggilan kedua tidak akan memproses ulang karena status
// sudah bukan 'pending' lagi (dicek di dalam lock transaksi).
async function prosesTopupWebhook(order_id, payment_type) {
    let hasil;
    try {
        hasil = await withTransaction(async (db) => {
            const t = await db.queryOne(
                "SELECT * FROM reseller_topup WHERE order_id=? FOR UPDATE", [order_id]
            );
            if (!t) return null;
            if (t.status !== 'pending') return null; // sudah diproses, abaikan webhook duplikat

            await db.query(
                "UPDATE reseller_topup SET status='paid', paid_at=NOW(), payment_method=? WHERE order_id=?",
                [payment_type, order_id]
            );

            const saldo_baru = await catatMutasi(db, t.reseller_id, 'topup', t.jumlah,
                `Topup saldo via ${payment_type}`, order_id, payment_type);

            return { reseller_id: t.reseller_id, jumlah: t.jumlah, saldo_baru };
        });
    } catch (err) {
        console.error(`[RESELLER] Gagal proses webhook topup ${order_id}:`, err.message);
        return false;
    }

    if (!hasil) return false;

    const re = await queryOne('SELECT nama, no_hp FROM reseller WHERE id=?', [hasil.reseller_id]);
    if (re) {
        waService.kirimPesan(re.no_hp,
            `Halo *${re.nama}*, topup saldo *Rp ${Number(hasil.jumlah).toLocaleString('id-ID')}* berhasil ✅\nSaldo sekarang: *Rp ${Number(hasil.saldo_baru).toLocaleString('id-ID')}*`,
            null, 'konfirmasi_bayar'
        ).catch(err => console.warn('[RESELLER] Kirim WA topup webhook gagal:', err.message));
    }

    return true;
}

// DELETE /reseller/admin/topup/:order_id — hapus topup pending
router.delete('/admin/topup/:order_id', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        const t = await queryOne(
            'SELECT * FROM reseller_topup WHERE order_id=?',
            [req.params.order_id]
        );
        if (!t) return res.status(404).json({ error: 'Topup tidak ditemukan' });
        if (t.status !== 'pending')
            return res.status(400).json({ error: 'Hanya topup berstatus pending yang bisa dihapus' });

        await query('DELETE FROM reseller_topup WHERE order_id=?', [req.params.order_id]);
        res.json({ pesan: 'Topup pending berhasil dihapus' });
    } catch (e) { next(e); }
});

// ── GET /api/reseller/admin/:id/izin-paket ───────────────────
router.get('/admin/:id/izin-paket', authMiddleware, async (req, res, next) => {
    try {
        // Auto-create tabel jika belum ada
        await query(`CREATE TABLE IF NOT EXISTS reseller_izin_paket (
            id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            reseller_id INT UNSIGNED NOT NULL,
            paket_id    INT UNSIGNED NOT NULL,
            UNIQUE KEY (reseller_id, paket_id),
            FOREIGN KEY (reseller_id) REFERENCES reseller(id) ON DELETE CASCADE,
            FOREIGN KEY (paket_id)    REFERENCES paket(id)    ON DELETE CASCADE
        ) ENGINE=InnoDB`).catch(()=>{});

        const rows = await query(
            `SELECT paket_id FROM reseller_izin_paket WHERE reseller_id = ?`, [req.params.id]
        );
        res.json(rows.map(r => r.paket_id));
    } catch(e) { next(e); }
});

// ── PUT /api/reseller/admin/:id/izin-paket ───────────────────
router.put('/admin/:id/izin-paket', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        await query(`CREATE TABLE IF NOT EXISTS reseller_izin_paket (
            id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            reseller_id INT UNSIGNED NOT NULL,
            paket_id    INT UNSIGNED NOT NULL,
            UNIQUE KEY (reseller_id, paket_id),
            FOREIGN KEY (reseller_id) REFERENCES reseller(id) ON DELETE CASCADE,
            FOREIGN KEY (paket_id)    REFERENCES paket(id)    ON DELETE CASCADE
        ) ENGINE=InnoDB`).catch(()=>{});

        const { paket_ids = [] } = req.body;
        const rid = parseInt(req.params.id);
        // Hapus semua izin lama lalu insert baru
        await query(`DELETE FROM reseller_izin_paket WHERE reseller_id = ?`, [rid]);
        const ids = (paket_ids || []).map(p => parseInt(p)).filter(n => Number.isInteger(n));
        if (ids.length) {
            // Bangun placeholder eksplisit: (?,?),(?,?),...
            const placeholders = ids.map(() => '(?, ?)').join(', ');
            const params = [];
            ids.forEach(pid => { params.push(rid, pid); });
            await query(
                `INSERT INTO reseller_izin_paket (reseller_id, paket_id) VALUES ${placeholders}`,
                params
            );
        }
        res.json({ pesan: `${ids.length} paket diizinkan` });
    } catch(e) { next(e); }
});

// ============================================================
// RIWAYAT BATCH GENERATE (voucher yang dibeli reseller)
// batch_id berformat RSL-<resellerId>-<ts>. Semua endpoint di-scope ke
// reseller pemilik (cek prefix RSL-<id>-).
// ============================================================

// POST /reseller/generate-voucher — generate voucher massal dengan opsi
// (mode/panjang/prefix/charset) + potong saldo (harga reseller × jumlah).
router.post('/generate-voucher', resellerAuth, async (req, res, next) => {
    try {
        const paket_id = req.body.paket_id;
        const jumlah   = parseInt(req.body.jumlah, 10) || 1;
        const mode     = req.body.mode === 'beda' ? 'beda' : 'sama';
        const panjang  = Math.min(Math.max(parseInt(req.body.panjang, 10) || 8, 4), 20);
        const prefix   = (req.body.prefix || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
        const charsetKey = req.body.charset || 'angka';

        if (!paket_id) return res.status(400).json({ error: 'Paket wajib dipilih' });
        if (jumlah < 1 || jumlah > 100)
            return res.status(400).json({ error: 'Jumlah 1–100 voucher per transaksi' });

        const CHARSETS = {
            angka:       '0123456789',
            angka_kecil: '0123456789abcdefghijklmnopqrstuvwxyz',
            angka_besar: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
        };
        const charset = CHARSETS[charsetKey];
        if (!charset) return res.status(400).json({ error: 'Jenis karakter tidak valid' });
        const panjangAcak = Math.max(panjang - prefix.length, 4);
        const _acak = (cs, n) => Array.from({ length: n }, () => cs[require('crypto').randomInt(cs.length)]).join('');

        const paket = await queryOne('SELECT * FROM paket WHERE id=? AND aktif=1', [paket_id]);
        if (!paket) return res.status(404).json({ error: 'Paket tidak ditemukan' });

        // Validasi izin paket reseller
        try {
            const izin = await query(`SELECT 1 FROM reseller_izin_paket WHERE reseller_id=?`, [req.reseller.id]);
            if (izin.length) {
                const boleh = await queryOne(`SELECT 1 FROM reseller_izin_paket WHERE reseller_id=? AND paket_id=?`, [req.reseller.id, paket_id]);
                if (!boleh) return res.status(403).json({ error: 'Paket ini tidak diizinkan untuk akun Anda' });
            }
        } catch (_) {}

        const hasil = await withTransaction(async (db) => {
            const hargaReseller = await hitungHarga(req.reseller.id, paket_id, paket.harga, db);
            const totalBayar    = hargaReseller * jumlah;

            // Potong saldo (kunci baris + cek cukup). Throw bila tidak cukup → rollback.
            const refId = `TRX-${Date.now()}`;
            const saldoSisa = await catatMutasi(db, req.reseller.id, 'pembelian', totalBayar,
                `Generate ${jumlah}x voucher ${paket.nama}`, refId);

            const batchId = `RSL-${req.reseller.id}-${Date.now().toString(36).toUpperCase()}`;
            const kodes = [];
            for (let i = 0; i < jumlah; i++) {
                // Buat username unik (cegah tabrakan dengan beberapa percobaan)
                let username, ada = true, coba = 0;
                while (ada && coba < 20) {
                    username = prefix + _acak(charset, panjangAcak);
                    ada = await db.queryOne('SELECT id FROM voucher WHERE username=?', [username]);
                    coba++;
                }
                if (ada) throw new Error('Gagal membuat kode unik, perbesar panjang kode atau kurangi jumlah');
                const password = mode === 'sama' ? username : _acak(charset, panjangAcak);
                await db.query(`
                    INSERT INTO voucher (username, password, paket_id, status, tgl_expired, batch_id)
                    VALUES (?,?,?,'unused', NULL, ?)
                `, [username, password, paket_id, batchId]);
                kodes.push({ username, password });
            }

            await db.query(`
                INSERT INTO reseller_transaksi
                  (reseller_id, tipe, paket_id, jumlah_item, harga_normal, harga_reseller, total_bayar, detail)
                VALUES (?,?,?,?,?,?,?,?)
            `, [req.reseller.id, 'voucher', paket_id, jumlah,
                paket.harga, hargaReseller, totalBayar,
                JSON.stringify({ voucher: kodes.map(k => k.username), batch_id: batchId })]);

            return { kodes, hargaReseller, totalBayar, saldoSisa, batch_id: batchId };
        });

        // Daftarkan ke radcheck setelah commit
        for (const k of hasil.kodes) {
            radiusService.syncVoucher(k.username).catch(err =>
                console.warn(`[RESELLER] Sync radcheck ${k.username} gagal:`, err.message));
        }

        res.json({
            pesan: `${hasil.kodes.length} voucher dibuat`,
            voucher: hasil.kodes,
            batch_id: hasil.batch_id,
            paket: paket.nama,
            total: hasil.totalBayar,
            saldo_sisa: hasil.saldoSisa
        });
    } catch (e) {
        if (/saldo tidak mencukupi/i.test(e.message)) return res.status(400).json({ error: 'Saldo tidak mencukupi' });
        next(e);
    }
});

// GET /reseller/voucher — daftar voucher milik reseller (paginated + cari)
router.get('/voucher', resellerAuth, async (req, res, next) => {
    try {
        const per  = Math.min(Math.max(parseInt(req.query.per, 10) || 25, 1), 200);
        const hal  = Math.max(parseInt(req.query.hal, 10) || 1, 1);
        const off  = (hal - 1) * per;
        const like = `RSL-${req.reseller.id}-%`;
        const q    = (req.query.q || '').trim();
        const status = req.query.status || '';

        const where = ['v.batch_id LIKE ?'];
        const params = [like];
        if (q) { where.push('(v.username LIKE ? OR v.password LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
        if (['unused','used','expired'].includes(status)) { where.push('v.status = ?'); params.push(status); }
        const whereStr = where.join(' AND ');

        const totalRow = await queryOne(`SELECT COUNT(*) AS total FROM voucher v WHERE ${whereStr}`, params);
        const total = totalRow?.total || 0;

        const rows = await query(`
            SELECT v.username, v.password, v.status, v.tgl_digunakan, v.created_at,
                   p.nama AS nama_paket
            FROM voucher v LEFT JOIN paket p ON v.paket_id = p.id
            WHERE ${whereStr}
            ORDER BY v.id DESC
            LIMIT ? OFFSET ?
        `, [...params, per, off]);

        res.json({ data: rows, total, hal, per });
    } catch (e) { next(e); }
});

// GET /reseller/batch — daftar batch voucher milik reseller (paginated)
router.get('/batch', resellerAuth, async (req, res, next) => {
    try {
        const per  = Math.min(Math.max(parseInt(req.query.per, 10) || 10, 1), 50);
        const hal  = Math.max(parseInt(req.query.hal, 10) || 1, 1);
        const off  = (hal - 1) * per;
        const like = `RSL-${req.reseller.id}-%`;

        const totalRow = await queryOne(`
            SELECT COUNT(*) AS total FROM (
                SELECT v.batch_id FROM voucher v
                WHERE v.batch_id LIKE ? GROUP BY v.batch_id
            ) t
        `, [like]);
        const total = totalRow?.total || 0;

        const rows = await query(`
            SELECT v.batch_id,
                   COUNT(*) AS jumlah,
                   SUM(CASE WHEN v.status='used' THEN 1 ELSE 0 END) AS terpakai,
                   MIN(v.created_at) AS created_at,
                   MIN(v.username) AS u_min,
                   MAX(v.username) AS u_max,
                   p.nama AS nama_paket
            FROM voucher v
            JOIN paket p ON v.paket_id = p.id
            WHERE v.batch_id LIKE ?
            GROUP BY v.batch_id, p.nama
            ORDER BY MIN(v.created_at) DESC
            LIMIT ? OFFSET ?
        `, [like, per, off]);

        res.json({ data: rows, total, hal, per });
    } catch (e) { next(e); }
});

// GET /reseller/batch/:batchId/data — voucher + template (untuk Print client-side)
router.get('/batch/:batchId/data', resellerAuth, async (req, res, next) => {
    try {
        if (!_batchMilikReseller(req.params.batchId, req.reseller.id))
            return res.status(403).json({ error: 'Batch ini bukan milik Anda' });
        const vouchers = await query(`
            SELECT v.username, v.password, v.status,
                   p.nama AS nama_paket, p.masa_aktif, p.satuan_masa, p.harga
            FROM voucher v LEFT JOIN paket p ON v.paket_id = p.id
            WHERE v.batch_id = ? ORDER BY v.id
        `, [req.params.batchId]);
        if (!vouchers.length) return res.status(404).json({ error: 'Batch tidak ditemukan' });
        const template = await queryOne(`SELECT * FROM voucher_template WHERE is_default=1 LIMIT 1`)
                      || await queryOne(`SELECT * FROM voucher_template ORDER BY id LIMIT 1`);
        res.json({ vouchers, template: template || null });
    } catch (e) { next(e); }
});

// GET /reseller/batch/:batchId/export-xlsx — unduh daftar voucher (Excel)
router.get('/batch/:batchId/export-xlsx', resellerAuth, async (req, res, next) => {
    try {
        if (!_batchMilikReseller(req.params.batchId, req.reseller.id))
            return res.status(403).json({ error: 'Batch ini bukan milik Anda' });
        const ExcelJS = require('exceljs');
        const rows = await query(`
            SELECT v.*, p.nama AS nama_paket, p.harga
            FROM voucher v LEFT JOIN paket p ON v.paket_id = p.id
            WHERE v.batch_id = ? ORDER BY v.id
        `, [req.params.batchId]);
        if (!rows.length) return res.status(404).json({ error: 'Batch tidak ditemukan' });

        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Voucher');
        ws.columns = [
            { header: 'No', key: 'no', width: 6 },
            { header: 'Username', key: 'username', width: 18 },
            { header: 'Password', key: 'password', width: 18 },
            { header: 'Paket', key: 'paket', width: 24 },
            { header: 'Status', key: 'status', width: 12 },
            { header: 'Dibuat', key: 'dibuat', width: 20 },
        ];
        ws.getRow(1).font = { bold: true };
        rows.forEach((v, i) => ws.addRow({
            no: i + 1, username: sf(v.username), password: sf(v.password),
            paket: sf(v.nama_paket || '-'), status: sf(v.status),
            dibuat: v.created_at ? new Date(v.created_at).toLocaleString('id-ID') : ''
        }));
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.batchId}.xlsx"`);
        await wb.xlsx.write(res);
        res.end();
    } catch (e) { next(e); }
});

// GET /reseller/batch/:batchId/export-pdf — unduh kartu voucher (PDF template)
router.get('/batch/:batchId/export-pdf', resellerAuth, async (req, res, next) => {
    try {
        if (!_batchMilikReseller(req.params.batchId, req.reseller.id))
            return res.status(403).json({ error: 'Batch ini bukan milik Anda' });
        const { renderHtmlToPdf } = require('../services/invoice-pdf');
        const rows = await query(`
            SELECT v.*, p.nama AS nama_paket, p.masa_aktif, p.satuan_masa, p.harga
            FROM voucher v LEFT JOIN paket p ON v.paket_id = p.id
            WHERE v.batch_id = ? ORDER BY v.id
        `, [req.params.batchId]);
        if (!rows.length) return res.status(404).json({ error: 'Batch tidak ditemukan' });

        const tpl = await queryOne(`SELECT * FROM voucher_template WHERE is_default=1 LIMIT 1`)
                 || await queryOne(`SELECT * FROM voucher_template ORDER BY id LIMIT 1`);
        if (!tpl) return res.status(400).json({ error: 'Template voucher belum dikonfigurasi' });

        const isi = (s, v, i) => (s || '')
            .replace(/%username%/g, v.username || '')
            .replace(/%password%/g, v.password || v.username || '')
            .replace(/%profile%/g,  v.nama_paket || '—')
            .replace(/%validity%/g, v.masa_aktif
                ? `${v.masa_aktif} ${v.satuan_masa === 'jam' ? 'Jam' : v.satuan_masa === 'bulan' ? 'Bulan' : 'Hari'}` : '—')
            .replace(/%price%/g,    v.harga ? 'Rp ' + Number(v.harga).toLocaleString('id-ID') : '—')
            .replace(/%no_urut%/g,  String(i + 1).padStart(3, '0'));

        const body   = rows.map((v, i) => isi(tpl.row_html, v, i)).join('');
        const header = (tpl.header_html || '').replace(/<script[^>]*\ssrc=[^>]*>\s*<\/script>/gi, '');
        const html   = header + body + (tpl.footer_html || '');

        const pdf = await renderHtmlToPdf(html, { margin: { top: '8mm', right: '8mm', bottom: '8mm', left: '8mm' } });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.batchId}.pdf"`);
        res.end(pdf);
    } catch (e) { next(e); }
});

module.exports = { router, prosesTopupWebhook };
