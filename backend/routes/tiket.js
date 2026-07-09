// routes/tiket.js — Manajemen Tiket (sisi admin)
const router = require('express').Router();
const { query, queryOne } = require('../config/db');
const axios = require('axios');
const { authMiddleware } = require('../middleware/auth');
const waService = require('../services/whatsapp');

let tulisLog = () => {};
try { tulisLog = require('./log').tulisLog || tulisLog; } catch (e) {}

router.use(authMiddleware);

// GET /api/tiket/stats — ringkasan jumlah per status
router.get('/stats', async (req, res, next) => {
    try {
        const [r] = await query(`
            SELECT
              COUNT(*) AS total,
              SUM(status='open')    AS open_,
              SUM(status='proses')  AS proses,
              SUM(status='selesai') AS selesai
            FROM tiket
        `);
        res.json({
            total:   Number(r?.total)   || 0,
            open:    Number(r?.open_)    || 0,
            proses:  Number(r?.proses)  || 0,
            selesai: Number(r?.selesai) || 0
        });
    } catch (e) { next(e); }
});

// GET /api/tiket — daftar semua tiket (filter opsional: status, kategori, cari)
router.get('/', async (req, res, next) => {
    try {
        const { status, kategori, cari } = req.query;
        const cond = []; const params = [];
        if (status && ['open','proses','selesai'].includes(status)) { cond.push('t.status=?'); params.push(status); }
        if (kategori && ['umum','gangguan','billing','lainnya'].includes(kategori)) { cond.push('t.kategori=?'); params.push(kategori); }
        if (cari) { cond.push('(t.judul LIKE ? OR p.nama LIKE ? OR p.username LIKE ?)'); const q=`%${cari}%`; params.push(q,q,q); }
        const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
        const rows = await query(`
            SELECT t.id, t.judul, t.pesan, t.kategori, t.prioritas, t.status, t.foto, t.created_at, t.updated_at,
                   p.nama AS nama_pelanggan, p.username, p.no_hp,
                   (SELECT COUNT(*) FROM tiket_reply r WHERE r.tiket_id=t.id) AS jumlah_reply
            FROM tiket t
            LEFT JOIN pelanggan p ON t.pelanggan_id = p.id
            ${where}
            ORDER BY (t.status='open') DESC, t.updated_at DESC
            LIMIT 200
        `, params);
        res.json(rows);
    } catch (e) { next(e); }
});

// GET /api/tiket/teknisi — daftar admin/teknisi untuk penugasan
router.get('/teknisi', async (req, res, next) => {
    try {
        const rows = await query("SELECT id, nama, email, role FROM admin ORDER BY nama ASC");
        res.json(rows);
    } catch (e) { next(e); }
});

// GET /api/tiket/cari-pelanggan?q= — untuk modal Buat Tiket (search pelanggan)
router.get('/cari-pelanggan', async (req, res, next) => {
    try {
        const q = String(req.query.q || '').trim();
        if (!q) return res.json([]);
        const like = `%${q}%`;
        const rows = await query(
            `SELECT id, nama, username, no_hp FROM pelanggan
             WHERE nama LIKE ? OR username LIKE ? OR no_hp LIKE ?
             ORDER BY (nama LIKE ?) DESC, nama ASC LIMIT 15`,
            [like, like, like, `${q}%`]);
        res.json(rows);
    } catch (e) { next(e); }
});

// GET /api/tiket/info-koneksi/:pelanggan_id — sinkron device dari ACS (GenieACS) + IP/MAC dari radacct
router.get('/info-koneksi/:pelanggan_id', async (req, res, next) => {
    try {
        const p = await queryOne('SELECT id, username, nama FROM pelanggan WHERE id=? LIMIT 1', [req.params.pelanggan_id]);
        if (!p) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });

        // 1) Device dari GenieACS (via acs_link serial atau PPPoE username)
        let dev = null, sumber = null;
        try {
            const genie = require('../services/genieacs');
            const devs = await genie.listDevices({ limit: 2000 });
            let serial = null;
            const lk = await queryOne('SELECT serial_number FROM acs_link WHERE pelanggan_id=? LIMIT 1', [p.id]).catch(() => null);
            if (lk) serial = String(lk.serial_number || '').toLowerCase();
            const key = String(p.username || '').toLowerCase();
            const g = devs.find(d =>
                (serial && String(d.serial_number || '').toLowerCase() === serial) ||
                String(d.pppoe_username || '').toLowerCase() === key) || null;
            if (g) { dev = { status: g.status, pppoe: g.pppoe_username, ip: g.ip_address, ssid: g.ssid, rx: g.rx_power, last: g.last_inform, serial: g.serial_number }; sumber = 'GenieACS'; }
        } catch (e) { /* ACS tak tersedia */ }

        // 1b) Fallback ACS Lite (mis. pelanggan yang ONU-nya di ACS Lite spt 'miwifi')
        if (!dev) {
            try {
                const fs = require('fs');
                const rows = await query("SELECT kunci,nilai FROM setting WHERE kunci IN ('acslite_url','acslite_api_key')").catch(() => []);
                const cm = {}; rows.forEach(r => cm[r.kunci] = r.nilai);
                let apiKey = '';
                try { const t = fs.readFileSync('/opt/acs/.env', 'utf8'); const m = t.match(/^\s*API_KEY\s*=\s*(.+?)\s*$/m); if (m && m[1]) apiKey = m[1].replace(/^["']|["']$/g, ''); } catch (e) {}
                apiKey = apiKey || (cm.acslite_api_key || '').trim();
                const base = (cm.acslite_url || 'http://127.0.0.1:7547').replace(/\/+$/, '');
                const hdr = apiKey ? { 'X-API-Key': apiKey } : {};
                const key = String(p.username || '').toLowerCase();
                let serial = null;
                const lk = await queryOne('SELECT serial_number FROM acs_link WHERE pelanggan_id=? LIMIT 1', [p.id]).catch(() => null);
                if (lk) serial = String(lk.serial_number || '').toLowerCase();
                const r = await axios.get(`${base}/api/devices`, { headers: hdr, params: { page: 1, per_page: 1000 }, timeout: 12000 });
                const list = Array.isArray(r.data) ? r.data : (r.data && r.data.data) || [];
                // ACS Lite: PPPoE/IP/SSID ada di dalam d.parameters (path TR-069), bukan field langsung.
                const pget = (d, rx) => { const pm = d.parameters || {}; for (const k in pm) { if (rx.test(k) && pm[k] !== '' && pm[k] != null) return pm[k]; } return ''; };
                const litePPPoE = (d) => pget(d, /WANPPPConnection\.\d+\.Username$/i) || d.pppoe_username || '';
                const liteIP    = (d) => d.ip_address || pget(d, /WANPPPConnection\.\d+\.ExternalIPAddress$/i) || pget(d, /WANIPConnection\.\d+\.ExternalIPAddress$/i) || '';
                const liteSSID  = (d) => pget(d, /WLANConfiguration\.1\.SSID$/i) || d.ssid || '';
                // Online kalau inform terakhir < 15 menit (ACS Lite tak punya flag status)
                const liteOnline = (iso) => { if (!iso) return 'unknown'; const t = new Date(iso).getTime(); if (isNaN(t)) return 'unknown'; return (Date.now() - t) < 15 * 60 * 1000 ? 'online' : 'offline'; };

                const d = list.find(x => (serial && String(x.serial_number || '').toLowerCase() === serial) || String(litePPPoE(x) || '').toLowerCase() === key);
                if (d) {
                    const last = d.last_inform_time || d.last_inform || d.last_seen || null;
                    dev = {
                        status: liteOnline(last),
                        pppoe:  litePPPoE(d) || p.username,
                        ip:     liteIP(d),
                        ssid:   liteSSID(d),
                        rx:     (d.rx_power != null && d.rx_power !== '') ? d.rx_power : null,
                        last:   last,
                        serial: d.serial_number
                    };
                    sumber = 'ACS Lite';
                }
            } catch (e) { /* ACS Lite tak tersedia → radacct */ }
        }

        // 2) IP / MAC / status dari radacct (sesi terakhir) — lengkapi yang kosong dari ACS
        let ip = '', mac = '', lastSesi = null, statusSesi = null;
        try {
            const s = await queryOne(
                `SELECT framedipaddress, callingstationid, acctstarttime, acctupdatetime, acctstoptime
                 FROM radacct WHERE username=? ORDER BY radacctid DESC LIMIT 1`, [p.username]);
            if (s) {
                ip = s.framedipaddress || '';
                mac = s.callingstationid || '';
                lastSesi = s.acctupdatetime || s.acctstarttime || null;
                statusSesi = s.acctstoptime ? 'offline' : 'online';
            }
        } catch (e) {}

        res.json({
            sumber: sumber || (statusSesi ? 'RADIUS' : null),
            status: (dev && dev.status) || statusSesi || 'unknown',
            pppoe: (dev && dev.pppoe) || p.username || '',
            ip: (dev && dev.ip) || ip || '',
            mac: mac || '',
            ssid: (dev && dev.ssid) || '',
            rx_power: dev ? dev.rx : null,
            last_update: (dev && dev.last) || lastSesi || null
        });
    } catch (e) { next(e); }
});

// POST /api/tiket — buat tiket gangguan (admin/operator)
router.post('/', async (req, res, next) => {
    try {
        const { pelanggan_id, judul, kategori, prioritas, pesan } = req.body || {};
        if (!pelanggan_id) return res.status(400).json({ error: 'Pelanggan wajib dipilih' });
        if (!judul || !String(judul).trim()) return res.status(400).json({ error: 'Jenis gangguan wajib dipilih' });
        const kat  = ['umum', 'gangguan', 'billing', 'lainnya'].includes(kategori) ? kategori : 'gangguan';
        const prio = ['rendah', 'sedang', 'tinggi', 'urgent'].includes(prioritas) ? prioritas : 'sedang';
        const p = await queryOne('SELECT id, nama, username, alamat FROM pelanggan WHERE id=? LIMIT 1', [pelanggan_id]);
        if (!p) return res.status(404).json({ error: 'Pelanggan tidak ditemukan' });

        const r = await query(
            `INSERT INTO tiket (pelanggan_id, judul, pesan, kategori, prioritas, status, created_at, updated_at)
             VALUES (?,?,?,?,?, 'open', NOW(), NOW())`,
            [p.id, String(judul).trim().slice(0, 150), (String(pesan || '').trim() || String(judul).trim()), kat, prio]);

        // Notif teknisi (Telegram) — konsisten dgn alur tiket lain
        try {
            await require('../services/telegram').notif('tiket',
                `🛠️ <b>Tiket Baru (Admin)</b>\n\nPelanggan: ${p.nama} (${p.username})\n` +
                (p.alamat ? `Alamat: ${p.alamat}\n` : '') +
                `Jenis: ${String(judul).trim()}\nPrioritas: ${prio}` +
                (String(pesan || '').trim() ? `\nKeterangan: ${String(pesan).trim()}` : ''));
        } catch (e) {}
        try { tulisLog({ kategori: 'Tiket', pelaku: (req.admin && (req.admin.nama || req.admin.email)) || 'Admin', aksi: 'Buat Tiket', target: `#${r.insertId}`, detail: String(judul).trim(), ip: req.ip }); } catch (e) {}

        res.json({ ok: true, id: r.insertId, pesan: 'Tiket dibuat' });
    } catch (e) { next(e); }
});

// GET /api/tiket/:id — detail + percakapan
router.get('/:id', async (req, res, next) => {
    try {
        const tiket = await queryOne(`
            SELECT t.*, p.nama AS nama_pelanggan, p.username, p.no_hp, p.email
            FROM tiket t LEFT JOIN pelanggan p ON t.pelanggan_id=p.id
            WHERE t.id=?
        `, [req.params.id]);
        if (!tiket) return res.status(404).json({ error: 'Tiket tidak ditemukan' });
        const reply = await query('SELECT * FROM tiket_reply WHERE tiket_id=? ORDER BY created_at ASC', [req.params.id]);

        // Resolusi nama teknisi yang ditugaskan
        let teknisi = [];
        if (tiket.teknisi_ids) {
            const ids = String(tiket.teknisi_ids).split(',').map(x => parseInt(x)).filter(Boolean);
            if (ids.length) {
                teknisi = await query(
                    `SELECT id, nama, email FROM admin WHERE id IN (${ids.map(()=>'?').join(',')})`,
                    ids
                );
            }
        }
        res.json({ ...tiket, reply, teknisi });
    } catch (e) { next(e); }
});

// PUT /api/tiket/:id — penugasan (prioritas, estimasi, teknisi)
router.put('/:id', async (req, res, next) => {
    try {
        let { prioritas, perkiraan_perbaikan, teknisi_ids } = req.body;
        const tiket = await queryOne(
            `SELECT t.id, t.judul, t.teknisi_ids, p.nama AS nama_pelanggan, p.alamat AS alamat_pelanggan
             FROM tiket t LEFT JOIN pelanggan p ON t.pelanggan_id = p.id
             WHERE t.id=?`, [req.params.id]);
        if (!tiket) return res.status(404).json({ error: 'Tiket tidak ditemukan' });

        if (prioritas && !['rendah','sedang','tinggi','urgent'].includes(prioritas))
            return res.status(400).json({ error: 'Prioritas tidak valid' });

        // Normalisasi teknisi_ids → "1,3,5"
        let tids = null;
        if (Array.isArray(teknisi_ids)) tids = teknisi_ids.map(x => parseInt(x)).filter(Boolean).join(',');
        else if (typeof teknisi_ids === 'string') tids = teknisi_ids.split(',').map(x => parseInt(x)).filter(Boolean).join(',');
        tids = tids || null;

        // perkiraan_perbaikan: '' → null, 'YYYY-MM-DDTHH:mm' → datetime
        let est = (perkiraan_perbaikan === '' || perkiraan_perbaikan == null) ? null : String(perkiraan_perbaikan).replace('T', ' ');

        await query(
            'UPDATE tiket SET prioritas=COALESCE(?,prioritas), perkiraan_perbaikan=?, teknisi_ids=?, updated_at=NOW() WHERE id=?',
            [prioritas || null, est, tids, tiket.id]
        );

        // Notif Telegram ke teknisi bila ada penugasan baru
        try {
            if (tids && tids !== (tiket.teknisi_ids || '')) {
                const ids = tids.split(',').map(x => parseInt(x)).filter(Boolean);
                const tk = await query(`SELECT nama FROM admin WHERE id IN (${ids.map(()=>'?').join(',')})`, ids);
                const nama = tk.map(x => x.nama).join(', ');
                const prioLabel = { rendah:'Rendah', sedang:'Sedang', tinggi:'Tinggi', urgent:'URGENT' }[prioritas] || '-';
                await require('../services/telegram').notif('tiket',
                    `🛠️ <b>Tiket Ditugaskan</b>\n\nTiket: ${tiket.judul}\n` +
                    (tiket.nama_pelanggan ? `Pelanggan: ${tiket.nama_pelanggan}\n` : '') +
                    (tiket.alamat_pelanggan ? `Alamat: ${tiket.alamat_pelanggan}\n` : '') +
                    `Prioritas: <b>${prioLabel}</b>\nTeknisi: ${nama}` +
                    (est ? `\nEstimasi: ${est}` : ''));
            }
        } catch(e) {}

        try { tulisLog({ kategori:'Tiket', pelaku:(req.admin&&(req.admin.nama||req.admin.email))||'Admin', aksi:'Penugasan Tiket', target:`#${tiket.id}`, detail:`prio=${prioritas||'-'} teknisi=${tids||'-'}`, ip:req.ip }); } catch(e) {}
        res.json({ pesan: 'Penugasan disimpan' });
    } catch (e) { next(e); }
});

// POST /api/tiket/:id/reply — admin membalas tiket
router.post('/:id/reply', async (req, res, next) => {
    try {
        const { pesan } = req.body;
        if (!pesan || !pesan.trim()) return res.status(400).json({ error: 'Pesan wajib diisi' });
        const tiket = await queryOne(`
            SELECT t.*, p.nama, p.no_hp FROM tiket t LEFT JOIN pelanggan p ON t.pelanggan_id=p.id WHERE t.id=?
        `, [req.params.id]);
        if (!tiket) return res.status(404).json({ error: 'Tiket tidak ditemukan' });

        await query('INSERT INTO tiket_reply (tiket_id, dari, pesan) VALUES (?,?,?)', [tiket.id, 'admin', pesan.trim()]);
        // Tiket open → otomatis jadi proses saat admin balas
        const statusBaru = tiket.status === 'open' ? 'proses' : tiket.status;
        await query('UPDATE tiket SET status=?, updated_at=NOW() WHERE id=?', [statusBaru, tiket.id]);

        // Best-effort notifikasi WA ke pelanggan
        try {
            if (tiket.no_hp) {
                const setting = await query("SELECT kunci,nilai FROM setting WHERE kunci IN ('app_name')");
                const appName = (setting.find(s=>s.kunci==='app_name')||{}).nilai || 'SimBill';
                const msg = `🎫 *Balasan Tiket - ${appName}*\n\nTiket: ${tiket.judul}\n\n"${pesan.trim()}"\n\nBalas melalui portal pelanggan Anda.`;
                await waService.kirimPesan(tiket.no_hp, msg, tiket.pelanggan_id || null, 'tiket');
            }
        } catch (notifErr) { console.warn('[tiket] notif WA gagal:', notifErr.message); }

        try { tulisLog({ kategori:'Tiket', pelaku:(req.admin&&(req.admin.nama||req.admin.email))||'Admin', aksi:'Balas Tiket', target:`#${tiket.id}`, detail:tiket.judul, ip:req.ip }); } catch(e) {}
        res.json({ pesan: 'Balasan terkirim', status: statusBaru });
    } catch (e) { next(e); }
});

// PUT /api/tiket/:id/status — ubah status tiket
router.put('/:id/status', async (req, res, next) => {
    try {
        const { status } = req.body;
        if (!['open','proses','selesai'].includes(status))
            return res.status(400).json({ error: 'Status tidak valid' });
        const tiket = await queryOne('SELECT id, judul FROM tiket WHERE id=?', [req.params.id]);
        if (!tiket) return res.status(404).json({ error: 'Tiket tidak ditemukan' });
        await query('UPDATE tiket SET status=?, updated_at=NOW() WHERE id=?', [status, tiket.id]);
        try { tulisLog({ kategori:'Tiket', pelaku:(req.admin&&(req.admin.nama||req.admin.email))||'Admin', aksi:'Ubah Status Tiket', target:`#${tiket.id}`, detail:status, ip:req.ip }); } catch(e) {}
        res.json({ pesan: 'Status diperbarui', status });
    } catch (e) { next(e); }
});

module.exports = router;
