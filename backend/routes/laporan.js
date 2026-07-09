// routes/laporan.js
const router = require('express').Router();
const { query } = require('../config/db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const fs = require('fs');
const path = require('path');

// Cegah CSV/formula injection pada export Excel: nilai string yang diawali
// = + - @ (atau tab/CR) bisa tereksekusi sebagai formula saat dibuka di
// Excel/Google Sheets. Diberi prefiks ' agar diperlakukan sebagai teks.
function sf(v) {
    return (typeof v === 'string' && /^[=+\-@\t\r]/.test(v)) ? "'" + v : v;
}

router.use(authMiddleware);

// GET /api/laporan/dashboard — ringkasan utama
router.get('/dashboard', async (req, res, next) => {
    try {
        const [totalPelanggan] = await query(
            `SELECT COUNT(*) AS total FROM pelanggan WHERE status != 'nonaktif'`
        );
        const [pelangganBaru] = await query(
            `SELECT COUNT(*) AS total FROM pelanggan
             WHERE MONTH(created_at)=MONTH(NOW()) AND YEAR(created_at)=YEAR(NOW())`
        );
        const [aktifOnline] = await query(
            `SELECT COUNT(DISTINCT username) AS total FROM radacct WHERE acctstoptime IS NULL`
        );
        const [tagihanBulanIni] = await query(
            `SELECT SUM(jumlah) AS total FROM invoice
             WHERE MONTH(tgl_invoice)=MONTH(NOW()) AND YEAR(tgl_invoice)=YEAR(NOW())`
        );
        const [belumBayar] = await query(
            `SELECT COUNT(*) AS total, SUM(jumlah) AS nominal
             FROM invoice WHERE status IN ('unpaid','overdue')`
        );

        // Pendapatan voucher bulan ini
        const [vcrPendapatan] = await query(`
            SELECT SUM(p.harga) AS total, COUNT(*) AS jumlah
            FROM voucher v JOIN paket p ON v.paket_id = p.id
            WHERE v.status = 'used'
            AND MONTH(v.tgl_digunakan) = MONTH(NOW())
            AND YEAR(v.tgl_digunakan) = YEAR(NOW())
        `);

        // Pendapatan hari ini (invoice lunas + voucher terjual hari ini)
        const [pendapatanHari] = await query(`
            SELECT
                COALESCE(SUM(CASE WHEN DATE(tgl_bayar) = CURDATE() AND status = 'paid' AND pelanggan_id IS NOT NULL THEN jumlah ELSE 0 END), 0) AS invoice_hari,
                COUNT(CASE WHEN DATE(tgl_bayar) = CURDATE() AND status = 'paid' AND pelanggan_id IS NOT NULL THEN 1 END) AS invoice_count
            FROM invoice
        `);
        const [vcrHari] = await query(`
            SELECT COALESCE(SUM(p.harga), 0) AS total, COUNT(*) AS jumlah
            FROM voucher v JOIN paket p ON v.paket_id = p.id
            WHERE v.status = 'used' AND DATE(v.tgl_digunakan) = CURDATE()
        `);

        // Statistik user PPPoE
        const [pppoeTotal]   = await query(`SELECT COUNT(*) AS total FROM pelanggan WHERE tipe_koneksi='pppoe'`);
        const [pppoeOnline]  = await query(
            `SELECT COUNT(DISTINCT ra.username) AS total
             FROM radacct ra JOIN pelanggan p ON ra.username = p.username
             WHERE ra.acctstoptime IS NULL AND p.tipe_koneksi = 'pppoe'`
        );
        const [pppoeSuspend] = await query(`SELECT COUNT(*) AS total FROM pelanggan WHERE tipe_koneksi='pppoe' AND status='suspended'`);
        const pppoeOffline   = Math.max(0, (pppoeTotal.total || 0) - (pppoeOnline.total || 0) - (pppoeSuspend.total || 0));

        // Statistik user Hotspot (voucher)
        const [hotspotOnlineRow] = await query(
            `SELECT COUNT(DISTINCT ra.username) AS total
             FROM radacct ra
             WHERE ra.acctstoptime IS NULL AND ra.nasporttype = 'Wireless-802.11'`
        );
        const [hotspotTotalRow]   = await query(`SELECT COUNT(*) AS total FROM voucher WHERE status IN ('unused','used')`);
        const [hotspotExpiredRow] = await query(`SELECT COUNT(*) AS total FROM voucher WHERE status = 'expired'`);
        const hotspotOnline  = hotspotOnlineRow.total  || 0;
        const hotspotTotal   = hotspotTotalRow.total   || 0;
        const hotspotExpired = hotspotExpiredRow.total || 0;
        const hotspotOffline = Math.max(0, hotspotTotal - hotspotOnline - hotspotExpired);

        let waStats = [];
        try {
            waStats = await query(`
                SELECT tipe, status, COUNT(*) AS total FROM wa_log
                WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) GROUP BY tipe, status
            `);
        } catch(e) { /* wa_log belum ada */ }

        const offlineCount = Math.max(0, totalPelanggan.total - aktifOnline.total);

        res.json({
            total_pelanggan:          totalPelanggan.total,
            pelanggan_baru_bulan_ini: pelangganBaru.total,
            aktif_online:             aktifOnline.total,
            offline_count:            offlineCount,
            tagihan_bulan_ini:        parseFloat(tagihanBulanIni.total || 0),
            belum_bayar_count:        belumBayar.total,
            belum_bayar_nominal:      parseFloat(belumBayar.nominal || 0),
            vcr_pendapatan:           parseFloat(vcrPendapatan.total  || 0),
            vcr_jumlah:               parseInt(vcrPendapatan.jumlah || 0),
            pendapatan_hari:          parseFloat(pendapatanHari.invoice_hari || 0) + parseFloat(vcrHari.total || 0),
            pendapatan_hari_trx:      parseInt(pendapatanHari.invoice_count || 0) + parseInt(vcrHari.jumlah || 0),
            pendapatan_hari_pppoe:    parseFloat(pendapatanHari.invoice_hari || 0),
            pendapatan_hari_pppoe_trx:parseInt(pendapatanHari.invoice_count || 0),
            pendapatan_hari_hotspot:  parseFloat(vcrHari.total || 0),
            pendapatan_hari_hotspot_trx: parseInt(vcrHari.jumlah || 0),
            wa_stats:                 waStats,
            pppoe_total:              pppoeTotal.total   || 0,
            pppoe_online:             pppoeOnline.total  || 0,
            pppoe_offline:            pppoeOffline,
            pppoe_suspend:            pppoeSuspend.total || 0,
            hotspot_total:            hotspotTotal,
            hotspot_online:           hotspotOnline,
            hotspot_offline:          hotspotOffline,
            hotspot_expired:          hotspotExpired
        });
    } catch (e) { next(e); }
});

// GET /api/laporan/widget — data gabungan untuk widget dashboard
router.get('/widget', async (req, res, next) => {
    try {
        const tren = await query(`
            SELECT d.tgl AS tgl,
              COALESCE((SELECT SUM(jumlah) FROM invoice WHERE status='paid' AND DATE(tgl_bayar)=d.tgl),0)
              + COALESCE((SELECT SUM(p.harga) FROM voucher v JOIN paket p ON v.paket_id=p.id
                          WHERE v.status='used' AND DATE(v.tgl_digunakan)=d.tgl),0) AS total
            FROM (
              SELECT CURDATE() - INTERVAL n DAY AS tgl FROM
              (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6) nums
            ) d
            ORDER BY d.tgl ASC
        `);

        const pembayaran = await query(`
            SELECT i.no_invoice, i.jumlah, i.tgl_bayar,
                   COALESCE(p.nama,'Pembeli Voucher') AS nama
            FROM invoice i LEFT JOIN pelanggan p ON i.pelanggan_id=p.id
            WHERE i.status='paid' AND i.tgl_bayar IS NOT NULL
            ORDER BY i.tgl_bayar DESC LIMIT 5
        `);

        const expired = await query(`
            SELECT nama, username, tgl_expired, DATEDIFF(tgl_expired, CURDATE()) AS sisa
            FROM pelanggan
            WHERE status='aktif' AND tgl_expired IS NOT NULL
              AND tgl_expired BETWEEN CURDATE() AND CURDATE() + INTERVAL 3 DAY
            ORDER BY tgl_expired ASC LIMIT 8
        `);

        let nasN = 0, pgVal = '';
        try { const r = await query(`SELECT COUNT(*) AS n FROM nas`); nasN = r[0]?.n || 0; } catch(e) {}
        try { const r = await query(`SELECT nilai FROM setting WHERE kunci='pg_provider'`); pgVal = r[0]?.nilai || ''; } catch(e) {}

        res.json({
            tren, pembayaran, expired,
            status: { mikrotik: nasN > 0, payment: !!pgVal }
        });
    } catch (e) { next(e); }
});

// GET /api/laporan/pendapatan — per bulan
router.get('/pendapatan', async (req, res, next) => {
    try {
        const { tahun = new Date().getFullYear() } = req.query;
        const rows = await query(`
            SELECT
                MONTH(tgl_bayar) AS bulan,
                COUNT(*) AS jumlah_invoice,
                SUM(jumlah) AS total,
                metode_bayar
            FROM invoice
            WHERE status='paid' AND YEAR(tgl_bayar) = ?
            GROUP BY MONTH(tgl_bayar), metode_bayar
            ORDER BY bulan
        `, [tahun]);
        res.json(rows);
    } catch (e) { next(e); }
});

// GET /api/laporan/per-paket
router.get('/per-paket', async (req, res, next) => {
    try {
        const rows = await query(`
            SELECT
                pk.nama AS nama_paket,
                pk.harga,
                COUNT(DISTINCT p.id) AS jumlah_pelanggan,
                SUM(CASE WHEN i.status='paid' THEN i.jumlah ELSE 0 END) AS pendapatan,
                COUNT(CASE WHEN i.status='paid' THEN 1 END) AS lunas,
                COUNT(CASE WHEN i.status IN ('unpaid','overdue') THEN 1 END) AS belum_bayar
            FROM paket pk
            LEFT JOIN pelanggan p ON p.paket_id = pk.id
            LEFT JOIN invoice i ON i.paket_id = pk.id
                AND MONTH(i.tgl_invoice)=MONTH(NOW())
                AND YEAR(i.tgl_invoice)=YEAR(NOW())
            GROUP BY pk.id, pk.nama, pk.harga
        `);
        res.json(rows);
    } catch (e) { next(e); }
});

// GET /api/laporan/jatuh-tempo — invoice mendekati jatuh tempo
router.get('/jatuh-tempo', async (req, res, next) => {
    try {
        const { hari = 7 } = req.query;
        const rows = await query(`
            SELECT * FROM v_tagihan_jatuh_tempo
            WHERE sisa_hari <= ? AND sisa_hari >= -30
            ORDER BY sisa_hari ASC
        `, [parseInt(hari)]);
        res.json(rows);
    } catch (e) { next(e); }
});

// GET /api/laporan/export-excel — download laporan lengkap dalam format XLSX
router.get('/export-excel', async (req, res, next) => {
    try {
        let ExcelJS;
        try { ExcelJS = require('exceljs'); }
        catch(e) {
            return res.status(503).json({ error: 'Package exceljs belum terinstall. Jalankan: npm install di folder backend.' });
        }

        const wb = new ExcelJS.Workbook();
        wb.creator   = 'SimBill';
        wb.created   = new Date();
        wb.modified  = new Date();

        const bulan = new Date().toLocaleString('id-ID', { month: 'long', year: 'numeric' });

        // ── Helper: style header baris ────────────────────────────
        function styledHeader(sheet, row, cols) {
            const r = sheet.addRow(row);
            r.eachCell(c => {
                c.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
                c.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
                c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
                c.border    = {
                    top: {style:'thin'}, left: {style:'thin'},
                    bottom: {style:'thin'}, right: {style:'thin'}
                };
            });
            sheet.columns.forEach((col, i) => { if (cols[i]) col.width = cols[i]; });
            r.height = 20;
            return r;
        }

        function dataRow(sheet, row) {
            const r = sheet.addRow(Array.isArray(row) ? row.map(sf) : row);
            r.eachCell({ includeEmpty: true }, c => {
                c.border = {
                    top: {style:'thin', color:{argb:'FFD0D0D0'}},
                    left: {style:'thin', color:{argb:'FFD0D0D0'}},
                    bottom: {style:'thin', color:{argb:'FFD0D0D0'}},
                    right: {style:'thin', color:{argb:'FFD0D0D0'}}
                };
                c.alignment = { vertical: 'middle' };
            });
            return r;
        }

        function rupiah(angka) {
            return Number(angka || 0).toLocaleString('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 });
        }

        // ════════════════════════════════════════════════════════
        // SHEET 1: Ringkasan
        // ════════════════════════════════════════════════════════
        const shRingkasan = wb.addWorksheet('Ringkasan');
        shRingkasan.mergeCells('A1:B1');
        const titleCell = shRingkasan.getCell('A1');
        titleCell.value     = `Laporan Ringkasan — ${bulan}`;
        titleCell.font      = { bold: true, size: 14 };
        titleCell.alignment = { horizontal: 'center' };
        shRingkasan.getRow(1).height = 30;
        shRingkasan.addRow([]);

        const [totalPelanggan] = await query(`SELECT COUNT(*) AS total FROM pelanggan WHERE status != 'nonaktif'`);
        const [pelangganBaru]  = await query(`SELECT COUNT(*) AS total FROM pelanggan WHERE MONTH(created_at)=MONTH(NOW()) AND YEAR(created_at)=YEAR(NOW())`);
        const [tagihanBulan]   = await query(`SELECT SUM(jumlah) AS total FROM invoice WHERE MONTH(tgl_invoice)=MONTH(NOW()) AND YEAR(tgl_invoice)=YEAR(NOW())`);
        const [belumBayar]     = await query(`SELECT COUNT(*) AS total, SUM(jumlah) AS nominal FROM invoice WHERE status IN ('unpaid','overdue')`);
        const [pendapatanBulan]= await query(`SELECT SUM(jumlah) AS total FROM invoice WHERE status='paid' AND MONTH(tgl_bayar)=MONTH(NOW()) AND YEAR(tgl_bayar)=YEAR(NOW())`);
        const voucherUsed      = await query(`SELECT COUNT(*) AS total FROM voucher WHERE status='used' AND MONTH(tgl_digunakan)=MONTH(NOW()) AND YEAR(tgl_digunakan)=YEAR(NOW())`);

        shRingkasan.columns = [{width:35},{width:25}];
        styledHeader(shRingkasan, ['Indikator', 'Nilai'], [35, 25]);
        const ringkasanData = [
            ['Total Pelanggan Aktif',          totalPelanggan.total],
            ['Pelanggan Baru Bulan Ini',        pelangganBaru.total],
            ['Total Tagihan Bulan Ini',         rupiah(tagihanBulan.total)],
            ['Pendapatan (Lunas) Bulan Ini',    rupiah(pendapatanBulan.total)],
            ['Invoice Belum Dibayar',           `${belumBayar.total} invoice (${rupiah(belumBayar.nominal)})`],
            ['Voucher Terjual Bulan Ini',       voucherUsed[0]?.total || 0],
        ];
        ringkasanData.forEach(r => dataRow(shRingkasan, r));

        // ════════════════════════════════════════════════════════
        // SHEET 2: Pendapatan per Paket
        // ════════════════════════════════════════════════════════
        const shPaket = wb.addWorksheet('Per Paket');
        shPaket.mergeCells('A1:F1');
        const titlePaket = shPaket.getCell('A1');
        titlePaket.value     = `Pendapatan per Paket — ${bulan}`;
        titlePaket.font      = { bold: true, size: 14 };
        titlePaket.alignment = { horizontal: 'center' };
        shPaket.getRow(1).height = 30;
        shPaket.addRow([]);

        const perPaket = await query(`
            SELECT pk.nama AS nama_paket, pk.harga,
                COUNT(DISTINCT p.id) AS jumlah_pelanggan,
                SUM(CASE WHEN i.status='paid' THEN i.jumlah ELSE 0 END) AS pendapatan,
                COUNT(CASE WHEN i.status='paid' THEN 1 END) AS lunas,
                COUNT(CASE WHEN i.status IN ('unpaid','overdue') THEN 1 END) AS belum_bayar
            FROM paket pk
            LEFT JOIN pelanggan p ON p.paket_id = pk.id
            LEFT JOIN invoice i ON i.paket_id = pk.id
                AND MONTH(i.tgl_invoice)=MONTH(NOW()) AND YEAR(i.tgl_invoice)=YEAR(NOW())
            GROUP BY pk.id, pk.nama, pk.harga
        `);
        styledHeader(shPaket, ['Paket','Harga/Bulan','Pelanggan','Pendapatan','Lunas','Belum Bayar'], [25,18,14,20,10,12]);
        perPaket.forEach(r => dataRow(shPaket, [r.nama_paket, rupiah(r.harga), r.jumlah_pelanggan, rupiah(r.pendapatan), r.lunas||0, r.belum_bayar||0]));

        // Total row
        const totRow = shPaket.addRow(['TOTAL','',
            perPaket.reduce((a,r)=>a+(r.jumlah_pelanggan||0),0), '',
            perPaket.reduce((a,r)=>a+(r.lunas||0),0),
            perPaket.reduce((a,r)=>a+(r.belum_bayar||0),0)
        ]);
        totRow.eachCell(c => { c.font = {bold:true}; c.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FFF0F4F8'}}; });

        // ════════════════════════════════════════════════════════
        // SHEET 3: Invoice Bulan Ini
        // ════════════════════════════════════════════════════════
        const shInvoice = wb.addWorksheet('Invoice');
        shInvoice.mergeCells('A1:G1');
        const titleInv = shInvoice.getCell('A1');
        titleInv.value     = `Daftar Invoice — ${bulan}`;
        titleInv.font      = { bold: true, size: 14 };
        titleInv.alignment = { horizontal: 'center' };
        shInvoice.getRow(1).height = 30;
        shInvoice.addRow([]);

        const invoices = await query(`
            SELECT i.no_invoice, COALESCE(p.nama,'Pembeli Voucher') AS nama,
                pk.nama AS paket, i.jumlah, i.tgl_invoice,
                i.tgl_jatuh_tempo, i.status, i.metode_bayar
            FROM invoice i
            LEFT JOIN pelanggan p ON i.pelanggan_id = p.id
            JOIN paket pk ON i.paket_id = pk.id
            WHERE MONTH(i.tgl_invoice)=MONTH(NOW()) AND YEAR(i.tgl_invoice)=YEAR(NOW())
            ORDER BY i.tgl_invoice DESC
        `);
        styledHeader(shInvoice, ['No. Invoice','Pelanggan','Paket','Jumlah','Tgl Invoice','Jatuh Tempo','Status'],[22,22,18,16,14,14,12]);
        invoices.forEach(r => {
            const row = dataRow(shInvoice, [
                r.no_invoice, r.nama, r.paket, rupiah(r.jumlah),
                r.tgl_invoice ? new Date(r.tgl_invoice).toLocaleDateString('id-ID') : '',
                r.tgl_jatuh_tempo ? new Date(r.tgl_jatuh_tempo).toLocaleDateString('id-ID') : '',
                r.status
            ]);
            // Warna status
            const statusCell = row.getCell(7);
            if (r.status === 'paid')   { statusCell.font = {color:{argb:'FF166534'},bold:true}; statusCell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FFDCFCE7'}}; }
            if (r.status === 'overdue'){ statusCell.font = {color:{argb:'FF991B1B'},bold:true}; statusCell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FFFEE2E2'}}; }
        });

        // ════════════════════════════════════════════════════════
        // Kirim file
        // ════════════════════════════════════════════════════════
        const tglStr = new Date().toISOString().slice(0,10).replace(/-/g,'');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Laporan_SimBill_${tglStr}.xlsx"`);
        await wb.xlsx.write(res);
        res.end();

    } catch (e) { next(e); }
});

// ── GET /api/laporan/income-report ────────────────────────────
router.get('/income-report', async (req, res, next) => {
    try {
        const { dari, sampai, user_type = 'all', service_type = '', payment_method = '' } = req.query;

        if (!dari || !sampai)
            return res.status(400).json({ error: 'Parameter dari dan sampai wajib diisi' });

        let where = [`i.status = 'paid'`, `DATE(i.tgl_bayar) BETWEEN ? AND ?`];
        let params = [dari, sampai];

        // Filter user type
        if (user_type === 'customer') where.push('i.pelanggan_id IS NOT NULL');
        else if (user_type === 'voucher') where.push('i.pelanggan_id IS NULL');

        // Filter service type
        if (service_type === 'pppoe')   where.push("(pk.tipe = 'pppoe' OR (pk.tipe = 'keduanya' AND i.pelanggan_id IS NOT NULL))");
        else if (service_type === 'hotspot') where.push("(pk.tipe = 'hotspot' OR (pk.tipe = 'keduanya' AND i.pelanggan_id IS NOT NULL))");
        else if (service_type === 'voucher') where.push('i.pelanggan_id IS NULL');

        // Filter payment method
        if (payment_method) {
            where.push('i.metode_bayar = ?');
            params.push(payment_method);
        }

        const rows = await query(`
            SELECT
                i.id, i.no_invoice, i.jumlah, i.tgl_bayar, i.metode_bayar, i.status,
                COALESCE(p.nama, 'Pembeli Voucher') AS nama,
                pk.nama AS nama_paket, pk.tipe AS tipe_paket,
                CASE WHEN i.pelanggan_id IS NOT NULL THEN 'Customer' ELSE 'Voucher' END AS user_type
            FROM invoice i
            JOIN paket pk ON i.paket_id = pk.id
            LEFT JOIN pelanggan p ON i.pelanggan_id = p.id
            WHERE ${where.join(' AND ')}
            ORDER BY i.tgl_bayar DESC
        `, params);

        // Summary
        const totalPendapatan = rows.reduce((s, r) => s + parseFloat(r.jumlah || 0), 0);
        const totalCustomer   = rows.filter(r => r.user_type === 'Customer').length;
        const totalVoucher    = rows.filter(r => r.user_type === 'Voucher').length;

        // Summary per tipe paket
        const perTipe = {};
        rows.forEach(r => {
            const k = r.user_type === 'Voucher' ? 'Voucher' : (r.tipe_paket === 'pppoe' ? 'PPPoE' : r.tipe_paket === 'hotspot' ? 'Hotspot' : 'Lainnya');
            perTipe[k] = (perTipe[k] || 0) + parseFloat(r.jumlah || 0);
        });

        res.json({
            rows,
            summary: {
                total:    totalPendapatan,
                trx:      rows.length,
                customer: totalCustomer,
                voucher:  totalVoucher,
                per_tipe: perTipe,
                periode:  `${dari} s/d ${sampai}`
            }
        });
    } catch(e) { next(e); }
});

// ── GET /api/laporan/net-profit ──────────────────────────────
router.get('/net-profit', async (req, res, next) => {
    try {
        const year = parseInt(req.query.year) || new Date().getFullYear();
        const dari = req.query.dari || `${year}-01-01`;
        const sampai = req.query.sampai || `${year}-12-31`;

        // Pendapatan bulanan (paid invoices)
        const incomeRows = await query(`
            SELECT
                DATE_FORMAT(tgl_bayar,'%Y-%m') AS bulan,
                COUNT(*) AS trx_count,
                COALESCE(SUM(jumlah),0) AS gross_income
            FROM invoice
            WHERE status='paid' AND DATE(tgl_bayar) BETWEEN ? AND ?
            GROUP BY bulan
            ORDER BY bulan
        `, [dari, sampai]);

        // Biaya payment gateway dari setting (% fee)
        const [feeRow] = await query(`SELECT nilai FROM setting WHERE kunci='pg_fee_persen'`).catch(()=>[{nilai:'0'}]);
        const feePersen = parseFloat(feeRow?.nilai || 0);

        // Build per-bulan data
        const months = [];
        const d = new Date(dari);
        const dEnd = new Date(sampai);
        while (d <= dEnd) {
            const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
            const label = d.toLocaleString('id-ID',{month:'short',year:'numeric'});
            const inc = incomeRows.find(r => r.bulan === key);
            const gross = parseFloat(inc?.gross_income || 0);
            const trx   = parseInt(inc?.trx_count || 0);
            const sellerFee = Math.round(gross * feePersen / 100);
            const vat       = 0; // bisa diisi nanti
            const payout    = 0; // bisa diisi nanti
            const profit    = gross - sellerFee - vat - payout;
            months.push({ key, label, trx, gross, sellerFee, vat, payout, profit });
            d.setMonth(d.getMonth() + 1);
        }

        const totalGross  = months.reduce((s,m) => s + m.gross, 0);
        const totalFee    = months.reduce((s,m) => s + m.sellerFee, 0);
        const totalVat    = months.reduce((s,m) => s + m.vat, 0);
        const totalPayout = months.reduce((s,m) => s + m.payout, 0);
        const totalProfit = months.reduce((s,m) => s + m.profit, 0);
        const totalTrx    = months.reduce((s,m) => s + m.trx, 0);

        res.json({
            months,
            summary: { gross: totalGross, fee: totalFee, vat: totalVat, payout: totalPayout, profit: totalProfit, trx: totalTrx },
            periode: `${dari} s/d ${sampai}`,
            year
        });
    } catch(e) { next(e); }
});

// ── GET /api/laporan/income-report-excel ──────────────────────
router.get('/income-report-excel', async (req, res, next) => {
    try {
        const { dari, sampai, user_type = 'all', service_type = '', payment_method = '' } = req.query;
        if (!dari || !sampai) return res.status(400).json({ error: 'Parameter dari dan sampai wajib diisi' });

        let where = [`i.status = 'paid'`, `DATE(i.tgl_bayar) BETWEEN ? AND ?`];
        let params = [dari, sampai];
        if (user_type === 'customer') where.push('i.pelanggan_id IS NOT NULL');
        else if (user_type === 'voucher') where.push('i.pelanggan_id IS NULL');
        if (service_type === 'pppoe')   where.push("pk.tipe = 'pppoe'");
        else if (service_type === 'hotspot') where.push("pk.tipe = 'hotspot'");
        else if (service_type === 'voucher') where.push('i.pelanggan_id IS NULL');
        if (payment_method) { where.push('i.metode_bayar = ?'); params.push(payment_method); }

        const rows = await query(`
            SELECT i.no_invoice, i.jumlah, i.tgl_bayar, i.metode_bayar,
                   COALESCE(p.nama, 'Pembeli Voucher') AS nama,
                   pk.nama AS nama_paket, pk.tipe AS tipe_paket,
                   CASE WHEN i.pelanggan_id IS NOT NULL THEN 'Customer' ELSE 'Voucher' END AS user_type
            FROM invoice i
            JOIN paket pk ON i.paket_id = pk.id
            LEFT JOIN pelanggan p ON i.pelanggan_id = p.id
            WHERE ${where.join(' AND ')}
            ORDER BY i.tgl_bayar DESC
        `, params);

        const ExcelJS = require('exceljs');
        const wb = new ExcelJS.Workbook();
        wb.creator = 'SimBill';
        const ws  = wb.addWorksheet('Income Report');

        ws.columns = [
            { header:'No',           key:'no',      width:6  },
            { header:'Tanggal',      key:'tgl',     width:14 },
            { header:'No Invoice',   key:'inv',     width:20 },
            { header:'Nama',         key:'nama',    width:24 },
            { header:'Tipe',         key:'tipe',    width:12 },
            { header:'Paket',        key:'paket',   width:24 },
            { header:'Metode Bayar', key:'metode',  width:16 },
            { header:'Jumlah (Rp)',  key:'jumlah',  width:16 },
        ];

        // Style header
        ws.getRow(1).eachCell(cell => {
            cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFBA7517' } };
            cell.font = { bold:true, color:{ argb:'FFFFFFFF' } };
            cell.alignment = { vertical:'middle', horizontal:'center' };
        });

        let total = 0;
        rows.forEach((r, i) => {
            const tgl = r.tgl_bayar ? new Date(r.tgl_bayar).toISOString().slice(0,10) : '';
            ws.addRow({
                no:     i + 1,
                tgl,
                inv:    sf(r.no_invoice),
                nama:   sf(r.nama),
                tipe:   sf(r.user_type),
                paket:  sf(r.nama_paket),
                metode: sf(r.metode_bayar || 'cash'),
                jumlah: parseFloat(r.jumlah || 0)
            });
            total += parseFloat(r.jumlah || 0);
        });

        // Total row
        const totalRow = ws.addRow({ no:'', tgl:'', inv:'', nama:'TOTAL', tipe:'', paket:'', metode:'', jumlah: total });
        totalRow.eachCell(cell => { cell.font = { bold:true }; });

        // Format kolom jumlah
        ws.getColumn('jumlah').numFmt = '#,##0';

        const tglStr = `${dari}_${sampai}`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="income-report-${tglStr}.xlsx"`);
        await wb.xlsx.write(res);
        res.end();
    } catch(e) { next(e); }
});

// ═══════════════════════════════════════════════════════════
// LAPORAN PELANGGAN — GET /api/laporan/pelanggan?bulan=&tahun=&reseller_id=
// Entitas = reseller (reseller_id NULL -> "Admin / ISP sendiri").
// ═══════════════════════════════════════════════════════════
router.get('/pelanggan', async (req, res, next) => {
    try {
        const now    = new Date();
        const bulan  = parseInt(req.query.bulan) || (now.getMonth() + 1);
        const tahun  = parseInt(req.query.tahun) || now.getFullYear();
        const rid    = req.query.reseller_id ? parseInt(req.query.reseller_id) : null;
        const rW     = rid ? ' AND p.reseller_id=?' : '';
        const rP     = rid ? [rid] : [];
        const NB     = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

        // Ringkasan
        const [tot] = await query(`SELECT COUNT(*) AS n FROM pelanggan p WHERE 1=1${rW}`, [...rP]);
        const [akt] = await query(`SELECT COUNT(*) AS n FROM pelanggan p WHERE p.status='aktif'${rW}`, [...rP]);
        const [reg] = await query(
            `SELECT COUNT(*) AS n FROM pelanggan p WHERE MONTH(p.created_at)=? AND YEAR(p.created_at)=?${rW}`,
            [bulan, tahun, ...rP]);
        const [perp] = await query(
            `SELECT COUNT(*) AS n FROM invoice i ${rid ? 'JOIN pelanggan p ON i.pelanggan_id=p.id' : ''}
             WHERE i.status='paid' AND i.pelanggan_id IS NOT NULL
               AND MONTH(i.tgl_bayar)=? AND YEAR(i.tgl_bayar)=?${rid ? ' AND p.reseller_id=?' : ''}`,
            rid ? [bulan, tahun, rid] : [bulan, tahun]);

        // Distribusi tipe layanan (pppoe/hotspot)
        const tipeRows = await query(
            `SELECT p.tipe_koneksi AS tipe, COUNT(*) AS n FROM pelanggan p WHERE 1=1${rW} GROUP BY p.tipe_koneksi`, [...rP]);
        const TIPE_LBL = { pppoe: 'PPPoE', hotspot: 'Hotspot' };
        const tipe_layanan = tipeRows.map(r => ({ label: TIPE_LBL[r.tipe] || r.tipe, total: Number(r.n) }));

        // Pertumbuhan 6 bulan terakhir (registrasi per bulan per tipe)
        const win = [];
        { let y = tahun, m = bulan; for (let i = 0; i < 6; i++) { win.unshift({ y, m }); if (--m < 1) { m = 12; y--; } } }
        const kk = (y, m) => y * 100 + m;
        const growth = await query(
            `SELECT YEAR(p.created_at)*100+MONTH(p.created_at) AS ym, p.tipe_koneksi AS tipe, COUNT(*) AS n
             FROM pelanggan p
             WHERE (YEAR(p.created_at)*100+MONTH(p.created_at)) BETWEEN ? AND ?${rW}
             GROUP BY ym, tipe`,
            [kk(win[0].y, win[0].m), kk(tahun, bulan), ...rP]);
        const gmap = {}; growth.forEach(r => { gmap[r.ym + '-' + r.tipe] = Number(r.n); });
        const pertumbuhan = {
            labels:  win.map(b => `${NB[b.m]} ${b.y}`),
            pppoe:   win.map(b => gmap[kk(b.y, b.m) + '-pppoe']   || 0),
            hotspot: win.map(b => gmap[kk(b.y, b.m) + '-hotspot'] || 0),
        };
        pertumbuhan.total = win.map((b, i) => pertumbuhan.pppoe[i] + pertumbuhan.hotspot[i]);

        // Distribusi per entitas (reseller)
        const entRows = await query(
            `SELECT COALESCE(r.nama, 'Admin / ISP sendiri') AS entitas,
                    COUNT(*) AS total,
                    SUM(p.status='aktif') AS aktif,
                    SUM(p.status='suspended') AS suspended,
                    SUM(MONTH(p.created_at)=? AND YEAR(p.created_at)=?) AS baru_bulan,
                    SUM(p.tipe_koneksi='pppoe') AS n_pppoe,
                    SUM(p.tipe_koneksi='hotspot') AS n_hotspot
             FROM pelanggan p LEFT JOIN reseller r ON p.reseller_id=r.id
             WHERE 1=1${rW} GROUP BY entitas ORDER BY total DESC`,
            [bulan, tahun, ...rP]);
        const per_entitas = entRows.map(r => ({
            entitas: r.entitas, total: Number(r.total), aktif: Number(r.aktif),
            suspended: Number(r.suspended), baru_bulan: Number(r.baru_bulan),
            tipe_dominan: Number(r.n_hotspot) > Number(r.n_pppoe) ? 'Hotspot' : 'PPPoE'
        }));

        const daftar_entitas = await query(`SELECT id, nama FROM reseller ORDER BY nama`);

        res.json({
            periode: { bulan, tahun },
            ringkas: { total: Number(tot.n), registrasi_bulan: Number(reg.n), perpanjangan_bulan: Number(perp.n), aktif: Number(akt.n) },
            tipe_layanan, pertumbuhan, per_entitas, daftar_entitas
        });
    } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════
// LAPORAN VOUCHER — GET /api/laporan/voucher?bulan=&tahun=&paket_id=
// Voucher tak punya reseller_id -> distribusi "per Paket".
// ═══════════════════════════════════════════════════════════
router.get('/voucher', async (req, res, next) => {
    try {
        const now    = new Date();
        const bulan  = parseInt(req.query.bulan) || (now.getMonth() + 1);
        const tahun  = parseInt(req.query.tahun) || now.getFullYear();
        const pid    = req.query.paket_id ? parseInt(req.query.paket_id) : null;
        const pW     = pid ? ' AND v.paket_id=?' : '';
        const pP     = pid ? [pid] : [];
        const NB     = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
        const pad    = n => String(n).padStart(2, '0');
        const ymd    = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

        // Ringkasan
        const [tot]   = await query(`SELECT COUNT(*) AS n FROM voucher v WHERE 1=1${pW}`, [...pP]);
        const [stok]  = await query(`SELECT COUNT(*) AS n FROM voucher v WHERE v.status='unused'${pW}`, [...pP]);
        const [exp]   = await query(`SELECT COUNT(*) AS n FROM voucher v WHERE v.status='expired'${pW}`, [...pP]);
        const [pakai] = await query(
            `SELECT COUNT(*) AS n FROM voucher v WHERE v.tgl_digunakan IS NOT NULL
             AND MONTH(v.tgl_digunakan)=? AND YEAR(v.tgl_digunakan)=?${pW}`, [bulan, tahun, ...pP]);

        // Distribusi status
        const stRows = await query(`SELECT v.status AS s, COUNT(*) AS n FROM voucher v WHERE 1=1${pW} GROUP BY v.status`, [...pP]);
        const S_LBL = { unused: 'Belum Dipakai', used: 'Terpakai', expired: 'Expired' };
        const status = stRows.map(r => ({ label: S_LBL[r.s] || r.s, total: Number(r.n) }));

        // Aktivitas harian 14 hari (dibuat / terpakai / expired)
        const hari = []; for (let i = 13; i >= 0; i--) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); hari.push(d); }
        const dStart = ymd(hari[0]);
        const grpDay = async (col) => {
            const rows = await query(
                `SELECT DATE_FORMAT(${col}, '%Y-%m-%d') AS d, COUNT(*) AS n FROM voucher v
                 WHERE ${col} IS NOT NULL AND DATE(${col})>=?${pW} GROUP BY d`, [dStart, ...pP]);
            const m = {}; rows.forEach(r => { m[r.d] = Number(r.n); }); return m;
        };
        const [mDib, mPak, mExp] = [await grpDay('v.created_at'), await grpDay('v.tgl_digunakan'), await grpDay('v.tgl_expired')];
        const aktivitas = {
            labels:   hari.map(d => `${d.getDate()} ${NB[d.getMonth()]}`),
            dibuat:   hari.map(d => mDib[ymd(d)] || 0),
            terpakai: hari.map(d => mPak[ymd(d)] || 0),
            expired:  hari.map(d => mExp[ymd(d)] || 0),
        };

        // Distribusi per paket
        const ppRows = await query(
            `SELECT pk.nama AS paket, COUNT(*) AS total,
                    SUM(v.status='unused')  AS belum,
                    SUM(v.status='used')    AS terpakai,
                    SUM(v.status='expired') AS expired
             FROM voucher v JOIN paket pk ON v.paket_id=pk.id
             WHERE 1=1${pW} GROUP BY pk.id, pk.nama ORDER BY total DESC`, [...pP]);
        const per_paket = ppRows.map(r => ({
            paket: r.paket, total: Number(r.total),
            belum_dipakai: Number(r.belum), terpakai: Number(r.terpakai), expired: Number(r.expired)
        }));

        const daftar_paket = await query(`SELECT id, nama FROM paket ORDER BY nama`);

        res.json({
            periode: { bulan, tahun },
            ringkas: { total: Number(tot.n), belum_dipakai: Number(stok.n), terpakai_bulan: Number(pakai.n), expired: Number(exp.n) },
            status, aktivitas, per_paket, daftar_paket
        });
    } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════
// KALKULATOR BHP/USO — GET /api/laporan/bhp-uso?bulan=&tahun=&bhp=&uso=&kso=&ppn=
// Pemasukan kotor = semua invoice LUNAS bulan itu (pelanggan + voucher online
// yang tercatat sebagai invoice). Tiap tarif (%) diterapkan LANGSUNG ke pemasukan
// kotor (flat), PPN dihitung ulang di sini (tidak baca PPN tersimpan per transaksi).
// ═══════════════════════════════════════════════════════════
router.get('/bhp-uso', async (req, res, next) => {
    try {
        const now   = new Date();
        const bulan = parseInt(req.query.bulan) || (now.getMonth() + 1);
        const tahun = parseInt(req.query.tahun) || now.getFullYear();
        const bhp = parseFloat(req.query.bhp) || 0;
        const uso = parseFloat(req.query.uso) || 0;
        const kso = parseFloat(req.query.kso) || 0;
        const ppn = parseFloat(req.query.ppn) || 0;

        const [g] = await query(
            `SELECT COALESCE(SUM(jumlah),0) AS gross, COUNT(*) AS trx
             FROM invoice WHERE status='paid' AND MONTH(tgl_bayar)=? AND YEAR(tgl_bayar)=?`,
            [bulan, tahun]);
        const gross = Number(g.gross) || 0;
        const trx   = Number(g.trx) || 0;

        const nPPN = gross * ppn / 100;
        const nBHP = gross * bhp / 100;
        const nUSO = gross * uso / 100;
        const nKSO = gross * kso / 100;
        const setelah = gross - nPPN - nBHP - nUSO - nKSO;

        // Nama entitas ISP (best-effort dari setting; fallback aman)
        let entitas = 'Penyelenggara (ISP)';
        try {
            const r = await query(
                `SELECT nilai FROM setting
                 WHERE kunci IN ('nama_isp','nama_perusahaan','company_name','isp_name','nama_aplikasi','app_name')
                   AND nilai IS NOT NULL AND nilai<>''
                 ORDER BY FIELD(kunci,'nama_isp','nama_perusahaan','company_name','isp_name','nama_aplikasi','app_name') LIMIT 1`);
            if (r && r[0] && r[0].nilai) entitas = r[0].nilai;
        } catch (e) { /* fallback */ }

        res.json({
            periode: { bulan, tahun },
            tarif: { bhp, uso, kso, ppn },
            rincian: [{
                entitas, transaksi: trx, total_pendapatan: gross,
                ppn: nPPN, bhp: nBHP, uso: nUSO, kso: nKSO,
                bhp_uso: nBHP + nUSO, setelah_potongan: setelah
            }],
            total: {
                transaksi: trx, total_pendapatan: gross,
                ppn: nPPN, bhp_uso: nBHP + nUSO, kso: nKSO, setelah_potongan: setelah
            }
        });
    } catch (e) { next(e); }
});

// ═══════════════════════════════════════════════════════════
// PENGELUARAN (Expense tracker) — /api/laporan/pengeluaran*
// ═══════════════════════════════════════════════════════════
let _pengeluaranReady = false;
async function ensurePengeluaran() {
    if (_pengeluaranReady) return;
    await query(`CREATE TABLE IF NOT EXISTS pengeluaran (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        tanggal DATE NOT NULL,
        kategori VARCHAR(60) NOT NULL DEFAULT 'Lainnya',
        deskripsi VARCHAR(255) NULL,
        jumlah DECIMAL(15,2) NOT NULL DEFAULT 0,
        metode_bayar VARCHAR(40) NULL,
        dibuat_oleh VARCHAR(100) NULL,
        dibuat_oleh_id INT NULL,
        created_at DATETIME NOT NULL DEFAULT current_timestamp(),
        KEY idx_tanggal (tanggal)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await query(`ALTER TABLE pengeluaran ADD COLUMN IF NOT EXISTS bukti VARCHAR(255) NULL`).catch(() => {});
    _pengeluaranReady = true;
}

// Hitung rentang tanggal dari parameter periode/dari/sampai
function _rentang(q) {
    const pad = n => String(n).padStart(2, '0');
    const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const now = new Date();
    const periode = q.periode || 'bulan-ini';
    if (q.dari && q.sampai) return { dari: q.dari, sampai: q.sampai };
    if (periode === 'hari-ini')  { const d = ymd(now); return { dari: d, sampai: d }; }
    if (periode === 'kemarin')   { const d = new Date(now); d.setDate(d.getDate() - 1); const s = ymd(d); return { dari: s, sampai: s }; }
    if (periode === 'bulan-lalu'){ const a = new Date(now.getFullYear(), now.getMonth() - 1, 1); const b = new Date(now.getFullYear(), now.getMonth(), 0); return { dari: ymd(a), sampai: ymd(b) }; }
    if (periode === 'tahun-ini') { return { dari: `${now.getFullYear()}-01-01`, sampai: `${now.getFullYear()}-12-31` }; }
    if (periode === 'semua')     { return { dari: '2000-01-01', sampai: '2999-12-31' }; }
    // default bulan-ini
    const a = new Date(now.getFullYear(), now.getMonth(), 1);
    const b = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { dari: ymd(a), sampai: ymd(b) };
}

// GET /pengeluaran/stats — kartu ringkas + delta
router.get('/pengeluaran/stats', async (req, res, next) => {
    try {
        await ensurePengeluaran();
        const [hariIni]   = await query(`SELECT COALESCE(SUM(jumlah),0) AS n FROM pengeluaran WHERE tanggal=CURDATE()`);
        const [kemarin]   = await query(`SELECT COALESCE(SUM(jumlah),0) AS n FROM pengeluaran WHERE tanggal=DATE_SUB(CURDATE(),INTERVAL 1 DAY)`);
        const [bulanIni]  = await query(`SELECT COALESCE(SUM(jumlah),0) AS n FROM pengeluaran WHERE MONTH(tanggal)=MONTH(CURDATE()) AND YEAR(tanggal)=YEAR(CURDATE())`);
        const [bulanLalu] = await query(`SELECT COALESCE(SUM(jumlah),0) AS n FROM pengeluaran WHERE tanggal>=DATE_FORMAT(DATE_SUB(CURDATE(),INTERVAL 1 MONTH),'%Y-%m-01') AND tanggal<DATE_FORMAT(CURDATE(),'%Y-%m-01')`);
        const [cBulanIni] = await query(`SELECT COUNT(*) AS n FROM pengeluaran WHERE MONTH(tanggal)=MONTH(CURDATE()) AND YEAR(tanggal)=YEAR(CURDATE())`);
        const [cBulanLalu]= await query(`SELECT COUNT(*) AS n FROM pengeluaran WHERE tanggal>=DATE_FORMAT(DATE_SUB(CURDATE(),INTERVAL 1 MONTH),'%Y-%m-01') AND tanggal<DATE_FORMAT(CURDATE(),'%Y-%m-01')`);
        const delta = (now, prev) => { now = Number(now); prev = Number(prev); if (!prev) return now ? 100 : 0; return +(((now - prev) / prev) * 100).toFixed(2); };
        res.json({
            hari_ini:   Number(hariIni.n),  delta_hari:  delta(hariIni.n, kemarin.n),
            bulan_ini:  Number(bulanIni.n), delta_bulan: delta(bulanIni.n, bulanLalu.n),
            catatan_bulan_ini: Number(cBulanIni.n), delta_catatan: delta(cBulanIni.n, cBulanLalu.n)
        });
    } catch (e) { next(e); }
});

// GET /pengeluaran/kategori — daftar kategori (preset + yang pernah dipakai)
router.get('/pengeluaran/kategori', async (req, res, next) => {
    try {
        await ensurePengeluaran();
        const preset = ['Gaji', 'Sewa', 'Listrik', 'Internet/Upstream', 'Perangkat', 'Perawatan', 'Transport', 'Marketing', 'Pajak', 'Lainnya'];
        const rows = await query(`SELECT DISTINCT kategori FROM pengeluaran WHERE kategori IS NOT NULL AND kategori<>'' ORDER BY kategori`);
        const dipakai = rows.map(r => r.kategori);
        res.json({ kategori: [...new Set([...preset, ...dipakai])] });
    } catch (e) { next(e); }
});

// GET /pengeluaran — list + pagination + search + periode
router.get('/pengeluaran', async (req, res, next) => {
    try {
        await ensurePengeluaran();
        const { dari, sampai } = _rentang(req.query);
        const q    = (req.query.q || '').trim();
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const per  = Math.min(200, Math.max(5, parseInt(req.query.per) || 25));
        const off  = (page - 1) * per;

        const where = ['tanggal BETWEEN ? AND ?'];
        const params = [dari, sampai];
        if (q) { where.push('(deskripsi LIKE ? OR kategori LIKE ? OR metode_bayar LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
        const W = 'WHERE ' + where.join(' AND ');

        const [cnt] = await query(`SELECT COUNT(*) AS n, COALESCE(SUM(jumlah),0) AS total FROM pengeluaran ${W}`, params);
        const rows = await query(
            `SELECT id, tanggal, kategori, deskripsi, jumlah, metode_bayar, bukti, dibuat_oleh, created_at
             FROM pengeluaran ${W} ORDER BY tanggal DESC, id DESC LIMIT ${per} OFFSET ${off}`, params);

        res.json({
            rows, total: Number(cnt.n), total_jumlah: Number(cnt.total),
            page, per, pages: Math.max(1, Math.ceil(Number(cnt.n) / per)),
            periode: { dari, sampai }
        });
    } catch (e) { next(e); }
});

// POST /pengeluaran/upload-bukti — simpan foto/struk (base64) → url
router.post('/pengeluaran/upload-bukti', requireAdmin, async (req, res, next) => {
    try {
        const b = req.body || {};
        let data = b.data || '';
        const ext = String(b.ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
        if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return res.status(400).json({ error: 'Format tidak didukung (JPG/PNG/WEBP)' });
        const m = data.match(/^data:[^;]+;base64,(.*)$/); if (m) data = m[1];
        if (!data) return res.status(400).json({ error: 'Data kosong' });
        const buf = Buffer.from(data, 'base64');
        if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'File maksimal 5MB' });
        const dir = path.join(__dirname, '../../frontend/uploads/pengeluaran');
        fs.mkdirSync(dir, { recursive: true });
        const name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        fs.writeFileSync(path.join(dir, name), buf);
        res.json({ ok: true, url: `/uploads/pengeluaran/${name}` });
    } catch (e) { next(e); }
});

// POST /pengeluaran — tambah (admin)
router.post('/pengeluaran', requireAdmin, async (req, res, next) => {
    try {
        await ensurePengeluaran();
        const b = req.body || {};
        const tanggal = (b.tanggal || '').slice(0, 10);
        const jumlah  = parseFloat(b.jumlah);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) return res.status(400).json({ error: 'Tanggal tidak valid' });
        if (!(jumlah >= 0)) return res.status(400).json({ error: 'Jumlah tidak valid' });
        const a = req.admin || {};
        const r = await query(
            `INSERT INTO pengeluaran (tanggal, kategori, deskripsi, jumlah, metode_bayar, bukti, dibuat_oleh, dibuat_oleh_id)
             VALUES (?,?,?,?,?,?,?,?)`,
            [tanggal, (b.kategori || 'Lainnya').slice(0, 60), (b.deskripsi || '').slice(0, 255) || null,
             jumlah, (b.metode_bayar || '').slice(0, 40) || null, (b.bukti || '').slice(0, 255) || null,
             a.nama || a.username || null, a.id ?? null]);
        res.json({ ok: true, id: r.insertId, pesan: 'Pengeluaran ditambahkan' });
    } catch (e) { next(e); }
});

// PUT /pengeluaran/:id — edit (admin)
router.put('/pengeluaran/:id', requireAdmin, async (req, res, next) => {
    try {
        await ensurePengeluaran();
        const id = parseInt(req.params.id); if (!id) return res.status(400).json({ error: 'ID tidak valid' });
        const b = req.body || {};
        const tanggal = (b.tanggal || '').slice(0, 10);
        const jumlah  = parseFloat(b.jumlah);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) return res.status(400).json({ error: 'Tanggal tidak valid' });
        if (!(jumlah >= 0)) return res.status(400).json({ error: 'Jumlah tidak valid' });
        await query(
            `UPDATE pengeluaran SET tanggal=?, kategori=?, deskripsi=?, jumlah=?, metode_bayar=?, bukti=? WHERE id=?`,
            [tanggal, (b.kategori || 'Lainnya').slice(0, 60), (b.deskripsi || '').slice(0, 255) || null,
             jumlah, (b.metode_bayar || '').slice(0, 40) || null, (b.bukti || '').slice(0, 255) || null, id]);
        res.json({ ok: true, pesan: 'Pengeluaran diperbarui' });
    } catch (e) { next(e); }
});

// DELETE /pengeluaran/:id — hapus (admin)
router.delete('/pengeluaran/:id', requireAdmin, async (req, res, next) => {
    try {
        await ensurePengeluaran();
        const id = parseInt(req.params.id); if (!id) return res.status(400).json({ error: 'ID tidak valid' });
        await query(`DELETE FROM pengeluaran WHERE id=?`, [id]);
        res.json({ ok: true, pesan: 'Pengeluaran dihapus' });
    } catch (e) { next(e); }
});

// GET /pengeluaran/export?format=csv|excel
router.get('/pengeluaran/export', async (req, res, next) => {
    try {
        await ensurePengeluaran();
        const { dari, sampai } = _rentang(req.query);
        const rows = await query(
            `SELECT tanggal, kategori, deskripsi, jumlah, metode_bayar, dibuat_oleh, bukti
             FROM pengeluaran WHERE tanggal BETWEEN ? AND ? ORDER BY tanggal DESC, id DESC`, [dari, sampai]);
        const fmtTgl = t => (t instanceof Date) ? t.toISOString().slice(0, 10) : String(t).slice(0, 10);
        const base = ((req.headers['x-forwarded-proto'] || req.protocol || 'https') + '://' + (req.get('host') || '')).replace(/\/+$/, '');
        const buktiUrl = b => (b ? (String(b).startsWith('http') ? String(b) : base + b) : '');
        const nama = `pengeluaran-${dari}_sd_${sampai}`;

        if ((req.query.format || 'csv') === 'excel') {
            const ExcelJS = require('exceljs');
            const wb = new ExcelJS.Workbook();
            const ws = wb.addWorksheet('Pengeluaran');
            ws.columns = [
                { header: 'Tanggal', key: 't', width: 14 }, { header: 'Kategori', key: 'k', width: 20 },
                { header: 'Deskripsi', key: 'd', width: 40 }, { header: 'Jumlah', key: 'j', width: 16 },
                { header: 'Metode', key: 'm', width: 18 }, { header: 'Dibuat Oleh', key: 'o', width: 20 },
                { header: 'Bukti', key: 'b', width: 50 },
            ];
            ws.getRow(1).font = { bold: true };
            rows.forEach(r => {
                const row = ws.addRow({ t: fmtTgl(r.tanggal), k: sf(r.kategori), d: sf(r.deskripsi), j: Number(r.jumlah), m: sf(r.metode_bayar), o: sf(r.dibuat_oleh), b: buktiUrl(r.bukti) });
                const url = buktiUrl(r.bukti);
                if (url) { const c = row.getCell('b'); c.value = { text: 'Lihat bukti', hyperlink: url }; c.font = { color: { argb: 'FF2563EB' }, underline: true }; }
            });
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${nama}.xlsx"`);
            await wb.xlsx.write(res); return res.end();
        }
        // CSV
        const esc = v => { v = sf(v == null ? '' : v); const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
        let csv = 'Tanggal,Kategori,Deskripsi,Jumlah,Metode,Dibuat Oleh,Bukti\n';
        rows.forEach(r => { csv += [fmtTgl(r.tanggal), esc(r.kategori), esc(r.deskripsi), Number(r.jumlah), esc(r.metode_bayar), esc(r.dibuat_oleh), esc(buktiUrl(r.bukti))].join(',') + '\n'; });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${nama}.csv"`);
        res.send('\uFEFF' + csv);
    } catch (e) { next(e); }
});

// GET /pembayaran-petugas?dari=&sampai= — rekap pembayaran per petugas yang memproses
router.get('/pembayaran-petugas', async (req, res, next) => {
    try {
        const { dari, sampai } = _rentang(req.query);
        const rows = await query(`
            SELECT COALESCE(NULLIF(TRIM(dibayar_oleh),''), '— Online / Gateway') AS petugas,
                   COUNT(*) AS transaksi,
                   COALESCE(SUM(jumlah),0) AS total
            FROM invoice
            WHERE status='paid' AND DATE(tgl_bayar) BETWEEN ? AND ?
            GROUP BY petugas
            ORDER BY total DESC
        `, [dari, sampai]);
        const totalSemua = rows.reduce((a, r) => a + Number(r.total || 0), 0);
        const totalTrx   = rows.reduce((a, r) => a + Number(r.transaksi || 0), 0);
        res.json({
            dari, sampai,
            ringkas: { total: totalSemua, transaksi: totalTrx, petugas: rows.length },
            data: rows.map(r => ({ petugas: r.petugas, transaksi: Number(r.transaksi), total: Number(r.total) })),
        });
    } catch (e) { next(e); }
});

module.exports = router;
