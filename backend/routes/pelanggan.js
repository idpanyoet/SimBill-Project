// routes/pelanggan.js — Manajemen pelanggan + sinkronisasi RADIUS
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { query, queryOne, hitungExpired, hitungProrata, withTransaction, generateUniqueInvoiceNo } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');
const radiusService = require('../services/radius');
const dayjs = require('dayjs');

router.use(authMiddleware);

// GET /api/pelanggan — daftar dengan filter & pagination
router.get('/', async (req, res, next) => {
    try {
        const { status, tipe, cari, halaman = 1, limit = 20 } = req.query;
        const offset = (parseInt(halaman) - 1) * parseInt(limit);

        let where = ['1=1'];
        let params = [];

        // Status khusus: online (ada sesi radacct aktif), offline (aktif tapi
        // tidak ada sesi), baru (didaftar 7 hari terakhir). Selain itu = status biasa.
        const SESI_AKTIF_PEL = `EXISTS (SELECT 1 FROM radacct ra WHERE ra.username=p.username AND ra.acctstoptime IS NULL)`;
        if (status === 'online')       { where.push(SESI_AKTIF_PEL); }
        else if (status === 'offline') { where.push(`p.status='aktif' AND NOT ${SESI_AKTIF_PEL}`); }
        else if (status === 'baru')    { where.push(`p.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`); }
        else if (status)               { where.push('p.status = ?'); params.push(status); }
        if (tipe)   { where.push('p.tipe_koneksi = ?'); params.push(tipe); }
        if (cari)   {
            where.push('(p.nama LIKE ? OR p.username LIKE ? OR p.no_hp LIKE ?)');
            params.push(`%${cari}%`, `%${cari}%`, `%${cari}%`);
        }

        const whereStr = where.join(' AND ');

        const [total] = await query(
            `SELECT COUNT(*) AS total FROM pelanggan p WHERE ${whereStr}`, params
        );
        const rows = await query(`
            SELECT p.*, pk.nama AS nama_paket, pk.kecepatan_dn, pk.harga
            FROM pelanggan p
            JOIN paket pk ON p.paket_id = pk.id
            WHERE ${whereStr}
            ORDER BY p.created_at DESC
            LIMIT ? OFFSET ?
        `, [...params, parseInt(limit), offset]);

        res.json({ data: rows, total: total.total, halaman, limit });
    } catch (e) { next(e); }
});

// ── POST /api/pelanggan/upload-ktp ───────────────────────────
// type: 'ktp' (default) | 'rumah' — disimpan di folder/prefix berbeda agar tak tercampur
router.post('/upload-ktp', async (req, res, next) => {
    try {
        const { data, ext = 'jpg', username, type } = req.body;
        if (!data) return res.status(400).json({ error: 'Data gambar kosong' });
        const fs   = require('fs');
        const path = require('path');
        const kind = (type === 'rumah') ? 'rumah' : 'ktp';
        const dir  = path.join(__dirname, `../../frontend/uploads/${kind}`);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const base64  = data.replace(/^data:image\/\w+;base64,/, '');
        const safe    = (username || kind).replace(/[^a-zA-Z0-9_-]/g, '_');
        const safeExt = /^(png|jpe?g|webp)$/i.test(ext) ? ext.toLowerCase() : 'jpg';
        const filename = `${kind}_${safe}_${Date.now()}.${safeExt}`;
        fs.writeFileSync(path.join(dir, filename), Buffer.from(base64, 'base64'));
        res.json({ url: `/uploads/${kind}/${filename}` });
    } catch(e) { next(e); }
});

// ── GET /api/pelanggan/peta — data pelanggan untuk peta ──────
router.get('/peta', async (req, res, next) => {
    try {
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS latitude DECIMAL(10,7) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS longitude DECIMAL(10,7) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS odc VARCHAR(64) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS odp VARCHAR(64) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS jarak_kabel INT NULL`).catch(()=>{});

        const rows = await query(`
            SELECT p.id, p.nama, p.username, p.no_hp, p.tipe_koneksi, p.status,
                   p.latitude, p.longitude, p.odc, p.odp, p.jarak_kabel, p.alamat,
                   pk.nama AS nama_paket,
                   CASE WHEN onl.username IS NOT NULL THEN 1 ELSE 0 END AS online
            FROM pelanggan p
            JOIN paket pk ON p.paket_id = pk.id
            LEFT JOIN (
                SELECT DISTINCT username FROM radacct WHERE acctstoptime IS NULL
            ) onl ON (onl.username = p.username OR SUBSTRING_INDEX(onl.username,'@',1) = SUBSTRING_INDEX(p.username,'@',1))
            WHERE p.latitude IS NOT NULL AND p.longitude IS NOT NULL
              AND p.status != 'nonaktif'
        `);
        res.json(rows);
    } catch(e) { next(e); }
});


// ── GET /api/pelanggan/export/csv ─────────────────────────────
router.get('/export/csv', async (req, res, next) => {
    try {
        const { tipe } = req.query;
        const cond = []; const params = [];
        if (tipe && ['pppoe','hotspot'].includes(tipe)) { cond.push('p.tipe_koneksi = ?'); params.push(tipe); }
        const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
        const rows = await query(`
            SELECT p.nama, p.username, p.no_hp, p.email, p.alamat,
                   p.tipe_koneksi, p.siklus, p.periode, p.status, p.tgl_aktif, p.tgl_expired,
                   p.ip_tetap, p.notes,
                   pk.nama AS nama_paket, pk.id AS paket_id
            FROM pelanggan p
            JOIN paket pk ON p.paket_id = pk.id
            ${where}
            ORDER BY p.created_at DESC
        `, params);

        const header = ['nama','username','no_hp','email','alamat','tipe_koneksi',
                        'siklus','periode','status','tgl_aktif','tgl_expired','ip_tetap','notes',
                        'nama_paket','paket_id'];
        const esc = (v) => {
            if (v == null) return '';
            let s = String(v);
            // Cegah formula injection: nilai diawali = + - @ (atau tab/CR) bisa
            // dieksekusi sebagai rumus oleh Excel/Sheets saat file dibuka.
            if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
            return s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
                ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const csv = [
            header.join(','),
            ...rows.map(r => header.map(k => esc(r[k])).join(','))
        ].join('\r\n');

        const suffix = (tipe && ['pppoe','hotspot'].includes(tipe)) ? '-' + tipe : '';
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="pelanggan${suffix}-${new Date().toISOString().slice(0,10)}.csv"`);
        res.send('\uFEFF' + csv); // BOM agar Excel baca UTF-8 dengan benar
    } catch (e) { next(e); }
});

// ── POST /api/pelanggan/import/csv ────────────────────────────
router.post('/import/csv', async (req, res, next) => {
    try {
        const { rows } = req.body; // array of objects dari frontend
        if (!Array.isArray(rows) || !rows.length)
            return res.status(400).json({ error: 'Data kosong' });

        let sukses = 0, gagal = 0;
        const errors = [];

        for (const row of rows) {
            try {
                const { nama, username, password, no_hp, tipe_koneksi, paket_id, email, alamat, notes, siklus, periode } = row;
                if (!nama || !username || !password || !no_hp || !paket_id)
                    throw new Error('Kolom wajib tidak lengkap');
                if (!['pppoe','hotspot'].includes(tipe_koneksi))
                    throw new Error(`tipe_koneksi tidak valid: ${tipe_koneksi}`);
                const sik = ['postpaid','prepaid'].includes(String(siklus||'').toLowerCase()) ? String(siklus).toLowerCase() : 'postpaid';
                const per = ['tetap','kalender'].includes(String(periode||'').toLowerCase()) ? String(periode).toLowerCase() : 'tetap';

                const existing = await queryOne('SELECT id FROM pelanggan WHERE username = ?', [username]);
                if (existing) throw new Error(`Username '${username}' sudah ada`);

                const paket = await queryOne('SELECT * FROM paket WHERE id = ?', [parseInt(paket_id)]);
                if (!paket) throw new Error(`Paket id ${paket_id} tidak ditemukan`);

                const tgl_aktif   = dayjs().format('YYYY-MM-DD');
                // masa_aktif 0 = paket tanpa batas (VIP) → tgl_expired NULL
                const tgl_expired = (Number(paket.masa_aktif) > 0)
                    ? hitungExpired(paket.masa_aktif, paket.satuan_masa).format('YYYY-MM-DD')
                    : null;
                const hash        = await bcrypt.hash(password, 10);

                const result = await query(`
                    INSERT INTO pelanggan (nama, username, password, no_hp, email, alamat,
                        paket_id, tipe_koneksi, tgl_aktif, tgl_expired, notes, siklus, periode)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                `, [nama, username, hash, no_hp, email||null, alamat||null,
                    paket.id, tipe_koneksi, tgl_aktif, tgl_expired, notes||null, sik, per]);

                await radiusService.tambahUser(username, password, paket, tipe_koneksi, null)
                    .catch(e => {
                        query('DELETE FROM pelanggan WHERE id = ?', [result.insertId]).catch(()=>{});
                        throw new Error(`RADIUS gagal: ${e.message}`);
                    });

                sukses++;
            } catch(e) {
                gagal++;
                errors.push({ row: row.username || '?', error: e.message });
            }
        }

        res.json({ sukses, gagal, errors });
    } catch (e) { next(e); }
});


// GET /api/pelanggan/:id
router.get('/:id', async (req, res, next) => {
    try {
        const p = await queryOne(`
            SELECT p.*, pk.nama AS nama_paket, pk.kecepatan_dn, pk.kecepatan_up, pk.harga, pk.pool_name
            FROM pelanggan p JOIN paket pk ON p.paket_id = pk.id
            WHERE p.id = ?
        `, [req.params.id]);
        if (!p) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });
        res.json(p);
    } catch (e) { next(e); }
});

// POST /api/pelanggan — tambah pelanggan baru
router.post('/', async (req, res, next) => {
    let step = 'validasi';
    try {
        const { nama, username, password, no_hp, email, alamat,
                paket_id, tipe_koneksi, ip_tetap, notes,
                latitude, longitude, odc, odp,
                no_ktp, tgl_lahir, ktp_url, foto_rumah, reseller_id, siklus, periode, jarak_kabel } = req.body;

        if (!nama || !username || !password || !no_hp || !paket_id)
            return res.status(400).json({ error: 'nama, username, password, no_hp, paket_id wajib diisi' });
        if (!['pppoe', 'hotspot'].includes(tipe_koneksi))
            return res.status(400).json({ error: 'tipe_koneksi harus pppoe atau hotspot' });

        step = 'cek_username';
        const existing = await queryOne('SELECT id FROM pelanggan WHERE username = ?', [username]);
        if (existing) return res.status(400).json({ error: 'Username sudah digunakan' });

        step = 'ambil_paket';
        const paket = await queryOne('SELECT * FROM paket WHERE id = ?', [paket_id]);
        if (!paket) return res.status(400).json({ error: 'Paket tidak ditemukan' });

        // Auto-migrate kolom peta jika belum ada
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS latitude DECIMAL(10,7) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS longitude DECIMAL(10,7) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS odc VARCHAR(64) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS odp VARCHAR(64) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS no_ktp VARCHAR(20) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS tgl_lahir DATE NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS ktp_url VARCHAR(255) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS jarak_kabel INT NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS siklus ENUM('postpaid','prepaid') NOT NULL DEFAULT 'postpaid'`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS periode ENUM('tetap','kalender') NOT NULL DEFAULT 'tetap'`).catch(()=>{});

        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS foto_rumah VARCHAR(255) NULL`).catch(()=>{});

        step = 'siapkan_data';
        // Penanda siapa yang menambahkan pelanggan (admin/teknisi)
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS dibuat_oleh_id INT NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS dibuat_oleh VARCHAR(100) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS dibuat_oleh_role VARCHAR(20) NULL`).catch(()=>{});
        const _pembuatId   = req.admin?.id || null;
        const _pembuatNama = req.admin?.nama || req.admin?.username || null;
        const _pembuatRole = req.admin?.role || null;
        const tgl_aktif    = dayjs().format('YYYY-MM-DD');
        // Prorata invoice pertama untuk PREPAID + Fixed Date (kalender), paket bulanan berbayar.
        const _sik = ['postpaid','prepaid'].includes(siklus) ? siklus : 'postpaid';
        const _per = ['tetap','kalender'].includes(periode) ? periode : 'tetap';
        // Paket "bulanan" untuk prorata: 1 bulan, ATAU 28-31 hari (paket bulanan dlm satuan hari).
        const _sm = String(paket.satuan_masa || '').toLowerCase();
        const _ma = Number(paket.masa_aktif) || 0;
        const _bulanan = (_sm === 'bulan' && _ma === 1) || (_sm === 'hari' && _ma >= 28 && _ma <= 31);
        let _prorata = null;
        if (_sik === 'prepaid' && _per === 'kalender' && _bulanan && Number(paket.harga) > 0) {
            let fixedDay = 1;
            try { const s = await queryOne(`SELECT nilai FROM setting WHERE kunci='billing_tgl_invoice' LIMIT 1`); if (s && s.nilai) fixedDay = parseInt(s.nilai) || 1; } catch (e) {}
            _prorata = hitungProrata(paket.harga, tgl_aktif, fixedDay, 'flat30', 7);
        }
        // Status bayar awal (hanya berlaku utk prepaid+Fixed Date yg kena prorata):
        //   'unpaid' = akun dibuat NONAKTIF (suspended) sampai invoice prorata dibayar.
        //   'paid'   = langsung aktif (default).
        const _initStatus = String(req.body.initial_status || 'paid').toLowerCase();
        const _unpaid = !!_prorata && _initStatus === 'unpaid';
        const _statusAwal = _unpaid ? 'suspended' : 'aktif';
        // masa_aktif 0 = paket tanpa batas (VIP) → tgl_expired NULL
        const tgl_expired  = (Number(paket.masa_aktif) > 0)
            ? (_prorata ? _prorata.tglExpired : hitungExpired(paket.masa_aktif, paket.satuan_masa).format('YYYY-MM-DD'))
            : null;
        const hash         = await bcrypt.hash(password, 12);

        step = 'insert_pelanggan';
        const result = await query(`
            INSERT INTO pelanggan (nama, username, password, no_hp, email, alamat,
                paket_id, tipe_koneksi, tgl_aktif, tgl_expired, ip_tetap, notes,
                latitude, longitude, odc, odp, no_ktp, tgl_lahir, ktp_url, foto_rumah, reseller_id, siklus, periode, status,
                dibuat_oleh_id, dibuat_oleh, dibuat_oleh_role, jarak_kabel)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, [nama, username, hash, no_hp, email || null, alamat || null,
            paket_id, tipe_koneksi, tgl_aktif, tgl_expired, ip_tetap || null, notes || null,
            latitude || null, longitude || null, odc || null, odp || null,
            no_ktp || null, tgl_lahir || null, ktp_url || null, foto_rumah || null, reseller_id || null,
            (['postpaid','prepaid'].includes(siklus) ? siklus : 'postpaid'),
            (['tetap','kalender'].includes(periode) ? periode : 'tetap'),
            _statusAwal,
            _pembuatId, _pembuatNama, _pembuatRole,
            (jarak_kabel !== undefined && jarak_kabel !== null && jarak_kabel !== '' ? parseInt(jarak_kabel) || null : null)]);

        step = 'sync_radius';
        // Sync ke FreeRADIUS — jika gagal, hapus dulu baris pelanggan agar tidak ada data
        // pelanggan "hantu" yang tidak punya akses internet sama sekali.
        try {
            await radiusService.tambahUser(username, password, paket, tipe_koneksi, ip_tetap);
            // Unpaid: langsung suspend di RADIUS (user ada + password tersimpan, tapi belum bisa konek).
            // Nanti aktif otomatis saat invoice prorata dibayar (bayar-tunai/gateway → aktifkanUser).
            if (_unpaid) { try { await radiusService.suspendUser(username); } catch (e) { console.warn('[unpaid] suspend RADIUS gagal:', e.message); } }
        } catch (radiusErr) {
            step = 'rollback_setelah_radius_gagal';
            await query('DELETE FROM pelanggan WHERE id = ?', [result.insertId]);
            throw new Error(`Gagal sinkronisasi RADIUS: ${radiusErr.message}`);
        }

        // Invoice pertama PRORATA (prepaid + Fixed Date). Dibuat setelah RADIUS sukses.
        // "Sudah Bayar (langsung Aktif)" (!_unpaid) → invoice langsung LUNAS, TANPA payment link.
        // "Belum Bayar" (_unpaid)              → invoice UNPAID + payment link (aktif saat dibayar).
        let _prorataInv = null;
        if (_prorata) {
            try {
                const tahun = dayjs().format('YYYY');
                const _lunas = !_unpaid;
                const _ket = `Prorata bulan pertama (${_prorata.hariTerpakai} hari s/d ${_prorata.tglExpired})`;
                const r = await withTransaction(db =>
                    generateUniqueInvoiceNo(db, (process.env.INVOICE_PREFIX || 'INV'), tahun, (noInv) =>
                        _lunas
                          ? db.query(`INSERT INTO invoice (no_invoice, pelanggan_id, paket_id, jumlah,
                                        tgl_invoice, tgl_jatuh_tempo, keterangan, status, tgl_bayar, metode_bayar, dibayar_oleh, dibayar_oleh_id)
                                      VALUES (?,?,?,?,CURDATE(),?,?, 'paid', NOW(), 'tunai', ?, ?)`,
                                [noInv, result.insertId, paket_id, _prorata.jumlah, _prorata.tglExpired, _ket,
                                 _pembuatNama, _pembuatId])
                          : db.query(`INSERT INTO invoice (no_invoice, pelanggan_id, paket_id, jumlah,
                                        tgl_invoice, tgl_jatuh_tempo, keterangan)
                                      VALUES (?,?,?,?,CURDATE(),?,?)`,
                                [noInv, result.insertId, paket_id, _prorata.jumlah, _prorata.tglExpired, _ket])
                    )
                );
                _prorataInv = { no_invoice: r.no_invoice, jumlah: _prorata.jumlah, tgl_jatuh_tempo: _prorata.tglExpired, insertId: r.result?.insertId || null, lunas: _lunas };
                // Payment link (gateway) HANYA untuk invoice yang BELUM dibayar (unpaid)
                if (!_lunas) {
                    try {
                        const paymentService = require('../services/payment');
                        const pg = await paymentService.buatTransaksi({
                            order_id: r.no_invoice, gross_amount: _prorata.jumlah,
                            pelanggan: { id: result.insertId, nama, no_hp, email }
                        }).catch(() => null);
                        if (pg?.payment_url) {
                            await query(`UPDATE invoice SET payment_id=?, payment_url=? WHERE no_invoice=?`,
                                [pg.order_id, pg.payment_url, r.no_invoice]);
                            _prorataInv.payment_url = pg.payment_url;
                        }
                    } catch (e) { console.warn('[PRORATA] payment gateway gagal:', e.message); }
                }
            } catch (e) { console.warn('[PRORATA] gagal buat invoice pertama:', e.message); }
        }

        // Kirim WA notifikasi pelanggan baru (non-blocking)
        const waService = require('../services/whatsapp');
        waService.kirimPelangganBaru({
            no_hp:      no_hp,
            nama:       nama,
            username:   username,
            password:   password,
            nama_paket: paket.nama,
            tgl_expired: tgl_expired,
            member_id:  result.insertId,
            no_hp_pel:  no_hp,
            email:      email || null,
            alamat:     alamat || null,
            harga:      _prorata ? _prorata.jumlah : paket.harga,
            total:      _prorata ? _prorata.jumlah : paket.harga,
            prorata:    !!_prorata,
            hari_prorata: _prorata ? _prorata.hariTerpakai : null,
            no_invoice: _prorataInv ? _prorataInv.no_invoice : null,
            payment_url: _prorataInv ? (_prorataInv.payment_url || null) : null,
            aktif:      !_unpaid,     // false = belum aktif (unpaid), harus bayar dulu
            lunas:      _prorataInv ? !!_prorataInv.lunas : false,  // invoice prorata sudah lunas?
            kecepatan:  paket.rate_limit || (paket.kecepatan_dn ? paket.kecepatan_dn + 'M' : null),
            masa_aktif: paket.masa_aktif
        }).catch(e => console.warn('[WA] kirimPelangganBaru gagal:', e.message));

        // Notif Telegram ke teknisi — pelanggan baru
        // Notif Telegram PENDAFTARAN (data lengkap + foto KTP + maps)
        require('../services/telegram').notifPendaftaran({
            nama, alamat, paket: paket.nama, username, no_hp,
            latitude, longitude, ktp_url, jarak_kabel
        }).catch(()=>{});

        const { tulisLog } = require('./log');
        tulisLog({ kategori:'Pelanggan', pelaku: req.admin?.nama || 'Admin',
            aksi:'PELANGGAN_TAMBAH', target: username,
            detail:`Nama: ${nama}, Paket: ${paket.nama}, Tipe: ${tipe_koneksi}`, ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip });

        res.status(201).json({
            pesan: _prorataInv
                ? `Pelanggan ditambahkan${_unpaid ? ' (BELUM AKTIF — menunggu pembayaran)' : ''}. Invoice prorata: ${_prorataInv.no_invoice} — Rp ${Number(_prorataInv.jumlah).toLocaleString('id-ID')} (jatuh tempo ${_prorataInv.tgl_jatuh_tempo})`
                : 'Pelanggan berhasil ditambahkan',
            id: result.insertId,
            aktif: !_unpaid,
            prorata: _prorataInv || null
        });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY')
            return res.status(400).json({ error: 'Username sudah digunakan' });
        // Sertakan info langkah yang gagal agar mudah didiagnosis dari log server,
        // tanpa membocorkan detail teknis ke response client.
        console.error(`[PELANGGAN] Gagal pada langkah '${step}':`, e.message);
        e.message = `[${step}] ${e.message}`;
        next(e);
    }
});

// PUT /api/pelanggan/:id — edit pelanggan
router.put('/:id', async (req, res, next) => {
    try {
        const { nama, no_hp, email, alamat, paket_id, tipe_koneksi, notes, username, password, status, siklus, periode } = req.body;
        if (!nama || !no_hp)
            return res.status(400).json({ error: 'nama dan no_hp wajib diisi' });

        const p = await queryOne('SELECT * FROM pelanggan WHERE id = ?', [req.params.id]);
        if (!p) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });

        // Auto-migrate kolom KTP jika belum ada
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS no_ktp VARCHAR(20) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS tgl_lahir DATE NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS ktp_url VARCHAR(255) NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS jarak_kabel INT NULL`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS siklus ENUM('postpaid','prepaid') NOT NULL DEFAULT 'postpaid'`).catch(()=>{});
        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS periode ENUM('tetap','kalender') NOT NULL DEFAULT 'tetap'`).catch(()=>{});

        const paketIdBaru = paket_id !== undefined && paket_id !== null && paket_id !== ''
            ? parseInt(paket_id) : p.paket_id;
        const tipeBaru    = tipe_koneksi || p.tipe_koneksi;
        const usernameBaru = username || p.username;

        // Ubah password di RADIUS jika password baru diberikan
        if (password) {
            const hash = await bcrypt.hash(password, 12);
            await query('UPDATE pelanggan SET password=? WHERE id=?', [hash, req.params.id]);
            // Update radcheck
            await query(`
                INSERT INTO radcheck (username, attribute, op, value)
                VALUES (?, 'Cleartext-Password', ':=', ?)
                ON DUPLICATE KEY UPDATE value = VALUES(value)
            `, [usernameBaru, password]);
        }

        // Ubah username di RADIUS jika username berubah
        if (usernameBaru !== p.username) {
            // Cek duplikat
            const cek = await queryOne('SELECT id FROM pelanggan WHERE username=? AND id!=?', [usernameBaru, p.id]);
            if (cek) return res.status(400).json({ error: 'Username sudah digunakan pelanggan lain' });
            // Rename username di tabel RADIUS. Hapus dulu baris milik username
            // BARU yang mungkin sudah ada (sisa data), agar UPDATE tidak bentrok
            // dengan UNIQUE KEY (username,attribute) di radcheck.
            await query('DELETE FROM radcheck    WHERE username=?', [usernameBaru]);
            await query('DELETE FROM radreply     WHERE username=?', [usernameBaru]);
            await query('DELETE FROM radusergroup WHERE username=?', [usernameBaru]);
            await query('UPDATE radcheck SET username=? WHERE username=?', [usernameBaru, p.username]);
            await query('UPDATE radreply SET username=? WHERE username=?', [usernameBaru, p.username]);
            await query('UPDATE radusergroup SET username=? WHERE username=?', [usernameBaru, p.username]);
        }

        // Status baru (kalau dikirim); fallback ke status lama
        const statusBaru = (status && ['aktif','suspended','nonaktif'].includes(status)) ? status : p.status;

        await query(`ALTER TABLE pelanggan ADD COLUMN IF NOT EXISTS foto_rumah VARCHAR(255) NULL`).catch(()=>{});
        await query(`
            UPDATE pelanggan SET nama=?, no_hp=?, email=?, alamat=?,
                paket_id=?, tipe_koneksi=?, notes=?, username=?, status=?, siklus=?, periode=?,
                latitude=?, longitude=?, odc=?, odp=?, jarak_kabel=?,
                no_ktp=?, tgl_lahir=?, reseller_id=?
                ${req.body.tgl_expired ? ', tgl_expired=?' : ''}
                ${req.body.ktp_url ? ', ktp_url=?' : ''}
                ${req.body.foto_rumah ? ', foto_rumah=?' : ''}
            WHERE id = ?
        `, [nama, no_hp, email || null, alamat || null, paketIdBaru, tipeBaru,
            notes || null, usernameBaru, statusBaru,
            (['postpaid','prepaid'].includes(siklus) ? siklus : (p.siklus || 'postpaid')),
            (['tetap','kalender'].includes(periode) ? periode : (p.periode || 'tetap')),
            req.body.latitude || null, req.body.longitude || null,
            req.body.odc || null, req.body.odp || null,
            (req.body.jarak_kabel !== undefined && req.body.jarak_kabel !== null && req.body.jarak_kabel !== '' ? parseInt(req.body.jarak_kabel) || null : null),
            req.body.no_ktp || null, req.body.tgl_lahir || null,
            (req.body.reseller_id === '' || req.body.reseller_id == null) ? null : req.body.reseller_id,
            ...(req.body.tgl_expired ? [req.body.tgl_expired] : []),
            ...(req.body.ktp_url ? [req.body.ktp_url] : []),
            ...(req.body.foto_rumah ? [req.body.foto_rumah] : []),
            req.params.id]);

        // Update atribut RADIUS jika paket berubah
        if (paketIdBaru !== p.paket_id) {
            const paket = await queryOne('SELECT * FROM paket WHERE id = ?', [paketIdBaru]);
            if (!paket) return res.status(400).json({ error: 'Paket baru tidak ditemukan' });
            await radiusService.updatePaket(usernameBaru, paket, tipeBaru);
        }

        // Tangani perubahan STATUS → sinkronkan ke RADIUS (isolir/aktivasi/putus sesi)
        if (statusBaru !== p.status) {
            try {
                if (statusBaru === 'aktif') {
                    await radiusService.aktifkanUser(usernameBaru);
                } else if (statusBaru === 'suspended') {
                    await radiusService.suspendUser(usernameBaru);
                } else if (statusBaru === 'nonaktif') {
                    // Nonaktif = tolak total (hapus dari RADIUS auth) + putus sesi
                    await radiusService.suspendUser(usernameBaru);
                }
                console.log(`[RADIUS] Status ${usernameBaru}: ${p.status} → ${statusBaru}`);
            } catch (e) {
                console.warn(`[RADIUS] Gagal sinkron status ${usernameBaru}: ${e.message}`);
            }
        }

        res.json({ pesan: 'Data pelanggan diperbarui' });
    } catch (e) { next(e); }
});

// POST /api/pelanggan/:id/suspend — suspend pelanggan
router.post('/:id/suspend', async (req, res, next) => {
    try {
        const p = await queryOne('SELECT * FROM pelanggan WHERE id = ?', [req.params.id]);
        if (!p) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });

        await query('UPDATE pelanggan SET status = ? WHERE id = ?', ['suspended', req.params.id]);
        await radiusService.suspendUser(p.username);

        // Kirim WA notifikasi suspend
        const waService = require('../services/whatsapp');
        await waService.kirimSuspend(p);

        // Notif Telegram ke teknisi — suspend
        require('../services/telegram').notif('suspend',
            `🔌 <b>Pelanggan Disuspend</b>\n\nNama: ${p.nama}\nUsername: ${p.username}` +
            (p.no_hp ? `\nHP: ${p.no_hp}` : '')
        ).catch(()=>{});

        res.json({ pesan: `${p.nama} berhasil disuspend` });
        require('./log').tulisLog({ kategori:'Pelanggan', pelaku: req.admin?.nama||'Admin',
            aksi:'PELANGGAN_SUSPEND', target: p.username, detail:`Nama: ${p.nama}`, ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip });
    } catch (e) { next(e); }
});

// POST /api/pelanggan/:id/aktifkan — reaktivasi
router.post('/:id/aktifkan', async (req, res, next) => {
    try {
        const p = await queryOne(`
            SELECT pl.*, pk.* FROM pelanggan pl
            JOIN paket pk ON pl.paket_id = pk.id WHERE pl.id = ?
        `, [req.params.id]);
        if (!p) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });

        const tgl_expired = hitungExpired(p.masa_aktif, p.satuan_masa).format('YYYY-MM-DD HH:mm:ss');
        await query('UPDATE pelanggan SET status = ?, tgl_expired = ? WHERE id = ?',
            ['aktif', tgl_expired, req.params.id]);
        await radiusService.aktifkanUser(p.username);

        res.json({ pesan: `${p.nama} berhasil diaktifkan` });
        require('./log').tulisLog({ kategori:'Pelanggan', pelaku: req.admin?.nama||'Admin',
            aksi:'PELANGGAN_AKTIFKAN', target: p.username, detail:`Nama: ${p.nama}`, ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip });
    } catch (e) { next(e); }
});

// GET /api/pelanggan/:id/sesi — sesi RADIUS aktif
router.get('/:id/sesi', async (req, res, next) => {
    try {
        const p = await queryOne('SELECT username FROM pelanggan WHERE id = ?', [req.params.id]);
        if (!p) return res.status(404).json({ error: 'Tidak ditemukan' });
        const sesi = await radiusService.getSesi(p.username);
        res.json(sesi);
    } catch (e) { next(e); }
});

// DELETE /api/pelanggan/:id — hapus pelanggan
router.delete('/:id', async (req, res, next) => {
    try {
        const p = await queryOne('SELECT * FROM pelanggan WHERE id = ?', [req.params.id]);
        if (!p) return res.status(404).json({ error: 'Tidak ditemukan' });

        await radiusService.hapusUser(p.username);
        await query('DELETE FROM pelanggan WHERE id = ?', [req.params.id]);

        res.json({ pesan: 'Pelanggan dihapus' });
    } catch (e) { next(e); }
});

module.exports = router;
