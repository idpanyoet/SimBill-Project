// routes/radius.js
const router = require('express').Router();
const { query, queryOne } = require('../config/db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const radiusService = require('../services/radius');

// Validasi nasname: hanya izinkan IPv4/IPv6/hostname yang wajar.
// Mencegah command injection (nasname dipakai di ping & ditulis ke clients.conf).
function validNasHost(v) {
    if (typeof v !== 'string') return false;
    v = v.trim();
    if (!v || v.length > 255) return false;
    const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
    const ipv6 = /^[0-9a-fA-F:]+$/;
    const host = /^[a-zA-Z0-9._-]+$/;
    return ipv4.test(v) || ipv6.test(v) || host.test(v);
}

router.use(authMiddleware);

router.get('/status', async (req, res, next) => {
    try {
        // Cek koneksi RADIUS dengan query ke tabel radacct.
        // Kalau query berhasil → RADIUS DB terhubung.
        // Kalau gagal (tabel tidak ada / DB error) → RADIUS bermasalah.
        const [{ sesi_aktif }] = await query(
            `SELECT COUNT(*) AS sesi_aktif FROM radacct WHERE acctstoptime IS NULL`
        );
        res.json({ online: true, sesi_aktif });
    } catch (e) {
        // Tidak throw ke next(e) — cukup kembalikan status offline
        console.warn('[RADIUS] Status check gagal:', e.message);
        res.json({ online: false, sesi_aktif: 0, error: e.message });
    }
});

router.get('/sesi-aktif', async (req, res, next) => {
    try {
        const sesi = await radiusService.semuaSesiAktif();
        res.json(sesi);
    } catch (e) { next(e); }
});

// ── GET /api/radius/sesi — halaman Sesi ──────────────────────
router.get('/sesi', async (req, res, next) => {
    try {
        const { tipe, q, limit = 500 } = req.query;
        let where = ['ra.acctstoptime IS NULL'];
        const params = [];
        if (tipe === 'pppoe')        where.push("ra.nasporttype = 'Ethernet'");
        else if (tipe === 'hotspot') where.push("ra.nasporttype = 'Wireless-802.11'");
        if (q) {
            where.push('(ra.username LIKE ? OR ra.framedipaddress LIKE ? OR ra.nasipaddress LIKE ? OR ra.callingstationid LIKE ?)');
            params.push(`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`);
        }
        const rows = await query(`
            SELECT ra.acctsessionid AS id_sesi,
                ra.username,
                ra.framedipaddress AS ip,
                ra.nasipaddress AS nas_ip,
                ra.callingstationid AS mac,
                ra.acctstarttime AS mulai,
                ra.acctupdatetime AS update_terakhir,
                TIMESTAMPDIFF(MINUTE, ra.acctstarttime, NOW()) AS durasi_menit,
                ROUND(ra.acctinputoctets/1048576, 2) AS mb_in,
                ROUND(ra.acctoutputoctets/1048576, 2) AS mb_out,
                ra.nasporttype,
                COALESCE(n.shortname, ra.nasipaddress) AS nas_name,
                p.nama AS nama_pelanggan,
                p.tipe_koneksi
            FROM radacct ra
            LEFT JOIN nas n ON ra.nasipaddress = n.nasname
            LEFT JOIN pelanggan p ON ra.username = p.username
            WHERE ${where.join(' AND ')}
            ORDER BY ra.acctstarttime DESC
            LIMIT ?
        `, [...params, parseInt(limit)]);

        const total   = rows.length;
        const pppoe   = rows.filter(r => r.nasporttype === 'Ethernet').length;
        const hotspot = rows.filter(r => r.nasporttype === 'Wireless-802.11').length;
        res.json({ rows, total, pppoe, hotspot });
    } catch(e) { next(e); }
});

// ── GET /api/radius/sesi-voucher — riwayat sesi pengguna voucher ──
router.get('/sesi-voucher', async (req, res, next) => {
    try {
        const { q, limit = 200 } = req.query;
        let where = ['v.id IS NOT NULL']; // hanya username yang ada di tabel voucher
        const params = [];
        if (q) {
            where.push('ra.username LIKE ?');
            params.push(`%${q}%`);
        }
        const rows = await query(`
            SELECT ra.acctsessionid AS id_sesi,
                ra.username,
                ra.framedipaddress AS ip,
                ra.acctstarttime AS mulai,
                ra.acctstoptime AS selesai,
                TIMESTAMPDIFF(MINUTE, ra.acctstarttime, IFNULL(ra.acctstoptime, NOW())) AS durasi_menit,
                ROUND(ra.acctinputoctets/1048576, 2) AS mb_in,
                ROUND(ra.acctoutputoctets/1048576, 2) AS mb_out,
                ra.acctterminatecause AS sebab,
                v.paket_id, pk.nama AS nama_paket
            FROM radacct ra
            JOIN voucher v ON ra.username = v.username
            JOIN paket pk ON v.paket_id = pk.id
            WHERE ${where.join(' AND ')}
            ORDER BY ra.acctstarttime DESC
            LIMIT ?
        `, [...params, parseInt(limit)]);
        res.json(rows);
    } catch(e) { next(e); }
});


router.post('/sesi/bersihkan-stale', async (req, res, next) => {
    try {
        // Hapus sesi yang tidak update lebih dari 15 menit (stale)
        // Ambang 15 menit = sama dengan cron otomatis; sesi aktif kirim
        // interim-update tiap ~5 menit, jadi 15 menit tanpa update = mati.
        const result = await query(`
            UPDATE radacct SET acctstoptime = NOW(), acctterminatecause = 'Stale-Cleaned'
            WHERE acctstoptime IS NULL
              AND acctupdatetime < DATE_SUB(NOW(), INTERVAL 15 MINUTE)
        `);
        res.json({ pesan: `${result.affectedRows} sesi stale dibersihkan`, jumlah: result.affectedRows });
    } catch(e) { next(e); }
});


router.post('/putus/:username', async (req, res, next) => {
    try {
        const hasil = await radiusService.putusKoneksi(req.params.username);
        res.json(hasil);
    } catch (e) { next(e); }
});

router.get('/nas', async (req, res, next) => {
    try {
        const rows = await query(`
            SELECT n.*,
                (SELECT COUNT(DISTINCT username) FROM radacct
                 WHERE nasipaddress = n.nasname AND acctstoptime IS NULL) AS jumlah_user,
                (SELECT MAX(acctstarttime) FROM radacct
                 WHERE nasipaddress = n.nasname) AS last_seen
            FROM nas n ORDER BY n.id
        `);

        // Cek status online via ping (1 packet, timeout 1 detik).
        // execFile (bukan exec) — tidak lewat shell, jadi nasname tidak bisa
        // dipakai untuk command injection meski lolos validasi.
        const { execFile } = require('child_process');
        const pingPromises = rows.map(n => new Promise(resolve => {
            if (!validNasHost(n.nasname)) return resolve({ ...n, online: false });
            execFile('ping', ['-c', '1', '-W', '1', n.nasname], (err) => {
                resolve({ ...n, online: !err });
            });
        }));
        const result = await Promise.all(pingPromises);
        res.json(result);
    } catch (e) { next(e); }
});

// ── Sync tabel nas → /etc/freeradius/3.0/clients.conf ──────
async function syncClientsConf() {
    try {
        const rows = await query('SELECT nasname, shortname, secret FROM nas');
        const CLIENTS_CONF = '/etc/freeradius/3.0/clients.conf';

        // Baca file asli, hapus semua blok client yang pernah ditambahkan billing
        let original = fs.existsSync(CLIENTS_CONF)
            ? fs.readFileSync(CLIENTS_CONF, 'utf8') : '';

        // Hapus blok dari marker billing sampai akhir
        const MARKER = '\n# === NETBILL AUTO-GENERATED ===';
        const markerIdx = original.indexOf(MARKER);
        if (markerIdx !== -1) original = original.slice(0, markerIdx);

        // Tulis ulang dengan semua NAS dari DB
        const blocks = rows.map(n => {
            const name   = (n.shortname || n.nasname).replace(/[^a-zA-Z0-9_]/g, '_');
            const ipaddr = String(n.nasname).replace(/[^a-zA-Z0-9.:_-]/g, '');     // hanya IP/host
            const secret = String(n.secret).replace(/[\r\n{}"]/g, '');             // cegah break config
            return `\nclient ${name} {\n    ipaddr = ${ipaddr}\n    secret = ${secret}\n    shortname = ${name}\n}`;
        }).join('\n');

        fs.writeFileSync(CLIENTS_CONF,
            original + MARKER + '\n' + blocks + '\n# === END NETBILL ===\n',
            { mode: 0o640 });

        // Reload FreeRADIUS agar langsung aktif
        execP('systemctl reload freeradius 2>/dev/null || systemctl restart freeradius 2>/dev/null')
            .catch(() => {});

        console.log(`[clients.conf] Synced ${rows.length} NAS`);
    } catch(e) {
        console.warn('[clients.conf] Sync gagal:', e.message);
    }
}

router.post('/nas', requireAdmin, async (req, res, next) => {
    try {
        const { nasname, shortname, type, secret, description } = req.body;
        if (!nasname || !secret)
            return res.status(400).json({ error: 'nasname dan secret wajib diisi' });
        if (!validNasHost(nasname))
            return res.status(400).json({ error: 'nasname harus berupa IP atau hostname valid (tanpa spasi/karakter aneh)' });
        if (/[\r\n]/.test(secret))
            return res.status(400).json({ error: 'secret tidak boleh mengandung baris baru' });

        await query(
            `INSERT INTO nas (nasname, shortname, type, secret, description) VALUES (?,?,?,?,?)`,
            [nasname, shortname || null, type || 'other', secret, description || shortname || null]
        );

        // Sync ke clients.conf agar FreeRADIUS langsung mengenali NAS baru
        syncClientsConf();

        res.status(201).json({ pesan: 'NAS ditambahkan' });
    } catch (e) { next(e); }
});

// PUT /api/radius/nas/:id — edit NAS
router.put('/nas/:id', requireAdmin, async (req, res, next) => {
    try {
        const { nasname, shortname, type, secret, description, community, ports } = req.body;
        if (!nasname || !secret)
            return res.status(400).json({ error: 'nasname dan secret wajib diisi' });
        if (!validNasHost(nasname))
            return res.status(400).json({ error: 'nasname harus berupa IP atau hostname valid (tanpa spasi/karakter aneh)' });
        if (/[\r\n]/.test(secret))
            return res.status(400).json({ error: 'secret tidak boleh mengandung baris baru' });
        await query(
            `UPDATE nas SET nasname=?, shortname=?, type=?, secret=?, description=?, community=?, ports=? WHERE id=?`,
            [nasname, shortname || null, type || 'other', secret, description || shortname || null,
             community || null, ports || null, req.params.id]
        );
        syncClientsConf();
        res.json({ pesan: 'NAS diperbarui' });
    } catch (e) { next(e); }
});

router.delete('/nas/:id', requireAdmin, async (req, res, next) => {
    try {
        await query('DELETE FROM nas WHERE id=?', [req.params.id]);

        // Sync ke clients.conf agar NAS yang dihapus tidak bisa autentikasi lagi
        syncClientsConf();

        res.json({ pesan: 'NAS dihapus' });
    } catch (e) { next(e); }
});

// ============================================================
// VPN ACCOUNTS
// ============================================================

// GET /api/radius/vpn — list semua akun VPN
router.get('/vpn', authMiddleware, async (req, res, next) => {
    try {
        const rows = await query(`
            SELECT v.*, n.shortname AS nas_nama
            FROM vpn_account v
            LEFT JOIN nas n ON v.nas_id = n.id
            ORDER BY v.created_at DESC
        `);
        // Sensor password & PSK
        const safe = rows.map(r => ({
            ...r,
            password:  r.password  ? '••••••' : '',
            ipsec_psk: r.ipsec_psk ? '••••••' : ''
        }));
        res.json(safe);
    } catch (e) { next(e); }
});

// POST /api/radius/vpn — tambah akun VPN
router.post('/vpn', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        const { nama, protokol, server, port, username, password,
                pubkey, allowed_ips, ipsec_psk, nas_id, catatan } = req.body;
        if (!nama || !server || !username)
            return res.status(400).json({ error: 'nama, server, username wajib diisi' });
        const result = await query(`
            INSERT INTO vpn_account
              (nama, protokol, server, port, username, password, pubkey, allowed_ips, ipsec_psk, nas_id, catatan)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `, [nama, protokol||'wireguard', server, port||51820, username,
            password||null, pubkey||null, allowed_ips||'0.0.0.0/0',
            ipsec_psk||null, nas_id||null, catatan||null]);
        res.json({ id: result.insertId, pesan: 'Akun VPN berhasil ditambahkan' });
    } catch (e) { next(e); }
});

// PUT /api/radius/vpn/:id — update status (aktif/nonaktif)
router.put('/vpn/:id', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        const { status } = req.body;
        await query('UPDATE vpn_account SET status=? WHERE id=?', [status, req.params.id]);
        res.json({ pesan: 'Status VPN diperbarui' });
    } catch (e) { next(e); }
});

// DELETE /api/radius/vpn/:id — hapus akun VPN
router.delete('/vpn/:id', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        await query('DELETE FROM vpn_account WHERE id=?', [req.params.id]);
        res.json({ pesan: 'Akun VPN dihapus' });
    } catch (e) { next(e); }
});

// ============================================================
// VPN SERVER MANAGEMENT — WireGuard & L2TP/IPSec
// ============================================================
const { exec, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const WG_IFACE     = 'wg0';
const WG_SUBNET    = '10.10.28';
const WG_PORT      = 51820;
const WG_CONF      = `/etc/wireguard/${WG_IFACE}.conf`;
const L2TP_SECRETS = '/etc/ppp/chap-secrets';
const IPSEC_CONF   = '/etc/ipsec.secrets';

// ── Validator input VPN (cegah injeksi baris ke file config) ──
// File .conf / chap-secrets bersifat line-based: input yang mengandung
// newline atau karakter delimiter bisa menyelipkan direktif/akun palsu.
const RX_WG_PUBKEY  = /^[A-Za-z0-9+/]{43}=$/;            // 32-byte base64
const RX_IP_CIDR    = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/;
const RX_USERNAME   = /^[A-Za-z0-9._@-]{1,64}$/;
function ipv4Valid(s) {
    if (s === '*') return true;
    if (!RX_IP_CIDR.test(s)) return false;
    return s.split('/')[0].split('.').every(o => +o >= 0 && +o <= 255);
}
function allowedIpsValid(s) {
    return String(s).split(',').map(x => x.trim()).filter(Boolean).every(ipv4Valid);
}
// Bersihkan teks bebas (nama/catatan) agar tak memuat newline / pemisah config.
function teksAman(s, maks = 100) {
    return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').slice(0, maks).trim();
}
// Tolak whitespace/newline pada field yang ditulis ke baris delimited.
function tanpaWhitespace(s) {
    return typeof s === 'string' && s.length > 0 && !/[\s]/.test(s);
}

function execP(cmd, opts={}) {
    return new Promise((res, rej) => {
        exec(cmd, { timeout: 60000, ...opts }, (err, stdout, stderr) => {
            if (err) rej(new Error(stderr || err.message));
            else res(stdout.trim());
        });
    });
}

function isInstalled(bin) {
    try { execSync(`which ${bin}`, {stdio:'pipe'}); return true; } catch { return false; }
}

function isRunning(service) {
    try {
        const out = execSync(`systemctl is-active ${service} 2>/dev/null`, {stdio:'pipe'}).toString().trim();
        return out === 'active';
    } catch { return false; }
}

// Deteksi IP publik server (untuk connect-to / endpoint di script MikroTik).
// Prioritas: env VPS_PUBLIC_IP → setting server_ip/vps_public_ip → cek eksternal
// (penting untuk VPS cloud ber-NAT yang interface-nya hanya ber-IP privat) →
// auto-deteksi src lokal (HANYA jika publik) → row.server (jika publik).
function _isPrivateIp(ip) {
    if (!ip) return true;
    if (ip.startsWith('127.') || ip.startsWith('169.254.') ||
        ip.startsWith('10.')  || ip.startsWith('192.168.')) return true;
    const p = ip.split('.').map(Number);
    if (p[0] === 172 && p[1] >= 16  && p[1] <= 31)  return true;   // 172.16–31.x
    if (p[0] === 100 && p[1] >= 64  && p[1] <= 127) return true;   // CGNAT 100.64/10
    return false;
}
function _deteksiIpPublikEksternal() {
    const urls = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];
    for (const u of urls) {
        try {
            const out = execSync(`curl -fsS --max-time 4 ${u} 2>/dev/null`, { stdio: 'pipe' }).toString().trim();
            const m = out.match(/(\d+\.\d+\.\d+\.\d+)/);
            if (m && m[1] && !_isPrivateIp(m[1])) return m[1];
        } catch (_) {}
    }
    return null;
}
function _deteksiIpPublikLokal() {
    try {
        const out = execSync('ip -4 route get 1.1.1.1 2>/dev/null', { stdio: 'pipe' }).toString();
        const m = out.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
        if (m && m[1] && !_isPrivateIp(m[1])) return m[1];   // hanya terima IP publik
    } catch (_) {}
    return null;
}
async function serverPublicIp(rowServer) {
    if (process.env.VPS_PUBLIC_IP) return process.env.VPS_PUBLIC_IP.trim();
    try {
        const s = await queryOne(
            "SELECT nilai FROM setting WHERE kunci IN ('server_ip','vps_public_ip') AND nilai<>'' LIMIT 1");
        if (s && s.nilai) return String(s.nilai).trim();
    } catch (_) {}
    // VPS cloud sering ber-NAT (IP interface = privat). Cek IP publik nyata dulu.
    const ext = _deteksiIpPublikEksternal();
    if (ext) return ext;
    const local = _deteksiIpPublikLokal();
    if (local) return local;
    if (rowServer && !_isPrivateIp(rowServer) && rowServer !== 'localhost') return rowServer;
    return null;
}

// GET /api/radius/vpn/mikrotik-script/:id — generate RouterOS script
router.get('/vpn/mikrotik-script/:id', authMiddleware, async (req, res, next) => {
    try {
        const row = await queryOne('SELECT * FROM vpn_account WHERE id=?', [req.params.id]);
        if (!row) return res.status(404).json({ error: 'VPN tidak ditemukan' });

        // Ambil IP server VPS (env → setting → auto-deteksi → row.server non-loopback)
        const serverIp = (await serverPublicIp(row.server)) || '(IP-SERVER-VPS)';
        let script = '';

        if (row.protokol === 'l2tp') {
            script = `/interface l2tp-client
remove [find name="l2tp-netbill"]
/interface l2tp-client
add name="l2tp-netbill" \\
    connect-to=${serverIp} \\
    user="${row.username}" \\
    password="${row.password || '(password)'}" \\
    profile=default \\
    use-ipsec=no \\
    disabled=no`;
        } else if (row.protokol === 'wireguard') {
            // Baca server public key dari setting
            let serverPubkey = '(SERVER-PUBLIC-KEY)';
            try {
                const setting = await queryOne("SELECT nilai FROM setting WHERE kunci='wg_server_pubkey'");
                if (setting) serverPubkey = setting.nilai;
            } catch {}

            const tunnelIp = (row.allowed_ips || '10.10.28.2/32').split(',')[0].trim();

            script = `/interface wireguard
remove [find name="wg-netbill"]
/ip address
remove [find comment="netbill-wg-ip"]
/interface wireguard peers
remove [find comment="netbill-wg-peer"]

/interface wireguard
add name="wg-netbill" private-key="${row.password || '(PRIVATE-KEY-PEER)'}" listen-port=13231

/ip address
add address=${tunnelIp} interface="wg-netbill" comment="netbill-wg-ip"

/interface wireguard peers
add interface="wg-netbill" \\
    public-key="${serverPubkey}" \\
    endpoint-address=${serverIp} \\
    endpoint-port=${row.port || WG_PORT} \\
    allowed-address=${row.allowed_ips || '10.10.28.0/24'} \\
    persistent-keepalive=25 \\
    comment="netbill-wg-peer"`;
        }

        res.json({ script, protokol: row.protokol, nama: row.nama });
    } catch(e) { next(e); }
});

// GET /api/radius/vpn/wg/status
router.get('/vpn/wg/status', authMiddleware, async (req, res) => {
    const installed = isInstalled('wg');
    const running   = installed && isRunning(`wg-quick@${WG_IFACE}`);
    let peers = [];
    if (running) {
        try {
            const raw = execSync(`wg show ${WG_IFACE} dump`, {stdio:'pipe'}).toString().trim().split('\n').slice(1);
            peers = raw.filter(Boolean).map(line => {
                const [pubkey,,,,allowed,latest,rx,tx] = line.split('\t');
                return { pubkey, allowed, latest: latest==='0'?'Belum pernah':new Date(+latest*1000).toLocaleString('id-ID'), rx, tx };
            });
        } catch {}
    }
    res.json({ installed, running, peers });
});

// GET /api/radius/vpn/l2tp/status
router.get('/vpn/l2tp/status', authMiddleware, async (req, res) => {
    const installed = isInstalled('xl2tpd') && isInstalled('ipsec');
    const swanRunning = isRunning('strongswan-starter') || isRunning('ipsec') || isRunning('strongswan');
    const running   = installed && isRunning('xl2tpd') && swanRunning;

    // Ambil user dari DB (lebih reliable dari parsing file)
    let users = [];
    try {
        const rows = await query(`SELECT username, password, catatan FROM vpn_account WHERE protokol='l2tp' AND status='aktif' ORDER BY id`);
        // Baca IP & password dari chap-secrets sebagai fallback
        const ipMap  = {};
        const pwMap  = {};
        if (fs.existsSync(L2TP_SECRETS)) {
            fs.readFileSync(L2TP_SECRETS,'utf8').split('\n')
              .filter(l => l.trim() && !l.startsWith('#'))
              .forEach(l => {
                  const p = l.trim().split(/\s+/);
                  if (p[0]) {
                      pwMap[p[0]] = p[2] || '';   // kolom ke-3 = password
                      ipMap[p[0]] = p[3] || '*';  // kolom ke-4 = ip
                  }
              });
        }
        users = rows.map(r => ({
            id:       r.id,
            username: r.username,
            password: r.password || pwMap[r.username] || '',
            ip:       ipMap[r.username] || '*'
        }));

        // Update password di DB kalau ada yang kosong tapi ada di file
        for (const r of rows) {
            if (!r.password && pwMap[r.username]) {
                await query(`UPDATE vpn_account SET password=? WHERE username=? AND protokol='l2tp'`,
                    [pwMap[r.username], r.username]).catch(()=>{});
            }
        }
    } catch(e) {
        // DB tabel belum ada — baca dari file saja
        if (fs.existsSync(L2TP_SECRETS)) {
            const lines = fs.readFileSync(L2TP_SECRETS,'utf8').split('\n');
            users = lines.filter(l => l.trim() && !l.startsWith('#'))
                .map(l => { const p=l.trim().split(/\s+/); return { username:p[0], password:p[2]||'', ip:p[3]||'*' }; });
        }
    }
    res.json({ installed, running, users });
});

// POST /api/radius/vpn/wg/install
router.post('/vpn/wg/install', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        res.json({ pesan: 'Instalasi WireGuard dimulai di background...' });
        // Jalankan async setelah response terkirim
        setImmediate(async () => {
            try {
                await execP('apt-get update -qq && apt-get install -y wireguard wireguard-tools 2>&1');
                // Generate server keys kalau belum ada
                if (!fs.existsSync(WG_CONF)) {
                    const privkey = execSync('wg genkey').toString().trim();
                    const pubkey  = execSync(`echo "${privkey}" | wg pubkey`).toString().trim();
                    // Deteksi interface utama
                    const mainIface = execSync("ip route | grep default | awk '{print $5}' | head -1").toString().trim() || 'eth0';
                    const conf = `[Interface]
PrivateKey = ${privkey}
Address = ${WG_SUBNET}.1/24
ListenPort = ${WG_PORT}
PostUp = iptables -A FORWARD -i ${WG_IFACE} -j ACCEPT; iptables -t nat -A POSTROUTING -o ${mainIface} -j MASQUERADE
PostDown = iptables -D FORWARD -i ${WG_IFACE} -j ACCEPT; iptables -t nat -D POSTROUTING -o ${mainIface} -j MASQUERADE
`;
                    fs.writeFileSync(WG_CONF, conf, {mode:0o600});
                    // Simpan pubkey server ke setting
                    const { query } = require('../config/db');
                    await query(`INSERT INTO setting (kunci,nilai,deskripsi) VALUES ('wg_server_pubkey',?,'WireGuard server public key') ON DUPLICATE KEY UPDATE nilai=?`, [pubkey,pubkey]);
                }
                await execP(`systemctl enable wg-quick@${WG_IFACE} && systemctl start wg-quick@${WG_IFACE}`);
                console.log('[WireGuard] Install & start selesai');
            } catch(e) { console.error('[WireGuard install]', e.message); }
        });
    } catch(e) { next(e); }
});

// POST /api/radius/vpn/wg/toggle — start/stop
router.post('/vpn/wg/toggle', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        const action = req.body.action === 'start' ? 'start' : 'stop';
        await execP(`systemctl ${action} wg-quick@${WG_IFACE}`);
        res.json({ pesan: `WireGuard ${action === 'start' ? 'diaktifkan' : 'dimatikan'}` });
    } catch(e) { next(e); }
});

// POST /api/radius/vpn/wg/peer — tambah peer
router.post('/vpn/wg/peer', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        let { nama, ip_tunnel, pubkey, allowed_ips, catatan } = req.body;
        if (!nama || !ip_tunnel || !pubkey)
            return res.status(400).json({ error: 'nama, ip_tunnel, pubkey wajib diisi' });

        // ── Validasi (cegah injeksi direktif ke wg0.conf) ──
        pubkey = String(pubkey).trim();
        if (!RX_WG_PUBKEY.test(pubkey))
            return res.status(400).json({ error: 'PublicKey WireGuard tidak valid (harus base64 44 karakter)' });
        if (!ipv4Valid(String(ip_tunnel).trim()))
            return res.status(400).json({ error: 'ip_tunnel bukan IPv4/CIDR yang valid' });
        if (allowed_ips && !allowedIpsValid(allowed_ips))
            return res.status(400).json({ error: 'allowed_ips tidak valid (IPv4/CIDR, pisah koma)' });
        ip_tunnel = String(ip_tunnel).trim();
        nama      = teksAman(nama, 64);
        catatan   = catatan ? teksAman(catatan, 120) : '';
        if (!nama) return res.status(400).json({ error: 'nama tidak valid' });

        const peerConf = `\n# Peer: ${nama}${catatan?' — '+catatan:''}\n[Peer]\nPublicKey = ${pubkey}\nAllowedIPs = ${ip_tunnel}\n`;
        fs.appendFileSync(WG_CONF, peerConf);

        // Hot-reload kalau interface sedang jalan
        if (isRunning(`wg-quick@${WG_IFACE}`)) {
            await execP(`wg addconf ${WG_IFACE} <(wg-quick strip ${WG_IFACE})`).catch(async () => {
                await execP(`wg syncconf ${WG_IFACE} <(wg-quick strip ${WG_IFACE})`).catch(()=>{});
            });
        }

        // Simpan ke DB juga
        await query(`INSERT INTO vpn_account (nama,protokol,server,port,username,pubkey,allowed_ips,catatan,status) VALUES (?,?,?,?,?,?,?,?,'aktif')`,
            [nama,'wireguard',WG_SUBNET+'.1',WG_PORT,nama,pubkey,allowed_ips||ip_tunnel,catatan||null]);

        res.json({ pesan: `Peer "${nama}" berhasil ditambahkan` });
    } catch(e) { next(e); }
});

// DELETE /api/radius/vpn/wg/peer/:pubkey — hapus peer
router.delete('/vpn/wg/peer/:id', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        // Ambil pubkey dari DB
        const row = await queryOne('SELECT * FROM vpn_account WHERE id=? AND protokol=?', [req.params.id,'wireguard']);
        if (!row) return res.status(404).json({ error: 'Peer tidak ditemukan' });

        // Hapus dari konfigurasi file
        if (fs.existsSync(WG_CONF)) {
            let conf = fs.readFileSync(WG_CONF,'utf8');
            // Hapus blok [Peer] yang mengandung public key ini
            conf = conf.replace(new RegExp(`\\n# Peer:.*?\\n\\[Peer\\]\\nPublicKey = ${row.pubkey.replace(/[+/]/g,'\\$&')}[^\\[]*`,'s'),'');
            fs.writeFileSync(WG_CONF, conf, {mode:0o600});
        }
        // Hot-remove
        if (isRunning(`wg-quick@${WG_IFACE}`)) {
            await execP(`wg set ${WG_IFACE} peer ${row.pubkey} remove`).catch(()=>{});
        }
        await query('DELETE FROM vpn_account WHERE id=?', [req.params.id]);
        res.json({ pesan: `Peer berhasil dihapus` });
    } catch(e) { next(e); }
});

// POST /api/radius/vpn/l2tp/install
router.post('/vpn/l2tp/install', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        res.json({ pesan: 'Instalasi L2TP/IPSec dimulai di background...' });
        setImmediate(async () => {
            try {
                await execP('apt-get update -qq && apt-get install -y xl2tpd strongswan strongswan-pki libstrongswan-standard-plugins 2>&1');
                // Konfigurasi dasar IPSec
                const ipsecConf = `config setup\n    charondebug="ike 1, knl 1, cfg 0"\nconn L2TP-PSK\n    authby=secret\n    left=%any\n    right=%any\n    auto=add\n`;
                if (!fs.existsSync('/etc/ipsec.conf')) fs.writeFileSync('/etc/ipsec.conf', ipsecConf);
                if (!fs.existsSync(IPSEC_CONF)) fs.writeFileSync(IPSEC_CONF, `: PSK "changeme_psk"\n`, {mode:0o600});
                // xl2tpd config dasar
                const xl2tpConf = `[global]\n[lns default]\n  ip range = 10.10.29.10-10.10.29.100\n  local ip = 10.10.29.1\n  require chap = yes\n  refuse pap = no\n  require authentication = yes\n  ppp debug = yes\n  pppoptfile = /etc/ppp/options.l2tpd.lns\n  length bit = yes\n`;
                // Selalu timpa xl2tpd.conf dengan konfigurasi bersih (bawaan Ubuntu penuh comment)
                fs.mkdirSync('/etc/xl2tpd', {recursive:true});
                fs.writeFileSync('/etc/xl2tpd/xl2tpd.conf', xl2tpConf);
                console.log('[L2TP] xl2tpd.conf ditulis ulang');
                // Buat file options PPP — opsi modem (crtscts/lock/idle) DIBUANG
                // karena tidak valid untuk L2TP dan membuat pppd keluar (exit 2)
                // tiap tunnel terbentuk. mtu/mru 1400 penting di VPS ber-NAT.
                const pppOpts = `ipcp-accept-local\nipcp-accept-remote\nrequire-chap\nrefuse-pap\nauth\nname l2tpd\nms-dns 8.8.8.8\nms-dns 1.1.1.1\nasyncmap 0\nnoccp\nnodefaultroute\nproxyarp\nmtu 1400\nmru 1400\nlcp-echo-interval 30\nlcp-echo-failure 4\nconnect-delay 5000\n`;
                // Selalu timpa agar file lama yang berisi opsi rusak ikut diperbaiki.
                fs.writeFileSync('/etc/ppp/options.l2tpd.lns', pppOpts);
                console.log('[L2TP] File options.l2tpd.lns ditulis ulang (bersih)');
                // Prasyarat jaringan untuk L2TP:
                // 1) IP forwarding (tanpa ini, trafik via tunnel tidak diteruskan)
                try {
                    execSync('sysctl -w net.ipv4.ip_forward=1', { stdio: 'pipe' });
                    fs.writeFileSync('/etc/sysctl.d/99-simbill-l2tp.conf', 'net.ipv4.ip_forward=1\n');
                } catch (e) { console.warn('[L2TP] set ip_forward gagal:', e.message); }
                // 2) Buka UDP 1701 di firewall lokal (idempotent) + balasan PPP.
                //    Banyak VPS punya INPUT policy DROP → SCCRQ dari MikroTik diblok.
                try {
                    execSync("iptables -C INPUT -p udp --dport 1701 -j ACCEPT 2>/dev/null || iptables -I INPUT -p udp --dport 1701 -j ACCEPT", { stdio: 'pipe' });
                    execSync("iptables -C INPUT -i ppp+ -j ACCEPT 2>/dev/null || iptables -I INPUT -i ppp+ -j ACCEPT", { stdio: 'pipe' });
                    execSync("command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save 2>/dev/null || true", { stdio: 'pipe' });
                } catch (e) { console.warn('[L2TP] buka UDP 1701 gagal:', e.message); }

                // Enable & start — deteksi nama service strongswan
                const swanSvc = (() => {
                    try { execSync('systemctl list-unit-files strongswan-starter.service 2>/dev/null | grep enabled', {stdio:'pipe'}); return 'strongswan-starter'; }
                    catch { return 'strongswan-starter'; } // Ubuntu 22/24 default
                })();
                await execP(`systemctl enable xl2tpd ${swanSvc} && systemctl start xl2tpd ${swanSvc}`);
                console.log('[L2TP] Install & start selesai, service: '+swanSvc);
            } catch(e) { console.error('[L2TP install]', e.message); }
        });
    } catch(e) { next(e); }
});

// POST /api/radius/vpn/l2tp/toggle
router.post('/vpn/l2tp/toggle', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        const action = req.body.action === 'start' ? 'start' : 'stop';
        // Deteksi nama service strongSwan yang TERINSTALL (bukan sekadar yang sedang
        // berjalan). Pakai list-unit-files agar service yang terinstall tapi belum
        // pernah dijalankan tetap terdeteksi. Ubuntu 22/24 = strongswan-starter,
        // versi lain = strongswan / ipsec.
        const swanService = (() => {
            for (const svc of ['strongswan-starter', 'strongswan', 'ipsec']) {
                try {
                    execSync(`systemctl list-unit-files ${svc}.service 2>/dev/null | grep -q ${svc}.service`, { stdio:'pipe' });
                    return svc;
                } catch {}
            }
            return 'strongswan-starter'; // default Ubuntu 22/24
        })();
        await execP(`systemctl ${action} xl2tpd ${swanService}`);
        res.json({ pesan: `L2TP/IPSec ${action === 'start' ? 'diaktifkan' : 'dimatikan'} (${swanService})` });
    } catch(e) { next(e); }
});

// POST /api/radius/vpn/l2tp/user — tambah user L2TP
router.post('/vpn/l2tp/user', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        const { username, password, ip } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'username dan password wajib' });

        // ── Validasi (chap-secrets dipisah spasi; tolak whitespace/newline) ──
        if (!RX_USERNAME.test(username))
            return res.status(400).json({ error: 'username hanya boleh huruf/angka . _ @ - (maks 64)' });
        if (!tanpaWhitespace(password) || password.length > 128)
            return res.status(400).json({ error: 'password tidak boleh mengandung spasi/baris baru (maks 128 karakter)' });
        if (ip && !ipv4Valid(String(ip).trim()))
            return res.status(400).json({ error: 'ip bukan IPv4 yang valid' });

        // Pastikan direktori /etc/ppp ada
        const secretsDir = path.dirname(L2TP_SECRETS);
        if (!fs.existsSync(secretsDir)) {
            fs.mkdirSync(secretsDir, { recursive: true });
            console.log('[L2TP] Direktori /etc/ppp dibuat');
        }

        // Buat file chap-secrets dengan header jika belum ada
        if (!fs.existsSync(L2TP_SECRETS)) {
            fs.writeFileSync(L2TP_SECRETS,
                '# Secrets for L2TP VPN\n# username  server  password  ip\n',
                { mode: 0o600 });
            console.log('[L2TP] File chap-secrets dibuat baru');
        }

        // Cek duplikat
        const existing = fs.readFileSync(L2TP_SECRETS, 'utf8');
        if (existing.split('\n').some(l => l.trim().startsWith(username + ' '))) {
            return res.status(409).json({ error: `Username "${username}" sudah ada` });
        }

        // Tulis ke chap-secrets — format: username * password ip
        const ipValue = (ip && ip !== '*') ? ip : '*';
        const line = `${username} * ${password} ${ipValue}\n`;
        fs.appendFileSync(L2TP_SECRETS, line, { mode: 0o600 });

        // Verifikasi berhasil ditulis
        const verify = fs.readFileSync(L2TP_SECRETS, 'utf8');
        if (!verify.includes(username)) {
            return res.status(500).json({ error: 'Gagal menulis ke /etc/ppp/chap-secrets' });
        }
        console.log(`[L2TP] User "${username}" ditambahkan ke chap-secrets`);

        // Reload xl2tpd agar user langsung aktif tanpa restart
        execP('systemctl reload xl2tpd 2>/dev/null || systemctl restart xl2tpd 2>/dev/null')
            .catch(e => console.warn('[L2TP] Reload gagal:', e.message));

        // Simpan ke DB
        const srvIp = (await serverPublicIp(null)) || '127.0.0.1';
        try {
            await query(`INSERT INTO vpn_account (nama,protokol,server,port,username,password,status) VALUES (?,?,?,?,?,?,'aktif')`,
                [username, 'l2tp', srvIp, 1701, username, password]);
        } catch (dbErr) {
            if (dbErr.message && dbErr.message.includes('vpn_account')) {
                await query(`CREATE TABLE IF NOT EXISTS vpn_account (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    nama VARCHAR(100) NOT NULL,
                    protokol ENUM('wireguard','l2tp') NOT NULL DEFAULT 'wireguard',
                    server VARCHAR(255) NOT NULL,
                    port INT NOT NULL DEFAULT 51820,
                    username VARCHAR(100) NOT NULL,
                    password TEXT,
                    pubkey TEXT,
                    allowed_ips VARCHAR(255) DEFAULT '0.0.0.0/0',
                    ipsec_psk TEXT,
                    nas_id INT DEFAULT NULL,
                    status ENUM('aktif','nonaktif') NOT NULL DEFAULT 'aktif',
                    catatan TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                ) ENGINE=InnoDB`);
                await query(`INSERT INTO vpn_account (nama,protokol,server,port,username,password,status) VALUES (?,?,?,?,?,?,'aktif')`,
                    [username, 'l2tp', srvIp, 1701, username, password]);
            } else { throw dbErr; }
        }

        res.json({ pesan: `User "${username}" berhasil ditambahkan dan xl2tpd direload` });
    } catch(e) { next(e); }
});

// DELETE /api/radius/vpn/l2tp/user/:id
router.delete('/vpn/l2tp/user/:id', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        const row = await queryOne('SELECT * FROM vpn_account WHERE id=? AND protokol=?', [req.params.id,'l2tp']);
        if (!row) return res.status(404).json({ error: 'User tidak ditemukan' });

        // Hapus dari chap-secrets
        if (fs.existsSync(L2TP_SECRETS)) {
            const lines = fs.readFileSync(L2TP_SECRETS,'utf8').split('\n')
                .filter(l => !l.trim().startsWith(row.username + ' '));
            fs.writeFileSync(L2TP_SECRETS, lines.join('\n'));
        }

        // Reload xl2tpd
        execP('systemctl reload xl2tpd 2>/dev/null || systemctl restart xl2tpd 2>/dev/null')
            .catch(e => console.warn('[L2TP] Reload gagal:', e.message));

        await query('DELETE FROM vpn_account WHERE id=?', [req.params.id]);
        res.json({ pesan: `User "${row.username}" berhasil dihapus` });
    } catch(e) { next(e); }
});

// POST /api/radius/vpn/wg/genkey — generate keypair server-side
router.post('/vpn/wg/genkey', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        const privkey = (await execP('wg genkey')).trim();
        const pubkey  = (await execP(`echo "${privkey}" | wg pubkey`)).trim();
        res.json({ privkey, pubkey });
    } catch(e) {
        // WireGuard belum install
        res.status(503).json({ error: 'WireGuard belum terinstall. Install dulu dari panel VPN.' });
    }
});

// POST /api/radius/single-session — aktifkan/nonaktifkan single session enforcement
// Cara kerja: insert/delete atribut Simultaneous-Use := 1 di tabel radcheck
// untuk semua username yang terdaftar di tabel pelanggan.
router.post('/single-session', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        const enabled = req.body.enabled === true || req.body.enabled === 'true';

        if (enabled) {
            // Hapus entry lama dulu (hindari duplikat), lalu insert untuk semua pelanggan aktif
            await query(`DELETE FROM radcheck WHERE attribute = 'Simultaneous-Use'`);
            await query(`
                INSERT INTO radcheck (username, attribute, op, value)
                SELECT username, 'Simultaneous-Use', ':=', '1'
                FROM pelanggan
                WHERE status = 'aktif' AND username IS NOT NULL AND username != ''
            `);
            const [{ total }] = await query(`SELECT COUNT(*) AS total FROM radcheck WHERE attribute = 'Simultaneous-Use'`);
            res.json({ pesan: `Single session enabled — ${total} user diterapkan`, total });
        } else {
            // Dimatikan = kembalikan ke batas per-paket (Shared Users), BUKAN tanpa batas.
            const radiusSvc = require('../services/radius');
            await radiusSvc.syncSimultaneousUseSemua();
            const [{ total }] = await query(`SELECT COUNT(*) AS total FROM radcheck WHERE attribute = 'Simultaneous-Use'`);
            res.json({ pesan: `Single session disabled — batas dikembalikan ke Shared Users tiap paket (${total} user)`, total });
        }
    } catch (e) { next(e); }
});

// POST /api/radius/sync-share — terapkan ulang batas Shared Users (Simultaneous-Use)
// ke seluruh voucher non-expired + pelanggan aktif sesuai paketnya. Berguna untuk
// menerapkan ke data lama setelah kolom share_users ditambahkan/diubah.
router.post('/sync-share', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        const radiusSvc = require('../services/radius');
        await radiusSvc.syncSimultaneousUseSemua();
        const [{ total }] = await query(`SELECT COUNT(*) AS total FROM radcheck WHERE attribute = 'Simultaneous-Use'`);
        res.json({ pesan: `Shared Users diterapkan ke ${total} user`, total });
    } catch (e) { next(e); }
});

// POST /api/radius/sync-radcheck — sync semua pelanggan ke radcheck
router.post('/sync-radcheck', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        const { decryptPassword } = require('../services/radius');
        const rows = await query(`SELECT username, radius_password_enc FROM pelanggan WHERE status='aktif' AND radius_password_enc IS NOT NULL`);
        let sukses = 0, gagal = 0;
        for (const r of rows) {
            try {
                const plain = decryptPassword(r.radius_password_enc);
                if (!plain) { gagal++; continue; }
                await query(`
                    INSERT INTO radcheck (username, attribute, op, value)
                    VALUES (?, 'Cleartext-Password', ':=', ?)
                    ON DUPLICATE KEY UPDATE value = VALUES(value)
                `, [r.username, plain]);
                sukses++;
            } catch(e) { gagal++; }
        }
        res.json({ pesan: `Sync selesai — ${sukses} berhasil, ${gagal} gagal (password belum diset)`, sukses, gagal });
    } catch(e) { next(e); }
});

// POST /api/radius/restart — restart FreeRADIUS service
router.post('/restart', authMiddleware, requireAdmin, async (req, res, next) => {
    try {
        const { exec } = require('child_process');
        // Coba systemctl dulu, lalu service sebagai fallback
        const cmd = 'sudo systemctl restart freeradius 2>/dev/null || sudo service freeradius restart 2>/dev/null || sudo systemctl restart radiusd 2>/dev/null';
        exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
            if (err) {
                console.warn('[RADIUS restart]', err.message, stderr);
                return res.status(500).json({
                    error: 'Gagal restart RADIUS: ' + (stderr || err.message) +
                           '. Pastikan user Node.js punya sudo tanpa password untuk perintah ini.'
                });
            }
            console.log('[RADIUS restart] Berhasil:', stdout || 'ok');
            res.json({ pesan: 'FreeRADIUS berhasil direstart' });
        });
    } catch (e) { next(e); }
});

// ── GET /api/radius/snmp-traffic — ambil data SNMP dari NAS ──
router.get('/snmp-traffic', async (req, res, next) => {
    try {
        const nasId   = req.query.nas_id;
        const ifIndex = req.query.if_index || null; // index interface dari query param

        let nas;
        if (nasId) {
            nas = await queryOne('SELECT * FROM nas WHERE id=?', [nasId]);
        } else {
            nas = await queryOne('SELECT * FROM nas LIMIT 1');
        }
        if (!nas) return res.status(404).json({ error: 'NAS tidak ditemukan' });

        const community = nas.community || 'public';
        const host      = nas.nasname;

        // Pakai ifIndex dari query, dari setting NAS, atau default 95 (Ether1-Metroe)
        const idx = ifIndex || nas.ports || '95';

        // Counter 64-bit (ifHCInOctets/ifHCOutOctets) — WAJIB untuk link >~100 Mbps.
        // Counter 32-bit (ifInOctets .2.2.1.10) wrap tiap ~57 dtk di 600 Mbps → angka
        // ngaco/spike. Yang 64-bit praktis tak pernah wrap.
        const oids = [
            `1.3.6.1.2.1.31.1.1.1.6.${idx}`,   // ifHCInOctets (64-bit)
            `1.3.6.1.2.1.31.1.1.1.10.${idx}`,  // ifHCOutOctets (64-bit)
            `1.3.6.1.2.1.2.2.1.5.${idx}`,      // ifSpeed
            `1.3.6.1.2.1.2.2.1.2.${idx}`,      // ifDescr (nama interface)
            '1.3.6.1.2.1.1.3.0',                // sysUpTime
        ];

        const snmp = require('net-snmp');
        const session = snmp.createSession(host, community, {
            timeout: 5000,
            retries: 1,
            version: snmp.Version2c
        });

        session.get(oids, function(error, varbinds) {
            session.close();
            if (error) {
                return res.status(502).json({ error: 'SNMP gagal: ' + error.message });
            }
            const result = {};
            varbinds.forEach(function(vb) {
                if (!snmp.isVarbindError(vb)) result[vb.oid] = vb.value; // simpan mentah
            });
            // Counter64 dikembalikan net-snmp sebagai Buffer 8-byte → decode via BigInt.
            const snmpCounter = (v) => {
                if (v == null) return 0;
                if (Buffer.isBuffer(v)) { try { return Number(BigInt('0x' + v.toString('hex'))); } catch { return 0; } }
                const n = Number(typeof v === 'object' ? v.toString() : v);
                return Number.isFinite(n) ? n : 0;
            };
            const snmpText = (v) => Buffer.isBuffer(v)
                ? v.toString('utf8').replace(/[\x00-\x1F\x7F]/g, '')
                : (v == null ? '' : String(v));
            res.json({
                nas_id:      nas.id,
                nas_name:    nas.shortname,
                host:        host,
                if_index:    idx,
                if_name:     snmpText(result[`1.3.6.1.2.1.2.2.1.2.${idx}`]) || `if${idx}`,
                in_octets:   snmpCounter(result[`1.3.6.1.2.1.31.1.1.1.6.${idx}`]),
                out_octets:  snmpCounter(result[`1.3.6.1.2.1.31.1.1.1.10.${idx}`]),
                if_speed:    snmpCounter(result[`1.3.6.1.2.1.2.2.1.5.${idx}`]),
                uptime:      snmpCounter(result['1.3.6.1.2.1.1.3.0']),
                timestamp:   Date.now()
            });
        });
    } catch(e) { next(e); }
});

// ── GET /api/radius/snmp-health — CPU, versi, uptime, identity NAS ──
router.get('/snmp-health', async (req, res, next) => {
    try {
        const nasId = req.query.nas_id;
        let nas;
        if (nasId) nas = await queryOne('SELECT * FROM nas WHERE id=?', [nasId]);
        else nas = await queryOne('SELECT * FROM nas LIMIT 1');
        if (!nas) return res.status(404).json({ error: 'NAS tidak ditemukan' });

        const snmp = require('net-snmp');
        const session = snmp.createSession(nas.nasname, nas.community || 'public', {
            timeout: 5000, retries: 1, version: snmp.Version2c
        });

        const OID = {
            cpu:      '1.3.6.1.2.1.25.3.3.1.2.1',    // hrProcessorLoad
            uptimeHr: '1.3.6.1.2.1.25.1.1.0',        // hrSystemUptime (TimeTicks)
            uptimeSys:'1.3.6.1.2.1.1.3.0',           // sysUpTime (fallback)
            sysName:  '1.3.6.1.2.1.1.5.0',           // identity
            sysDescr: '1.3.6.1.2.1.1.1.0',           // RouterOS ...
            mtVer:    '1.3.6.1.4.1.14988.1.1.4.4.0', // MikroTik software version
            mtVer2:   '1.3.6.1.4.1.14988.1.1.7.4.0'  // MikroTik (lic) version
        };

        session.get(Object.values(OID), function(error, varbinds) {
            session.close();
            if (error) return res.status(502).json({ error: 'SNMP gagal: ' + error.message });
            const r = {};
            varbinds.forEach(vb => { if (!snmp.isVarbindError(vb)) r[vb.oid] = (typeof vb.value === 'object') ? vb.value.toString() : vb.value; });

            const ticks = parseInt(r[OID.uptimeHr] || r[OID.uptimeSys] || 0); // 1/100 detik
            const detik = Math.floor(ticks / 100);
            const d = Math.floor(detik / 86400);
            const h = Math.floor((detik % 86400) / 3600);
            const m = Math.floor((detik % 3600) / 60);

            res.json({
                nas_id:       nas.id,
                nas_name:     nas.shortname,
                host:         nas.nasname,
                identity:     r[OID.sysName] || nas.shortname || nas.nasname,
                cpu:          r[OID.cpu] !== undefined ? parseInt(r[OID.cpu]) : null,
                versi:        (r[OID.mtVer] || r[OID.mtVer2] || '') + '',
                descr:        (r[OID.sysDescr] || '') + '',
                uptime_ticks: ticks,
                uptime_text:  `${d}d ${h}h ${m}m`
            });
        });
    } catch(e) { next(e); }
});

// ── GET /api/radius/snmp-interfaces — list semua interface ────
router.get('/snmp-interfaces', async (req, res, next) => {
    try {
        const nasId = req.query.nas_id;
        let nas;
        if (nasId) {
            nas = await queryOne('SELECT * FROM nas WHERE id=?', [nasId]);
        } else {
            nas = await queryOne('SELECT * FROM nas LIMIT 1');
        }
        if (!nas) return res.status(404).json({ error: 'NAS tidak ditemukan' });

        const snmp = require('net-snmp');
        const session = snmp.createSession(nas.nasname, nas.community || 'public', {
            timeout: 5000, retries: 1, version: snmp.Version2c
        });

        const oid = '1.3.6.1.2.1.2.2.1.2'; // ifDescr
        const ifaces = [];

        session.subtree(oid, 20, function(varbinds) {
            varbinds.forEach(function(vb) {
                if (!snmp.isVarbindError(vb)) {
                    const idx = vb.oid.split('.').pop();
                    ifaces.push({ index: idx, name: vb.value.toString() });
                }
            });
        }, function(error) {
            session.close();
            if (error) return res.status(502).json({ error: error.message });
            res.json(ifaces);
        });
    } catch(e) { next(e); }
});

// ── GET /api/radius/cek-user/:username — diagnosa lengkap satu user/voucher ──
// Gabungan: info voucher/pelanggan (paket, status, expired, pertama dipakai),
// status online saat ini, dan riwayat sesi (login, IP, MAC, durasi, kuota).
router.get('/cek-user/:username', async (req, res, next) => {
    try {
        const username = (req.params.username || '').trim();
        if (!username) return res.status(400).json({ error: 'Username wajib diisi' });

        // 1) Identitas: cek di voucher dulu, lalu pelanggan
        let tipe = null, info = null;
        const v = await queryOne(`
            SELECT v.username, v.status, v.tgl_digunakan, v.tgl_expired, v.created_at,
                   v.batch_id, p.nama AS nama_paket, p.masa_aktif, p.satuan_masa
            FROM voucher v LEFT JOIN paket p ON v.paket_id = p.id
            WHERE v.username = ? LIMIT 1
        `, [username]);
        if (v) { tipe = 'voucher'; info = v; }
        else {
            const pl = await queryOne(`
                SELECT pl.username, pl.nama, pl.status, pl.tgl_expired, pl.created_at,
                       p.nama AS nama_paket, p.masa_aktif, p.satuan_masa
                FROM pelanggan pl LEFT JOIN paket p ON pl.paket_id = p.id
                WHERE pl.username = ? LIMIT 1
            `, [username]);
            if (pl) { tipe = 'pelanggan'; info = pl; }
        }

        // 2) Status online (sesi terbuka)
        const online = await queryOne(`
            SELECT framedipaddress AS ip, callingstationid AS mac,
                   nasipaddress AS nas, acctstarttime AS mulai,
                   TIMESTAMPDIFF(MINUTE, acctstarttime, NOW()) AS durasi_menit
            FROM radacct
            WHERE username = ? AND acctstoptime IS NULL
            ORDER BY acctstarttime DESC LIMIT 1
        `, [username]);

        // 3) Riwayat sesi (maks 20 terakhir)
        const sesi = await query(`
            SELECT acctstarttime AS login,
                   acctstoptime  AS logout,
                   framedipaddress AS ip,
                   callingstationid AS mac,
                   nasipaddress AS nas,
                   TIMESTAMPDIFF(MINUTE, acctstarttime, IFNULL(acctstoptime, NOW())) AS durasi_menit,
                   ROUND(acctinputoctets/1048576, 2)  AS mb_in,
                   ROUND(acctoutputoctets/1048576, 2) AS mb_out,
                   acctterminatecause AS sebab
            FROM radacct
            WHERE username = ?
            ORDER BY acctstarttime DESC
            LIMIT 20
        `, [username]);

        if (!info && !sesi.length) {
            return res.status(404).json({ error: 'Username tidak ditemukan di voucher, pelanggan, maupun riwayat sesi' });
        }

        res.json({
            username,
            tipe,                 // 'voucher' | 'pelanggan' | null (hanya ada di radacct)
            info,                 // detail paket/status/expired
            online: online || null,
            total_sesi: sesi.length,
            sesi
        });
    } catch (e) { next(e); }
});

module.exports = router;
