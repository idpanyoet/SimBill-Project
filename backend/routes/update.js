// routes/update.js — Pembaruan Sistem via GitHub Releases
// =============================================================================
// Fitur self-update untuk panel admin:
//   GET  /api/update/check  → bandingkan versi lokal vs rilis terbaru di GitHub
//   POST /api/update/apply  → unduh rilis, backup, terapkan, npm install, restart
//
// Sumber versi lokal (urut prioritas): file VERSION di root app → setting
// 'app_version' → package.json. Saat apply, file VERSION ditulis ulang.
//
// Catatan repo PRIVAT: GitHub Releases API butuh token. Simpan PAT di
// Setting dengan kunci 'github_token' (scope: Contents read). Tanpa token,
// /check pada repo privat akan 404.
// =============================================================================
const router = require('express').Router();
const { query, queryOne } = require('../config/db');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const axios = require('axios');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync, spawn } = require('child_process');

router.use(authMiddleware);

const BACKEND_DIR = path.resolve(__dirname, '..');
const APP_ROOT    = path.resolve(BACKEND_DIR, '..');
const VERSION_FILE = path.join(APP_ROOT, 'VERSION');
const BACKUP_DIR   = path.join(APP_ROOT, '..', 'simbill-backups');
const PM2_NAME     = process.env.PM2_NAME || 'billing-radius';

let sedangUpdate = false; // kunci sederhana cegah apply ganda

// ── Ambil konfigurasi GitHub dari tabel setting ─────────────────────────────
async function getCfg() {
    const rows = await query(
        "SELECT kunci, nilai FROM setting WHERE kunci IN ('github_owner','github_repo','github_token','app_version')"
    ).catch(() => []);
    const m = {};
    rows.forEach(r => { m[r.kunci] = r.nilai; });
    return {
        owner: (m.github_owner || 'idpanyoet').trim(),
        repo:  (m.github_repo  || 'netbill').trim(),
        token: (m.github_token || '').trim(),
        appVersionSetting: (m.app_version || '').trim(),
    };
}

function versiLokal(cfg) {
    try { const v = fs.readFileSync(VERSION_FILE, 'utf8').trim(); if (v) return v; } catch (e) {}
    if (cfg.appVersionSetting) return cfg.appVersionSetting;
    try { return require(path.join(BACKEND_DIR, 'package.json')).version; } catch (e) {}
    return '0.0.0';
}

function ghHeaders(token) {
    const h = {
        'User-Agent': 'SimBill-Updater',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
}

const norm = s => String(s || '').trim().replace(/^v/i, '').toLowerCase();

// ── GET /api/update/check ───────────────────────────────────────────────────
router.get('/check', async (req, res) => {
    try {
        const cfg = await getCfg();
        const current = versiLokal(cfg);
        let rel;
        try {
            const r = await axios.get(
                `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/releases/latest`,
                { headers: ghHeaders(cfg.token), timeout: 15000, validateStatus: () => true }
            );
            if (r.status === 404) {
                return res.json({
                    current, latest: null, update_available: false,
                    pesan: cfg.token
                        ? 'Belum ada release di GitHub untuk repo ini.'
                        : 'Repo privat / belum ada release. Isi GitHub token di Setting jika repo privat.',
                });
            }
            if (r.status === 401 || r.status === 403) {
                return res.status(200).json({
                    current, latest: null, update_available: false,
                    pesan: 'GitHub menolak (token salah/kadaluarsa atau rate limit). Cek github_token di Setting.',
                });
            }
            if (r.status >= 400) {
                return res.status(200).json({ current, latest: null, update_available: false,
                    pesan: `GitHub API status ${r.status}.` });
            }
            rel = r.data;
        } catch (e) {
            return res.status(200).json({ current, latest: null, update_available: false,
                pesan: 'Gagal menghubungi GitHub: ' + e.message });
        }

        const latest = rel.tag_name || rel.name || null;
        res.json({
            current,
            latest,
            update_available: !!latest && norm(latest) !== norm(current),
            nama_rilis: rel.name || latest,
            catatan: (rel.body || '').slice(0, 4000),   // changelog
            url: rel.html_url || null,
            tanggal: rel.published_at || null,
        });
    } catch (e) {
        res.status(500).json({ error: 'Gagal cek update: ' + e.message });
    }
});

// ── helper apply ────────────────────────────────────────────────────────────
function adaPerintah(bin) {
    try { execSync(`command -v ${bin}`, { stdio: 'pipe' }); return true; } catch { return false; }
}

function jadwalkanRestart() {
    // Detach agar proses restart selamat walau parent (server ini) dibunuh pm2/systemd.
    const cmd = `sleep 2; (pm2 restart ${PM2_NAME} || systemctl restart ${PM2_NAME}) `
              + `> /tmp/simbill-update-restart.log 2>&1`;
    const child = spawn('bash', ['-c', cmd], { detached: true, stdio: 'ignore' });
    child.unref();
}

// ── POST /api/update/apply ──────────────────────────────────────────────────
router.post('/apply', requireAdmin, async (req, res) => {
    if (sedangUpdate) return res.status(409).json({ error: 'Update lain sedang berjalan.' });
    if (!adaPerintah('tar') || !adaPerintah('rsync')) {
        return res.status(503).json({ error: "Perintah 'tar'/'rsync' belum terpasang di server. Jalankan: apt-get install -y rsync tar" });
    }

    sedangUpdate = true;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simbill-upd-'));
    const tarFile = path.join(tmpDir, 'release.tar.gz');
    try {
        const cfg = await getCfg();
        const current = versiLokal(cfg);

        // Validasi tag bila dikirim manual (cegah path/URL aneh)
        let tag = (req.body && req.body.tag ? String(req.body.tag) : '').trim();
        if (tag && !/^[A-Za-z0-9._-]{1,80}$/.test(tag)) {
            sedangUpdate = false;
            return res.status(400).json({ error: 'Tag rilis tidak valid.' });
        }

        // Ambil metadata rilis (latest atau by tag) → pakai tarball_url dari GitHub
        const relUrl = tag
            ? `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/releases/tags/${tag}`
            : `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/releases/latest`;
        const relResp = await axios.get(relUrl, { headers: ghHeaders(cfg.token), timeout: 15000, validateStatus: () => true });
        if (relResp.status >= 400) {
            throw new Error(`Tidak bisa ambil rilis (status ${relResp.status}). ` +
                (cfg.token ? '' : 'Repo privat butuh github_token di Setting.'));
        }
        const rel = relResp.data;
        const newTag = rel.tag_name || rel.name || tag || 'unknown';
        const tarball = rel.tarball_url;
        if (!tarball) throw new Error('Rilis tidak punya tarball_url.');

        // 1) Unduh tarball (token diperlukan untuk repo privat)
        const dl = await axios.get(tarball, {
            headers: ghHeaders(cfg.token), responseType: 'arraybuffer',
            timeout: 120000, maxRedirects: 5,
        });
        fs.writeFileSync(tarFile, Buffer.from(dl.data));

        // 2) Ekstrak
        const exDir = path.join(tmpDir, 'extract');
        fs.mkdirSync(exDir, { recursive: true });
        execSync(`tar xzf "${tarFile}" -C "${exDir}"`, { stdio: 'pipe' });

        // 3) Cari root kode di dalam arsip (folder berisi backend/server.js)
        let srcRoot = execSync(
            `find "${exDir}" -maxdepth 4 -name server.js -path '*backend*' -printf '%h\\n' | head -1`,
            { stdio: 'pipe' }
        ).toString().trim();
        srcRoot = srcRoot ? path.resolve(srcRoot, '..') : '';
        if (!srcRoot || !fs.existsSync(path.join(srcRoot, 'backend', 'package.json'))) {
            // fallback: wrapper tunggal hasil ekstrak GitHub
            const inner = fs.readdirSync(exDir).map(n => path.join(exDir, n)).filter(p => fs.statSync(p).isDirectory());
            if (inner.length === 1) srcRoot = inner[0];
        }
        if (!srcRoot || !fs.existsSync(path.join(srcRoot, 'backend'))) {
            throw new Error('Struktur arsip rilis tidak dikenali (folder backend/ tidak ditemukan).');
        }

        // 4) Backup kode lama + .env (untuk rollback)
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(BACKUP_DIR, `backup-${norm(current) || 'lama'}-${stamp}.tar.gz`);
        try {
            execSync(
                `tar czf "${backupFile}" --exclude=node_modules --exclude=.git -C "${APP_ROOT}" .`,
                { stdio: 'pipe' }
            );
        } catch (e) { /* backup best-effort; jangan batalkan update */ }

        // 5) Sinkronkan file baru ke APP_ROOT — JAGA .env, uploads, node_modules
        execSync(
            `rsync -a --delete `
            + `--exclude='.env' --exclude='backend/.env' `
            + `--exclude='node_modules' --exclude='backend/node_modules' `
            + `--exclude='frontend/uploads' --exclude='.git' --exclude='VERSION' `
            + `"${srcRoot}/" "${APP_ROOT}/"`,
            { stdio: 'pipe' }
        );

        // 6) Install dependensi (cegah MODULE_NOT_FOUND akibat package.json baru)
        execSync('npm install --no-audit --no-fund', { cwd: BACKEND_DIR, stdio: 'pipe', timeout: 600000 });

        // 7) Tulis versi baru
        fs.writeFileSync(VERSION_FILE, newTag + '\n');
        await query(
            "INSERT INTO setting (kunci, nilai) VALUES ('app_version', ?) ON DUPLICATE KEY UPDATE nilai = ?",
            [newTag, newTag]
        ).catch(() => {});

        // 8) Balas dulu, lalu restart (detached)
        res.json({
            sukses: true,
            dari: current,
            ke: newTag,
            backup: backupFile,
            pesan: `Update ke ${newTag} berhasil. Aplikasi akan restart dalam beberapa detik.`,
        });
        jadwalkanRestart();
    } catch (e) {
        res.status(500).json({ error: 'Update gagal: ' + e.message });
    } finally {
        sedangUpdate = false;
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    }
});

module.exports = router;
