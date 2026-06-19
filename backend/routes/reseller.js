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

// ── Helper hitung harga reseller (terima db handle opsional untuk dipakai dalam transaksi) ──
async function hitungHarga(resellerId, paketId, hargaNormal, db = { query, queryOne }) {
    // Cek harga khusus dulu
    const khusus = await db.queryOne(
        'SELECT harga_reseller FROM reseller_harga WHERE reseller_id=? AND paket_id=?',
        [resellerId, paketId]
    );
    if (khusus) return parseFloat(khusus.harga_reseller);

    // Pakai komisi persen dari profil reseller
    const r = await db.queryOne('SELECT komisi_persen FROM reseller WHERE id=?', [resellerId]);
    const diskon = parseFloat(r?.komisi_persen || 0);
    return Math.round(hargaNormal * (1 - diskon / 100));
}

// ── Helper catat mutasi saldo. WAJIB dipanggil dengan db handle dari withTransaction
//    saat melibatkan pengurangan saldo akibat pembelian, agar FOR UPDATE + rollback bekerja. ──
async function catatMutasi(db, resellerId, tipe, jumlah, keterangan, refId = null, method = null) {
    const r = await db.queryOne('SELECT saldo FROM reseller WHERE id=? FOR UPDATE', [resellerId]);
    if (!r) throw new Error('Reseller tidak ditemukan');

    const sebelum = parseFloat(r.saldo);
    const mengurangi = tipe === 'pembelian' || tipe === 'koreksi';
    const sesudah = mengurangi ? sebelum - jumlah : sebelum + jumlah;

    if (mengurangi && sesudah < 0)
        throw new Error('Saldo tidak mencukupi');

    await db.query('UPDATE reseller SET saldo=? WHERE id=?', [sesudah, resellerId]);
    await db.query(`
        INSERT INTO reseller_mutasi
          (reseller_id, tipe, jumlah, saldo_sebelum, saldo_sesudah, keterangan, ref_id, payment_method)
        VALUES (?,?,?,?,?,?,?,?)
    `, [resellerId, tipe, jumlah, sebelum, sesudah, keterangan, refId, method]);

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
        const { nama, username, password, no_hp, email } = req.body;
        if (!nama || !username || !password || !no_hp)
            return res.status(400).json({ error: 'Semua field wajib diisi' });

        const ada = await queryOne('SELECT id FROM reseller WHERE username=?', [username]);
        if (ada) return res.status(400).json({ error: 'Username sudah digunakan' });

        const hash = await bcrypt.hash(password, 12);
        const token_api = require('crypto').randomBytes(32).toString('hex');

        await query(`
            INSERT INTO reseller (nama, username, password, no_hp, email, token_api, status)
            VALUES (?,?,?,?,?,?,'nonaktif')
        `, [nama, username, hash, no_hp, email || null, token_api]);

        res.status(201).json({
            pesan: 'Registrasi berhasil, menunggu persetujuan admin',
        });
    } catch (e) { next(e); }
});

// GET /reseller/profil
router.get('/profil', resellerAuth, async (req, res, next) => {
    try {
        const r = await queryOne(
            'SELECT id,nama,username,no_hp,email,saldo,komisi_persen,level,status,created_at FROM reseller WHERE id=?',
            [req.reseller.id]
        );
        res.json(r);
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

// POST /reseller/topup — buat request topup saldo
router.post('/topup', resellerAuth, async (req, res, next) => {
    try {
        const { jumlah, metode = 'qris' } = req.body;
        if (!jumlah || jumlah < 10000)
            return res.status(400).json({ error: 'Minimum topup Rp 10.000' });
        if (jumlah > 50000000)
            return res.status(400).json({ error: 'Maksimum topup Rp 50.000.000' });

        const r        = await queryOne('SELECT * FROM reseller WHERE id=?', [req.reseller.id]);
        const order_id = `TOP-${req.reseller.id}-${Date.now()}`;

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

        await query(`
            INSERT INTO reseller_topup (reseller_id, order_id, jumlah, payment_url, status)
            VALUES (?,?,?,?,'pending')
        `, [req.reseller.id, order_id, jumlah, pg?.payment_url || null]);

        res.json({
            order_id,
            jumlah,
            payment_url: pg?.payment_url || null,
            pesan: pg?.payment_url
                ? 'Silakan selesaikan pembayaran'
                : 'Request topup diterima, hubungi admin untuk konfirmasi'
        });
    } catch (e) { next(e); }
});

// GET /reseller/topup — riwayat topup
router.get('/topup', resellerAuth, async (req, res, next) => {
    try {
        const rows = await query(`
            SELECT * FROM reseller_topup WHERE reseller_id=?
            ORDER BY created_at DESC LIMIT 30
        `, [req.reseller.id]);
        res.json(rows);
    } catch (e) { next(e); }
});

// ============================================================
// PAKET (harga reseller)
// ============================================================

// GET /reseller/paket
router.get('/paket', resellerAuth, async (req, res, next) => {
    try {
        const paket = await query(`
            SELECT p.*,
                COALESCE(rh.harga_reseller,
                    ROUND(p.harga * (1 - r.komisi_persen/100))
                ) AS harga_reseller
            FROM paket p
            CROSS JOIN reseller r
            LEFT JOIN reseller_harga rh ON rh.paket_id=p.id AND rh.reseller_id=r.id
            WHERE p.aktif=1 AND r.id=?
            ORDER BY p.harga
        `, [req.reseller.id]);
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

        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const genKode = () => {
            const b = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
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

            const kodes = [];
            for (let i = 0; i < jumlah; i++) {
                const kode = genKode();
                await db.query(`
                    INSERT INTO voucher (kode, paket_id, status, tgl_expired)
                    VALUES (?,?,'unused', DATE_ADD(NOW(), INTERVAL 365 DAY))
                `, [kode, paket_id]);
                kodes.push(kode);
            }

            await db.query(`
                INSERT INTO reseller_transaksi
                  (reseller_id, tipe, paket_id, jumlah_item, harga_normal, harga_reseller, total_bayar, detail)
                VALUES (?,?,?,?,?,?,?,?)
            `, [req.reseller.id, 'voucher', paket_id, jumlah,
                paket.harga, hargaReseller, totalBayar, JSON.stringify({ voucher: kodes })]);

            return { kodes, hargaReseller, totalBayar, saldoSisa };
        });

        // Kirim via WA jika hanya 1 voucher (di luar transaksi — gagal kirim WA tidak boleh rollback pembelian)
        if (jumlah === 1) {
            const re = await queryOne('SELECT no_hp, nama FROM reseller WHERE id=?', [req.reseller.id]);
            waService.kirimVoucher(re.no_hp, re.nama, hasil.kodes[0], `${paket.masa_aktif * 24} jam`)
                .catch(err => console.warn('[RESELLER] Kirim WA voucher gagal:', err.message));
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
                  (nama, username, password, no_hp, paket_id, tipe_koneksi,
                   tgl_aktif, tgl_expired, status, notes)
                VALUES (?,?,?,?,?,?,?,?,'aktif',?)
            `, [
                nama_pelanggan || username, username, hash,
                no_hp_pelanggan || re.no_hp,
                paket_id, tipe_koneksi, tgl_aktif, tgl_expired,
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
// RIWAYAT TRANSAKSI RESELLER
// ============================================================

// GET /reseller/transaksi
router.get('/transaksi', resellerAuth, async (req, res, next) => {
    try {
        const { halaman = 1, limit = 20 } = req.query;
        const offset = (parseInt(halaman) - 1) * parseInt(limit);
        const rows = await query(`
            SELECT rt.*, p.nama AS nama_paket
            FROM reseller_transaksi rt
            JOIN paket p ON rt.paket_id = p.id
            WHERE rt.reseller_id=?
            ORDER BY rt.created_at DESC LIMIT ? OFFSET ?
        `, [req.reseller.id, parseInt(limit), offset]);
        const [{ total }] = await query(
            'SELECT COUNT(*) AS total FROM reseller_transaksi WHERE reseller_id=?',
            [req.reseller.id]
        );
        res.json({ data: rows, total });
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
router.post('/admin/approve/:id', authMiddleware, async (req, res, next) => {
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
router.put('/admin/:id', authMiddleware, async (req, res, next) => {
    try {
        const { komisi_persen, level, status, saldo_tambah, keterangan_koreksi } = req.body;

        if (komisi_persen !== undefined || level !== undefined || status !== undefined) {
            await query(`
                UPDATE reseller SET
                    komisi_persen = COALESCE(?, komisi_persen),
                    level         = COALESCE(?, level),
                    status        = COALESCE(?, status)
                WHERE id=?
            `, [komisi_persen ?? null, level ?? null, status ?? null, req.params.id]);
        }

        // Koreksi saldo manual
        if (saldo_tambah && saldo_tambah !== 0) {
            const tipe = saldo_tambah > 0 ? 'bonus' : 'koreksi';
            await withTransaction(db =>
                catatMutasi(db, req.params.id, tipe, Math.abs(saldo_tambah),
                    keterangan_koreksi || `Koreksi saldo oleh admin`)
            );
        }

        res.json({ pesan: 'Data reseller diperbarui' });
    } catch (e) { next(e); }
});

// POST /reseller/admin/topup-konfirmasi/:order_id (konfirmasi topup manual)
router.post('/admin/topup-konfirmasi/:order_id', authMiddleware, async (req, res, next) => {
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
router.delete('/admin/topup/:order_id', authMiddleware, async (req, res, next) => {
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
router.put('/admin/:id/izin-paket', authMiddleware, async (req, res, next) => {
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
        if (paket_ids.length) {
            const vals = paket_ids.map(pid => [rid, parseInt(pid)]);
            await query(`INSERT INTO reseller_izin_paket (reseller_id, paket_id) VALUES ?`, [vals]);
        }
        res.json({ pesan: `${paket_ids.length} paket diizinkan` });
    } catch(e) { next(e); }
});

module.exports = { router, prosesTopupWebhook };
