// routes/invoice.js — Manajemen invoice & tagihan
const router = require('express').Router();
const { query, queryOne, withTransaction, generateUniqueInvoiceNo, hitungExpired } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const paymentService  = require('../services/payment');
const waService       = require('../services/whatsapp');
const dayjs = require('dayjs');

router.use(authMiddleware);

const INVOICE_PREFIX = process.env.INVOICE_PREFIX || 'INV';

// GET /api/invoice
router.get('/', async (req, res, next) => {
    try {
        const { status, pelanggan_id, dari, sampai, tipe_koneksi, halaman = 1, limit = 20 } = req.query;
        const offset = (parseInt(halaman) - 1) * parseInt(limit);

        let where = ['1=1'];
        let params = [];

        if (status)       { where.push('i.status = ?'); params.push(status); }
        if (pelanggan_id) { where.push('i.pelanggan_id = ?'); params.push(pelanggan_id); }
        if (dari)         { where.push('i.tgl_invoice >= ?'); params.push(dari); }
        if (sampai)       { where.push('i.tgl_invoice <= ?'); params.push(sampai); }

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

        // Kirim WA jika diminta
        if (kirim_wa) {
            await waService.kirimLinkBayar(p, {
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

// POST /api/invoice/generate-bulanan — generate tagihan untuk semua pelanggan aktif
router.post('/generate-bulanan', async (req, res, next) => {
    try {
        const pelanggan = await query(`
            SELECT pl.*, pk.harga, pk.id AS paket_id
            FROM pelanggan pl JOIN paket pk ON pl.paket_id = pk.id
            WHERE pl.status = 'aktif'
        `);

        let berhasil = 0, gagal = 0, gagalWa = 0;
        const tahun      = dayjs().format('YYYY');
        const tgl_jatuh  = dayjs().endOf('month').format('YYYY-MM-DD');

        for (const p of pelanggan) {
            try {
                // Cek sudah ada invoice bulan ini
                const ada = await queryOne(`
                    SELECT id FROM invoice
                    WHERE pelanggan_id = ? AND MONTH(tgl_invoice) = MONTH(NOW())
                    AND YEAR(tgl_invoice) = YEAR(NOW())
                `, [p.id]);
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
        if (invCek.pelanggan_id === null)
            return res.status(400).json({ error: 'Invoice voucher hotspot tidak bisa dikonfirmasi lewat menu ini' });

        const inv = await queryOne(`
            SELECT i.*, p.nama, p.no_hp, p.id AS pid, p.paket_id, pk.masa_aktif
            FROM invoice i
            JOIN pelanggan p ON i.pelanggan_id = p.id
            JOIN paket pk ON i.paket_id = pk.id
            WHERE i.id = ?
        `, [req.params.id]);
        if (!inv) return res.status(404).json({ error: 'Invoice tidak ditemukan' });
        if (inv.status === 'paid') return res.status(400).json({ error: 'Sudah lunas' });

        const tgl_expired = hitungExpired(inv.masa_aktif, inv.satuan_masa).format('YYYY-MM-DD HH:mm:ss');

        await query(
            `UPDATE invoice SET status='paid', tgl_bayar=NOW(), metode_bayar='tunai' WHERE id=?`,
            [req.params.id]
        );
        await query(
            `UPDATE pelanggan SET status='aktif', tgl_expired=? WHERE id=?`,
            [tgl_expired, inv.pelanggan_id]
        );

        // Aktifkan di RADIUS jika suspended
        const radiusService = require('../services/radius');
        const p = await queryOne('SELECT username FROM pelanggan WHERE id=?', [inv.pelanggan_id]);
        await radiusService.aktifkanUser(p.username);

        // Kirim WA konfirmasi
        await waService.kirimKonfirmasiBayar({
            no_hp: inv.no_hp, nama: inv.nama,
            jumlah: inv.jumlah, tgl_expired
        });

        res.json({ pesan: 'Pembayaran dikonfirmasi', tgl_expired });
        require('./log').tulisLog({ kategori:'Billing', pelaku: req.user?.nama||'Admin',
            aksi:'INVOICE_PAID', target: inv.no_invoice,
            detail:`Amount: ${inv.jumlah}, Method: cash` });
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
            tgl_jatuh_tempo: inv.tgl_jatuh_tempo, payment_url: inv.payment_url
        });

        res.json({ pesan: 'Reminder WA terkirim' });
    } catch (e) { next(e); }
});

// DELETE /api/invoice/:id — hapus invoice yang tidak diperlukan
router.delete('/:id', async (req, res, next) => {
    try {
        const inv = await queryOne('SELECT id, no_invoice, status, pelanggan_id FROM invoice WHERE id = ?', [req.params.id]);
        if (!inv) return res.status(404).json({ error: 'Invoice tidak ditemukan' });

        // Invoice yang sudah lunas TIDAK BOLEH dihapus — ini melindungi jejak
        // akuntansi (riwayat pembayaran, laporan keuangan, dsb). Admin yang
        // ingin "membatalkan" invoice lunas sebaiknya menggunakan koreksi
        // pembukuan terpisah, bukan menghapus jejaknya.
        if (inv.status === 'paid') {
            return res.status(400).json({
                error: 'Invoice yang sudah lunas tidak bisa dihapus untuk menjaga jejak akuntansi.'
            });
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

        // payment_log.invoice_id sudah ON DELETE SET NULL di skema, jadi
        // riwayat log pembayaran tetap ada (untuk audit) walau invoice-nya
        // dihapus — invoice_id pada baris log itu otomatis jadi NULL.
        await query('DELETE FROM invoice WHERE id = ?', [req.params.id]);

        res.json({ pesan: `Invoice ${inv.no_invoice} berhasil dihapus` });
    } catch (e) { next(e); }
});

module.exports = router;
