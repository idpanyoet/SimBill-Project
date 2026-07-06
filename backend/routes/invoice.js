// routes/invoice.js — Manajemen invoice & tagihan
const router = require('express').Router();
const { query, queryOne, withTransaction, generateUniqueInvoiceNo, hitungExpired, hitungExpiredDari } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const paymentService  = require('../services/payment');
const waService       = require('../services/whatsapp');
const dayjs = require('dayjs');

router.use(authMiddleware);

const INVOICE_PREFIX = process.env.INVOICE_PREFIX || 'INV';

// GET /api/invoice
router.get('/', async (req, res, next) => {
    try {
        const { status, pelanggan_id, dari, sampai, tipe_koneksi, q, halaman = 1, limit = 20 } = req.query;
        const offset = (parseInt(halaman) - 1) * parseInt(limit);

        let where = ['1=1'];
        let params = [];

        if (status)       { where.push('i.status = ?'); params.push(status); }
        else              { where.push("i.status <> 'cancelled'"); } // default: sembunyikan yang dibatalkan
        if (pelanggan_id) { where.push('i.pelanggan_id = ?'); params.push(pelanggan_id); }
        if (dari)         { where.push('i.tgl_invoice >= ?'); params.push(dari); }
        if (sampai)       { where.push('i.tgl_invoice <= ?'); params.push(sampai); }

        // Pencarian teks: no_invoice / nama pelanggan / no_hp (server-side, parameterized).
        if (q && String(q).trim()) {
            const like = '%' + String(q).trim() + '%';
            where.push('(i.no_invoice LIKE ? OR p.nama LIKE ? OR p.no_hp LIKE ?)');
            params.push(like, like, like);
        }

        // Filter tab: pppoe, hotspot, atau voucher (pelanggan_id IS NULL)
        if (tipe_koneksi === 'voucher') {
            where.push('i.pelanggan_id IS NULL');
        } else if (tipe_koneksi === 'pppoe') {
            where.push('i.pelanggan_id IS NOT NULL');
            where.push("(pk.tipe = 'pppoe' OR pk.tipe = 'keduanya')");
        } else if (tipe_koneksi === 'hotspot') {
            where.push('i.pelanggan_id IS NOT NULL');
            where.push("(pk.tipe = 'hotspot' OR pk.tipe = 'keduanya')");
        }

        const rows = await query(`
            SELECT i.*,
                COALESCE(p.nama, 'Pembeli Voucher') AS nama_pelanggan,
                p.no_hp, p.tipe_koneksi, pk.nama AS nama_paket, pk.tipe AS paket_tipe
            FROM invoice i
            LEFT JOIN pelanggan p ON i.pelanggan_id = p.id
            JOIN paket pk ON i.paket_id = pk.id
            WHERE ${where.join(' AND ')}
            ORDER BY i.created_at DESC
            LIMIT ? OFFSET ?
        `, [...params, parseInt(limit), offset]);

        const [{ total }] = await query(
            `SELECT COUNT(*) AS total FROM invoice i
             LEFT JOIN pelanggan p ON i.pelanggan_id = p.id
             JOIN paket pk ON i.paket_id = pk.id
             WHERE ${where.join(' AND ')}`, params
        );

        res.json({ data: rows, total, halaman, limit });
    } catch (e) { next(e); }
});

// GET /api/invoice/statistik — hitung per status + pendapatan (hormati tab)
router.get('/statistik', async (req, res, next) => {
    try {
        const { tipe_koneksi } = req.query;
        let cond = ['1=1'];
        if (tipe_koneksi === 'voucher') {
            cond.push('i.pelanggan_id IS NULL');
        } else if (tipe_koneksi === 'pppoe') {
            cond.push('i.pelanggan_id IS NOT NULL');
            cond.push("(pk.tipe = 'pppoe' OR pk.tipe = 'keduanya')");
        } else if (tipe_koneksi === 'hotspot') {
            cond.push('i.pelanggan_id IS NOT NULL');
            cond.push("(pk.tipe = 'hotspot' OR pk.tipe = 'keduanya')");
        }
        const whereStr = cond.join(' AND ');
        const [r] = await query(`
            SELECT
              COUNT(*) AS total,
              SUM(i.status='paid')    AS paid,
              SUM(i.status='unpaid')  AS unpaid,
              SUM(i.status='overdue') AS overdue,
              SUM(CASE WHEN i.status='paid' THEN i.jumlah ELSE 0 END) AS pendapatan
            FROM invoice i
            LEFT JOIN pelanggan p ON i.pelanggan_id = p.id
            JOIN paket pk ON i.paket_id = pk.id
            WHERE ${whereStr}
        `);
        res.json({
            total: Number(r.total || 0),
            paid: Number(r.paid || 0),
            unpaid: Number(r.unpaid || 0),
            overdue: Number(r.overdue || 0),
            pendapatan: Number(r.pendapatan || 0)
        });
    } catch (e) { next(e); }
});

// GET /api/invoice/:id — detail invoice
router.get('/:id', async (req, res, next) => {
    try {
        const row = await queryOne(`
            SELECT i.*,
                COALESCE(p.nama, 'Pembeli Voucher') AS nama_pelanggan,
                p.no_hp, p.alamat, p.tipe_koneksi,
                p.tgl_expired AS pelanggan_expired, p.status AS pelanggan_status,
                pk.nama AS nama_paket, pk.tipe AS paket_tipe, pk.kecepatan_dn, pk.masa_aktif, pk.satuan_masa
            FROM invoice i
            LEFT JOIN pelanggan p ON i.pelanggan_id = p.id
            LEFT JOIN paket pk ON i.paket_id = pk.id
            WHERE i.id = ?
        `, [req.params.id]);
        if (!row) return res.status(404).json({ error: 'Invoice tidak ditemukan' });
        res.json(row);
    } catch(e) { next(e); }
});

// POST /api/invoice — buat invoice manual
router.post('/', async (req, res, next) => {
    try {
        const { pelanggan_id, jumlah, tgl_jatuh_tempo, keterangan, kirim_wa } = req.body;
        if (!pelanggan_id || !jumlah || !tgl_jatuh_tempo)
            return res.status(400).json({ error: 'pelanggan_id, jumlah, tgl_jatuh_tempo wajib diisi' });

        const p = await queryOne(`
            SELECT pl.*, pk.id AS paket_id, pk.nama AS nama_paket
            FROM pelanggan pl JOIN paket pk ON pl.paket_id = pk.id
            WHERE pl.id = ?
        `, [pelanggan_id]);
        if (!p) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });

        // Cegah invoice dobel: tolak bila pelanggan masih punya invoice belum lunas.
        // (Lunasi atau batalkan dulu invoice lama sebelum membuat yang baru.)
        const adaUnpaid = await queryOne(`
            SELECT no_invoice FROM invoice
            WHERE pelanggan_id = ? AND status IN ('unpaid','overdue')
            ORDER BY tgl_jatuh_tempo DESC LIMIT 1
        `, [pelanggan_id]);
        if (adaUnpaid) {
            return res.status(409).json({
                error: `Pelanggan masih punya invoice belum lunas (${adaUnpaid.no_invoice}). Lunasi atau batalkan dulu sebelum membuat invoice baru.`
            });
        }

        const tahun = dayjs().format('YYYY');

        // Insert invoice dulu (tanpa payment_url) dalam transaksi aman terhadap
        // race condition pada nomor invoice. Payment gateway dipanggil SETELAH
        // baris invoice tersimpan, supaya tidak ada payment link "yatim" jika
        // insert gagal karena konflik nomor.
        const { no_invoice, result } = await withTransaction(db =>
            generateUniqueInvoiceNo(db, INVOICE_PREFIX, tahun, (noInv) =>
                db.query(`
                    INSERT INTO invoice (no_invoice, pelanggan_id, paket_id, jumlah,
                        tgl_invoice, tgl_jatuh_tempo, keterangan)
                    VALUES (?,?,?,?,CURDATE(),?,?)
                `, [noInv, pelanggan_id, p.paket_id, jumlah, tgl_jatuh_tempo, keterangan || null])
            )
        );

        // Buat transaksi di payment gateway, lalu simpan link-nya ke invoice yang sudah ada
        const pg = await paymentService.buatTransaksi({
            order_id:    no_invoice,
            gross_amount: jumlah,
            pelanggan:   p
        }).catch(err => {
            console.warn(`[INVOICE] Payment gateway gagal untuk ${no_invoice}:`, err.message);
            return null;
        });

        if (pg?.payment_url) {
            await query(
                `UPDATE invoice SET payment_id=?, payment_url=? WHERE id=?`,
                [pg.order_id, pg.payment_url, result.insertId]
            );
        }

        // Kirim WA jika diminta — fire-and-forget: JANGAN di-await, karena
        // antrian WA punya delay anti-banned (wa_delay_min/max, bisa 30-60s).
        // Meng-await di sini membuat response invoice ikut tertahan = tombol
        // "Buat Invoice" stuck. Invoice sudah tersimpan; WA jalan di background.
        if (kirim_wa) {
            waService.kirimLinkBayar(p, {
                no_invoice,
                jumlah,
                tgl_jatuh_tempo,
                payment_url: pg?.payment_url
            }).catch(err => console.warn('[INVOICE] Kirim WA gagal:', err.message));
        }

        res.status(201).json({
            pesan:       'Invoice berhasil dibuat',
            id:          result.insertId,
            no_invoice,
            payment_url: pg?.payment_url || null
        });
    } catch (e) { next(e); }
});

// POST /api/invoice/generate-bulanan — generate tagihan untuk pelanggan yang
// mendekati tgl_expired (H-N), jatuh tempo = tgl_expired. Tombol manual ini
// melakukan hal yang sama dengan cron harian (catch-up on demand).
router.post('/generate-bulanan', async (req, res, next) => {
    try {
        let H = parseInt(process.env.INVOICE_GEN_H_MINUS) || 3;
        try {
            const sr = await query(`SELECT nilai FROM setting WHERE kunci='invoice_gen_h' LIMIT 1`);
            if (sr && sr[0] && String(sr[0].nilai).trim() !== '') H = parseInt(sr[0].nilai) || H;
        } catch (e) {}
        const batasAtas = dayjs().add(H, 'day').format('YYYY-MM-DD');
        const pelanggan = await query(`
            SELECT pl.*, pk.harga, pk.id AS paket_id, pk.satuan_masa
            FROM pelanggan pl JOIN paket pk ON pl.paket_id = pk.id
            WHERE pl.status = 'aktif'
              AND pl.tgl_expired IS NOT NULL
              AND DATE(pl.tgl_expired) >= CURDATE()
              AND DATE(pl.tgl_expired) <= ?
        `, [batasAtas]);

        let berhasil = 0, gagal = 0, gagalWa = 0;
        const tahun = dayjs().format('YYYY');

        for (const p of pelanggan) {
            try {
                // Paket gratis tidak ditagih
                if (!p.harga || Number(p.harga) <= 0) continue;

                const tgl_jatuh = dayjs(p.tgl_expired).format('YYYY-MM-DD');

                // Cegah duplikat tagihan (paket bulanan: 1 invoice / bulan;
                // paket harian/jam: cek tanggal persis).
                let ada;
                if (String(p.satuan_masa || '').toLowerCase() === 'bulan') {
                    // Paket bulanan: JANGAN buat tagihan periode baru selama pelanggan
                    // masih punya invoice unpaid/overdue (periode mana pun). Mencegah
                    // tagihan menumpuk / invoice "basi" saat tgl_expired bergeser.
                    ada = await queryOne(`
                        SELECT id FROM invoice
                        WHERE pelanggan_id = ?
                          AND status IN ('unpaid','overdue')
                        LIMIT 1
                    `, [p.id]);
                } else {
                    ada = await queryOne(`
                        SELECT id FROM invoice
                        WHERE pelanggan_id = ?
                          AND status IN ('unpaid','overdue')
                          AND DATE(tgl_jatuh_tempo) = ?
                        LIMIT 1
                    `, [p.id, tgl_jatuh]);
                }
                if (ada) continue;

                // Insert invoice dengan nomor yang aman dari race condition
                const { no_invoice, result } = await withTransaction(db =>
                    generateUniqueInvoiceNo(db, INVOICE_PREFIX, tahun, (noInv) =>
                        db.query(`
                            INSERT INTO invoice (no_invoice, pelanggan_id, paket_id, jumlah,
                                tgl_invoice, tgl_jatuh_tempo)
                            VALUES (?,?,?,?,CURDATE(),?)
                        `, [noInv, p.id, p.paket_id, p.harga, tgl_jatuh])
                    )
                );

                // Buat transaksi payment gateway setelah invoice tersimpan
                const pg = await paymentService.buatTransaksi({
                    order_id: no_invoice, gross_amount: p.harga, pelanggan: p
                }).catch(err => {
                    console.warn(`[INVOICE] Payment gateway gagal untuk ${no_invoice}:`, err.message);
                    return null;
                });

                if (pg?.payment_url) {
                    await query(`UPDATE invoice SET payment_id=?, payment_url=? WHERE id=?`,
                        [pg.order_id, pg.payment_url, result.insertId]);
                }

                berhasil++;

                // Kirim WA reminder — kegagalan kirim WA TIDAK membuat invoice dianggap gagal,
                // karena data invoice sudah tersimpan dengan benar.
                try {
                    await waService.kirimLinkBayar(p, {
                        no_invoice, jumlah: p.harga,
                        tgl_jatuh_tempo: tgl_jatuh, payment_url: pg?.payment_url
                    });
                } catch (waErr) {
                    console.warn(`[INVOICE] Kirim WA gagal untuk ${p.username}:`, waErr.message);
                    gagalWa++;
                }
            } catch (err) {
                console.error(`Invoice gagal untuk ${p.username}:`, err.message);
                gagal++;
            }
        }

        res.json({ pesan: `Invoice selesai dibuat`, berhasil, gagal, gagal_kirim_wa: gagalWa });
    } catch (e) { next(e); }
});

// POST /api/invoice/:id/bayar-tunai — konfirmasi bayar manual
router.post('/:id/bayar-tunai', async (req, res, next) => {
    try {
        const invCek = await queryOne('SELECT pelanggan_id, status FROM invoice WHERE id = ?', [req.params.id]);
        if (!invCek) return res.status(404).json({ error: 'Invoice tidak ditemukan' });

        // Invoice voucher online (pelanggan_id NULL): lunasi + buat voucher.
        if (invCek.pelanggan_id === null) {
            if (invCek.status === 'paid') {
                // Sudah lunas — pastikan voucher ada (repair bila webhook gagal)
            } else {
                await query(`UPDATE invoice SET status='paid', tgl_bayar=NOW(), metode_bayar='tunai' WHERE id=?`, [req.params.id]);
            }
            let kode = null;
            try {
                const { buatVoucherDariInvoice } = require('./voucher-publik');
                const r = await buatVoucherDariInvoice(req.params.id);
                kode = r?.username || null;
            } catch (e) { console.warn('[bayar-tunai voucher] buat voucher gagal:', e.message); }
            try {
                const invV = await queryOne('SELECT no_invoice, jumlah FROM invoice WHERE id=?', [req.params.id]);
                require('./log').tulisLog({ kategori:'Billing', pelaku: req.admin?.nama||'Admin',
                    aksi:'INVOICE_PAID', target: invV?.no_invoice,
                    detail:`Voucher online lunas manual${kode?` → ${kode}`:''}`,
                    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip });
            } catch (e) {}
            return res.json({ pesan: kode ? `Pembayaran dikonfirmasi, voucher: ${kode}` : 'Pembayaran dikonfirmasi', kode_voucher: kode });
        }

        const inv = await queryOne(`
            SELECT i.*, p.nama, p.no_hp, p.id AS pid, p.paket_id, p.status AS status_lama,
                   p.tgl_expired AS tgl_expired_lama, pk.masa_aktif, pk.satuan_masa, pk.nama AS nama_paket
            FROM invoice i
            JOIN pelanggan p ON i.pelanggan_id = p.id
            JOIN paket pk ON i.paket_id = pk.id
            WHERE i.id = ?
        `, [req.params.id]);
        if (!inv) return res.status(404).json({ error: 'Invoice tidak ditemukan' });
        if (inv.status === 'paid') return res.status(400).json({ error: 'Sudah lunas' });

        // masa_aktif 0 = paket tanpa batas (VIP) → tgl_expired NULL (tak pernah expired)
        // Perpanjangan: hitung dari tgl_expired lama bila masih berlaku (jaga hari jatuh tempo).
        const tgl_expired = (Number(inv.masa_aktif) > 0)
            ? hitungExpiredDari(inv.tgl_expired_lama, inv.masa_aktif, inv.satuan_masa).format('YYYY-MM-DD HH:mm:ss')
            : null;

        await query(
            `UPDATE invoice SET status='paid', tgl_bayar=NOW(), metode_bayar='tunai' WHERE id=?`,
            [req.params.id]
        );
        await query(
            `UPDATE pelanggan SET status='aktif', tgl_expired=? WHERE id=?`,
            [tgl_expired, inv.pelanggan_id]
        );

        // Balas SEGERA setelah DB konsisten — biar UI berubah cepat.
        res.json({ pesan: 'Pembayaran dikonfirmasi', tgl_expired });

        // Tugas berat dijalankan di BACKGROUND (tidak menahan response):
        // reconnect RADIUS (termasuk CoA radclient) + kirim WA konfirmasi + audit log.
        (async () => {
            try {
                const radiusService = require('../services/radius');
                const p = await queryOne('SELECT username FROM pelanggan WHERE id=?', [inv.pelanggan_id]);
                // Hanya reconnect (putus sesi) jika pelanggan SEBELUMNYA tidak aktif
                // (suspended/isolir/nonaktif). Kalau sudah aktif, jangan ganggu
                // sesinya — pembayaran cuma memperpanjang masa aktif.
                if (p && p.username) {
                    if (inv.status_lama === 'aktif') {
                        // Sudah aktif: pastikan atribut RADIUS benar tanpa memutus sesi
                        if (typeof radiusService.pulihkanTanpaReconnect === 'function') {
                            await radiusService.pulihkanTanpaReconnect(p.username);
                        }
                        // (jika fungsi belum ada, lewati — tidak ada yang perlu diubah)
                    } else {
                        await radiusService.aktifkanUser(p.username);
                    }
                }
            } catch (e) { console.warn('[bayar-tunai] reconnect gagal:', e.message); }

            try {
                await waService.kirimKonfirmasiBayar({
                    no_hp: inv.no_hp, nama: inv.nama,
                    jumlah: inv.jumlah, total: inv.jumlah, tgl_expired,
                    no_invoice: inv.no_invoice,
                    paket: inv.nama_paket || inv.paket,
                    metode_bayar: inv.metode_bayar || 'Tunai',
                    tgl_invoice: inv.tgl_invoice,
                    tgl_jatuh_tempo: inv.tgl_jatuh_tempo,
                    periode: inv.tgl_invoice
                });
            } catch (e) { console.warn('[bayar-tunai] kirim WA gagal:', e.message); }

            try {
                require('./log').tulisLog({ kategori:'Billing', pelaku: req.admin?.nama||'Admin',
                    aksi:'INVOICE_PAID', target: inv.no_invoice,
                    detail:`Amount: ${inv.jumlah}, Method: cash`, ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip });
            } catch (e) { console.warn('[bayar-tunai] log gagal:', e.message); }
        })();
    } catch (e) { next(e); }
});

// POST /api/invoice/:id/batalkan-lunas — rollback invoice 'paid' → 'unpaid'
// Khusus SUPERADMIN. Opsional: suspend pelanggan (req.body.suspend === true).
router.post('/:id/batalkan-lunas', async (req, res, next) => {
    try {
        if (req.admin?.role !== 'superadmin') {
            return res.status(403).json({ error: 'Hanya Super Admin yang bisa membatalkan pembayaran (rollback).' });
        }
        const inv = await queryOne(`
            SELECT i.*, p.username, p.nama, p.tgl_expired AS pelanggan_expired
            FROM invoice i LEFT JOIN pelanggan p ON i.pelanggan_id = p.id
            WHERE i.id = ?
        `, [req.params.id]);
        if (!inv) return res.status(404).json({ error: 'Invoice tidak ditemukan' });
        if (inv.status !== 'paid') return res.status(400).json({ error: 'Invoice ini belum berstatus Lunas' });
        if (inv.pelanggan_id === null) {
            return res.status(400).json({ error: 'Invoice voucher hotspot tidak bisa di-rollback lewat menu ini' });
        }

        let suspend = req.body.suspend === true || req.body.suspend === 'true';
        const force = req.body.force === true || req.body.force === 'true';

        // Pengaman: kalau pelanggan masih AKTIF (tgl_expired di masa depan),
        // jangan suspend kecuali admin menegaskan (force). Mencegah salah suspend
        // pelanggan yang masa aktifnya masih ada.
        const masihAktif = inv.pelanggan_expired && new Date(inv.pelanggan_expired) > new Date();
        let suspendDibatalkan = false;
        if (suspend && masihAktif && !force) {
            suspend = false;
            suspendDibatalkan = true;
        }

        // Kembalikan invoice ke belum bayar (hapus jejak pembayaran)
        await query(
            `UPDATE invoice SET status='unpaid', tgl_bayar=NULL, metode_bayar=NULL WHERE id=?`,
            [req.params.id]
        );

        // Suspend pelanggan jika diminta admin
        if (suspend && inv.pelanggan_id) {
            await query(`UPDATE pelanggan SET status='suspended' WHERE id=?`, [inv.pelanggan_id]);
        }

        // Balas segera; tugas RADIUS + audit log di background
        res.json({
            pesan: suspend
                ? `Pembayaran dibatalkan & pelanggan ${inv.nama || ''} di-suspend`
                : (suspendDibatalkan
                    ? `Pembayaran dibatalkan. Pelanggan ${inv.nama || ''} TIDAK di-suspend (masa aktif masih ada).`
                    : 'Pembayaran dibatalkan (pelanggan dibiarkan aktif)'),
            suspend,
            suspendDibatalkan
        });

        (async () => {
            if (suspend && inv.username) {
                try {
                    const radiusService = require('../services/radius');
                    await radiusService.suspendUser(inv.username);
                } catch (e) { console.warn('[batalkan-lunas] suspend RADIUS gagal:', e.message); }
            }
            try {
                require('./log').tulisLog({
                    kategori: 'Billing', pelaku: req.admin?.nama || 'Superadmin',
                    aksi: 'ROLLBACK_INVOICE', target: inv.no_invoice,
                    detail: `Batalkan lunas ${inv.no_invoice}${suspend ? ' + suspend pelanggan' : ''}`,
                    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip
                });
            } catch (e) { console.warn('[batalkan-lunas] log gagal:', e.message); }
        })();
    } catch (e) { next(e); }
});

// POST /api/invoice/:id/kirim-reminder
router.post('/:id/kirim-reminder', async (req, res, next) => {
    try {
        const invCek = await queryOne('SELECT pelanggan_id FROM invoice WHERE id = ?', [req.params.id]);
        if (!invCek) return res.status(404).json({ error: 'Tidak ditemukan' });
        if (invCek.pelanggan_id === null)
            return res.status(400).json({ error: 'Invoice voucher hotspot tidak memiliki reminder tagihan pelanggan' });

        const inv = await queryOne(`
            SELECT i.*, p.nama, p.no_hp FROM invoice i
            JOIN pelanggan p ON i.pelanggan_id = p.id WHERE i.id = ?
        `, [req.params.id]);
        if (!inv) return res.status(404).json({ error: 'Tidak ditemukan' });

        await waService.kirimReminder({
            no_hp: inv.no_hp, nama: inv.nama,
            no_invoice: inv.no_invoice, jumlah: inv.jumlah,
            tgl_jatuh_tempo: inv.tgl_jatuh_tempo, tgl_invoice: inv.tgl_invoice,
            payment_url: inv.payment_url, pelanggan_id: inv.pelanggan_id,
            invoice_id: inv.id, metode_bayar: inv.metode_bayar
        });

        res.json({ pesan: 'Reminder WA terkirim' });
    } catch (e) { next(e); }
});

// DELETE /api/invoice/:id — hapus invoice yang tidak diperlukan
router.delete('/:id', async (req, res, next) => {
    try {
        const inv = await queryOne('SELECT id, no_invoice, status, pelanggan_id FROM invoice WHERE id = ?', [req.params.id]);
        if (!inv) return res.status(404).json({ error: 'Invoice tidak ditemukan' });

        // Invoice yang sudah lunas hanya boleh dihapus oleh SUPERADMIN.
        // Ini melindungi jejak akuntansi: admin/operator/teknisi tetap diblokir,
        // hanya superadmin yang boleh menghapus (mis. untuk membersihkan invoice
        // hasil testing). Penghapusan dicatat ke admin_log untuk audit.
        if (inv.status === 'paid') {
            if (req.admin?.role !== 'superadmin') {
                return res.status(403).json({
                    error: 'Invoice lunas hanya bisa dihapus oleh Super Admin (untuk menjaga jejak akuntansi).'
                });
            }
            // Catat ke audit log (best-effort, jangan gagalkan operasi kalau log error)
            try {
                require('./log').tulisLog({
                    kategori: 'Billing',
                    pelaku: req.admin?.nama || 'Superadmin',
                    aksi: 'HAPUS_INVOICE_LUNAS',
                    target: inv.no_invoice,
                    detail: `Superadmin menghapus invoice LUNAS ${inv.no_invoice}`,
                    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip
                });
            } catch (e) { console.warn('[invoice] gagal catat admin_log:', e.message); }
        }

        // Jika invoice ini terhubung dengan voucher hotspot yang belum
        // dibayar, hapus juga voucher-nya sekaligus supaya tidak ada kode
        // voucher "menggantung" yang tidak punya cara dibayar.
        if (inv.pelanggan_id === null) {
            const ket = (await queryOne('SELECT keterangan FROM invoice WHERE id = ?', [inv.id]))?.keterangan || '';
            const kodeMatch = ket.match(/Voucher ([\w-]+)/);
            if (kodeMatch) {
                await query(`DELETE FROM voucher WHERE username = ? AND status = 'unused'`, [kodeMatch[1]]);
            }
        }

        // ANTI-REUSE: JANGAN hapus baris invoice — cukup tandai 'cancelled'.
        // Menghapus membebaskan no_invoice untuk dipakai ulang, dan pembayaran
        // gateway yang terlanjur memakai nomor lama bisa nyangkut ke pelanggan
        // lain (payment ter-kredit ke invoice yang salah). Baris tetap disimpan
        // agar nomor tidak pernah dipakai ulang & jejak akuntansi terjaga.
        await query(`UPDATE invoice SET status='cancelled', tgl_bayar=NULL WHERE id = ?`, [req.params.id]);

        res.json({ pesan: `Invoice ${inv.no_invoice} dibatalkan (status: cancelled)` });
    } catch (e) { next(e); }
});

// ============================================================
// CETAK PDF & KIRIM KE WHATSAPP
// ============================================================
const invoicePdf = require('../services/invoice-pdf');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
// PDF dikirim dari browser (html2pdf, identik dengan hasil print) → diterima
// sebagai multipart di memori, lalu disimpan & dikirim.
const uploadPdf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 } });

// GET /api/invoice/:id/pdf — generate & download PDF asli
router.get('/:id/pdf', async (req, res, next) => {
    try {
        const { filePath, no_invoice } = await invoicePdf.buatInvoicePDF(req.params.id);
        res.download(filePath, `${no_invoice}.pdf`);
    } catch (e) {
        if (e.message === 'Invoice tidak ditemukan')
            return res.status(404).json({ error: e.message });
        next(e);
    }
});

// POST /api/invoice/:id/buat-voucher — REPAIR: buat voucher untuk invoice
// voucher online yang sudah lunas tapi vouchernya belum dibuat (webhook gagal).
router.post('/:id/buat-voucher', async (req, res, next) => {
    try {
        const inv = await queryOne('SELECT id, no_invoice, status, pelanggan_id, keterangan FROM invoice WHERE id=?', [req.params.id]);
        if (!inv) return res.status(404).json({ error: 'Invoice tidak ditemukan' });
        if (inv.pelanggan_id !== null) return res.status(400).json({ error: 'Ini bukan invoice voucher online' });
        if (inv.status !== 'paid') return res.status(400).json({ error: 'Invoice belum lunas — lunasi dulu' });

        const { buatVoucherDariInvoice } = require('./voucher-publik');
        const r = await buatVoucherDariInvoice(req.params.id);
        if (!r) return res.status(400).json({ error: 'Gagal membuat voucher (cek keterangan invoice: WA/Paket)' });
        res.json({
            pesan: r.created ? `Voucher dibuat: ${r.username}` : `Voucher sudah ada: ${r.username}`,
            kode_voucher: r.username, dibuat: r.created
        });
    } catch (e) { next(e); }
});

// POST /api/invoice/:id/kirim-wa-pdf — kirim PDF ke WA pelanggan.
// Jika browser mengupload file PDF (html2pdf, identik dgn print) → pakai itu;
// kalau tidak ada (mis. dipanggil tanpa file) → fallback generate server-side.
router.post('/:id/kirim-wa-pdf', uploadPdf.single('file'), async (req, res, next) => {
    try {
        const inv = await queryOne(`
            SELECT i.no_invoice, i.jumlah, i.status, i.tgl_jatuh_tempo, i.payment_url,
                   i.keterangan, i.pelanggan_id,
                   p.nama, p.no_hp
            FROM invoice i LEFT JOIN pelanggan p ON i.pelanggan_id = p.id
            WHERE i.id = ?`, [req.params.id]);
        if (!inv) return res.status(404).json({ error: 'Invoice tidak ditemukan' });

        // Invoice voucher online (pelanggan_id NULL) tidak punya p.no_hp/p.nama.
        // Ambil dari keterangan: "WA: 628xxx — Nama: Budi".
        if (inv.pelanggan_id === null) {
            const ket = inv.keterangan || '';
            if (!inv.no_hp) { const m = ket.match(/WA:\s*(\d+)/); if (m) inv.no_hp = m[1]; }
            if (!inv.nama)  { const m = ket.match(/Nama:\s*([^—]+)/); if (m) inv.nama = m[1].trim(); }
            if (!inv.nama) inv.nama = 'Pembeli Voucher';
        }

        const noHp = req.body?.no_hp || inv.no_hp;
        if (!noHp) return res.status(400).json({ error: 'Nomor HP pelanggan tidak tersedia' });

        let filePath, publicUrl, filename;
        if (req.file && req.file.buffer && req.file.size > 0) {
            // PDF dari browser — identik dengan hasil print
            const dir = path.join(__dirname, '../../frontend/uploads/invoice');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const safeNo = String(inv.no_invoice).replace(/[^a-zA-Z0-9_-]/g, '_');
            filename = `${safeNo}_${crypto.randomBytes(4).toString('hex')}.pdf`;
            filePath = path.join(dir, filename);
            fs.writeFileSync(filePath, req.file.buffer);
            const s = await queryOne(`SELECT nilai FROM setting WHERE kunci='app_url'`);
            const appUrl = (s?.nilai || '').replace(/\/+$/, '');
            publicUrl = appUrl ? `${appUrl}/uploads/invoice/${filename}` : `/uploads/invoice/${filename}`;
        } else {
            ({ filePath, publicUrl, filename } = await invoicePdf.buatInvoicePDF(req.params.id));
        }

        const isLunas = inv.status === 'paid';
        const caption = isLunas
            ? `Halo *${inv.nama || 'Pelanggan'}*, berikut bukti pembayaran invoice *${inv.no_invoice}*. Terima kasih 🙏`
            : `Halo *${inv.nama || 'Pelanggan'}*, berikut invoice *${inv.no_invoice}* sebesar *Rp ${Number(inv.jumlah).toLocaleString('id-ID')}*` +
              (inv.payment_url ? `\nBayar di sini: ${inv.payment_url}` : '');

        const hasil = await waService.kirimDokumen(noHp, {
            url: publicUrl, filePath, filename,
            caption, invoice_id: req.params.id, tipe: 'invoice_pdf'
        });

        if (!hasil.sukses)
            return res.status(502).json({ error: hasil.error || 'Gagal mengirim PDF ke WhatsApp', publicUrl });

        res.json({ pesan: `PDF invoice ${inv.no_invoice} terkirim ke ${noHp}`, publicUrl });
    } catch (e) {
        if (e.message === 'Invoice tidak ditemukan')
            return res.status(404).json({ error: e.message });
        next(e);
    }
});

module.exports = router;
