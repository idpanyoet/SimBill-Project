// routes/voucher-publik.js — endpoint PUBLIK tanpa JWT
const router = require('express').Router();
const { query, queryOne, withTransaction, generateUniqueInvoiceNo } = require('../config/db');
const paymentService = require('../services/payment');
const waService      = require('../services/whatsapp');
const radiusService  = require('../services/radius');
const rateLimit      = require('express-rate-limit');

const INVOICE_PREFIX = process.env.INVOICE_PREFIX || 'INV';

const limitBeli = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  message: { error: 'Terlalu banyak permintaan, coba lagi nanti.' }
});

// ── GET /voucher/info ── info publik storefront ──────────────
router.get('/info', async (req, res, next) => {
  try {
    const rows = await query(`SELECT kunci, nilai FROM setting WHERE kunci IN (
      'app_name','wa_number','alamat','pg_provider',
      'pg_metode_aktif',
      'pg_metode_aktif_tripay','pg_metode_aktif_duitku',
      'pg_metode_aktif_midtrans','pg_metode_aktif_xendit'
    )`);
    const map = {};
    rows.forEach(r => map[r.kunci] = r.nilai);
    // Kirim metode aktif sesuai provider yang sedang aktif
    const provider = map.pg_provider || 'tripay';
    const metodeKey = 'pg_metode_aktif_' + provider;
    map.pg_metode_aktif = map[metodeKey] || map.pg_metode_aktif || '';
    res.json(map);
  } catch(e) { next(e); }
});

// ── GET /voucher/paket ──────────────────────────────────────
router.get('/paket', async (req, res, next) => {
  try {
    // Coba query lengkap dengan satuan_masa
    let rows;
    try {
      rows = await query(`
        SELECT id, nama, kecepatan_dn, kecepatan_up, harga, masa_aktif, satuan_masa, deskripsi
        FROM paket
        WHERE aktif = 1 AND tipe IN ('hotspot','keduanya')
        ORDER BY harga ASC
      `);
    } catch(e) {
      // Fallback: kolom satuan_masa belum ada — jalankan migration dulu
      if (e.message && e.message.includes('satuan_masa')) {
        console.warn('[voucher/paket] Kolom satuan_masa belum ada, menjalankan migration...');
        await query(`ALTER TABLE paket ADD COLUMN satuan_masa ENUM('jam','hari','bulan') NOT NULL DEFAULT 'hari' AFTER masa_aktif`).catch(()=>{});
        rows = await query(`
          SELECT id, nama, kecepatan_dn, kecepatan_up, harga, masa_aktif, 'hari' AS satuan_masa, deskripsi
          FROM paket
          WHERE aktif = 1 AND tipe IN ('hotspot','keduanya')
          ORDER BY harga ASC
        `);
      } else { throw e; }
    }
    res.json(rows);
  } catch (e) { next(e); }
});

// ── POST /voucher/beli ──────────────────────────────────────
// ALUR BARU: Invoice dibuat dulu (tanpa voucher). Voucher baru dibuat
// di webhook setelah pembayaran benar-benar lunas dikonfirmasi PG.
router.post('/beli', limitBeli, async (req, res, next) => {
  try {
    const { paket_id, paket_nama, harga: hargaFallback,
            no_hp, nama = 'Pembeli', metode = 'qris' } = req.body;

    if (!no_hp) return res.status(400).json({ error: 'no_hp wajib diisi' });
    if (!paket_id && !paket_nama)
      return res.status(400).json({ error: 'paket_id atau paket_nama wajib diisi' });

    const noHpNormal = no_hp.replace(/[-\s]/g, '').replace(/^0/, '62').replace(/^\+/, '');

    // Lookup paket dari DB — harga tidak bisa dimanipulasi client
    let paket;
    if (paket_id && !isNaN(parseInt(paket_id))) {
      paket = await queryOne('SELECT * FROM paket WHERE id = ? AND aktif = 1', [parseInt(paket_id)]);
    }
    if (!paket && paket_nama) {
      paket = await queryOne('SELECT * FROM paket WHERE nama = ? AND aktif = 1', [paket_nama]);
    }
    if (!paket && hargaFallback) {
      console.error('[VOUCHER] Permintaan beli dengan paket fallback (tabel paket kosong).');
      return res.status(503).json({
        error: 'Paket voucher belum dikonfigurasi oleh admin. Silakan coba lagi nanti.'
      });
    }
    if (!paket) return res.status(404).json({ error: 'Paket tidak ditemukan' });

    const order_id = `VCR${Date.now().toString(36).toUpperCase()}`;
    const tahun    = new Date().getFullYear();
    const tglJatuh = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Buat HANYA invoice (tanpa voucher) — invoice menampung info pembeli
    // di kolom keterangan agar webhook bisa buat voucher setelah lunas.
    const ket = `Voucher PENDING — WA: ${noHpNormal} — Nama: ${nama} — Paket: ${paket.id}`;
    const noInv = await withTransaction(async (db) =>
      generateUniqueInvoiceNo(db, INVOICE_PREFIX, tahun, (noInvoice) =>
        db.query(`
          INSERT INTO invoice
            (no_invoice, pelanggan_id, paket_id, jumlah, tgl_invoice,
             tgl_jatuh_tempo, keterangan, status)
          VALUES (?, NULL, ?, ?, CURDATE(), ?, ?, 'unpaid')
        `, [noInvoice, paket.id, paket.harga, tglJatuh, ket])
      )
    ).then(r => r.no_invoice);

    // Buat transaksi payment gateway
    const pg = await paymentService.buatTransaksi({
      order_id,
      gross_amount: paket.harga,
      metode,
      pelanggan: {
        nama, no_hp: noHpNormal,
        username:   `voucher_${Date.now()}`,
        email:      `${noHpNormal}@voucher.id`,
        paket_id:   paket.id,
        nama_paket: paket.nama
      }
    }).catch(err => {
      console.warn(`[VOUCHER] Payment gateway gagal untuk ${order_id}:`, err.message);
      return null;
    });

    // Gagal buat link bayar → hapus invoice agar tidak menggantung
    if (!pg?.payment_url) {
      await query('DELETE FROM invoice WHERE no_invoice = ?', [noInv]);
      console.error(`[VOUCHER] Payment gateway gagal untuk ${order_id}.`);
      return res.status(503).json({
        error: 'Sistem pembayaran sedang tidak tersedia. Silakan coba beberapa saat lagi atau hubungi admin.'
      });
    }

    // Simpan payment_url & order_id ke invoice
    await query(
      `UPDATE invoice SET payment_id=?, payment_url=? WHERE no_invoice=?`,
      [pg.order_id, pg.payment_url, noInv]
    );

    res.json({
      sukses: false, perlu_bayar: true,
      payment_url: pg.payment_url,
      order_id, no_invoice: noInv,
      pesan: 'Selesaikan pembayaran untuk mendapatkan kode voucher'
    });
  } catch (e) { next(e); }
});

module.exports = { router, _aktivasiVoucher, _acakUsername };
