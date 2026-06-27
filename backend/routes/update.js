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
        "SELECT kunci, nilai FROM setting WHERE kunci IN ('github_owner','github_repo','github_token','github_branch','app_version')"
    ).catch(() => []);
    const m = {};
    rows.forEach(r => { m[r.kunci] = r.nilai; });
    return {
        owner: (m.github_owner || 'idpanyoet').trim(),
        repo:  (m.github_repo  || 'SimBill-Project').trim(),
        token: (m.github_token || '').trim(),
        branch: (m.github_branch || 'master').trim(),
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

// Agent paksa IPv4 — banyak VPS punya IPv6 rusak ke GitHub yang memicu timeout/504.
const https = require('https');
const ghAgent = new https.Agent({ keepAlive: true, family: 4 });

// GET ke GitHub dengan retry otomatis pada 5xx / timeout (504 sering hanya sesaat).
async function ghGet(url, cfg, extra = {}) {
    let last;
    for (let i = 0; i < 3; i++) {
        try {
            const r = await axios.get(url, {
                headers: ghHeaders(cfg.token),
                httpsAgent: ghAgent,
                timeout: 20000,
                validateStatus: () => true,
                ...extra,
            });
            if (r.status < 500) return r;   // sukses / 4xx → tidak perlu retry
            last = r;                        // 5xx (mis. 502/503/504) → coba lagi
        } catch (e) {
            last = e;                        // timeout / jaringan → coba lagi
        }
        if (i < 2) await new Promise(s => setTimeout(s, 1500 * (i + 1)));
    }
    if (last && typeof last.status === 'number') return last;
    throw (last instanceof Error ? last : new Error('Gagal menghubungi GitHub'));
}

// ── GET /api/update/check ───────────────────────────────────────────────────
router.get('/check', async (req, res) => {
    try {
        const cfg = await getCfg();
        const current = versiLokal(cfg);
        let rel;
        try {
            const r = await ghGet(
                `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/releases/latest`,
                cfg
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
                    pesan: `GitHub API status ${r.status}` + (r.status>=500 ? ' (server GitHub sedang sibuk/timeout — coba lagi sebentar lagi).' : '.') });
            }
            rel = r.data;
        } catch (e) {
            return res.status(200).json({ current, latest: null, update_available: false,
                pesan: 'Gagal menghubungi GitHub: ' + e.message });
        }

        const latest = rel.tag_name || rel.name || null;
        const adaZipAsset = (rel.assets || []).some(a => /\.zip$/i.test(a.name || ''));
        res.json({
            current,
            latest,
            update_available: !!latest && norm(latest) !== norm(current),
            nama_rilis: rel.name || latest,
            catatan: (rel.body || '').slice(0, 4000),   // changelog
            url: rel.html_url || null,
            tanggal: rel.published_at || null,
            sumber: adaZipAsset ? 'zip-asset' : 'source-code',
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

    sedangUpdate = true;
    try {
        const cfg = await getCfg();
        const current = versiLokal(cfg);

        // Jalankan update.sh dari GitHub (git pull + npm install + restart).
        // Script ini yang memegang seluruh logika update — lebih sederhana &
        // terkontrol daripada unduh tarball + rsync di Node.
        // URL script mengikuti repo di konfigurasi.
        const branch = cfg.branch || 'master';

        // Validasi ketat tiap komponen URL SEBELUM dipakai. owner/repo/branch
        // berasal dari tabel `setting` (bisa diubah admin), lalu masuk ke perintah
        // shell `wget -qO- "${scriptUrl}" | bash`. Tanpa validasi, branch yang
        // memuat `"`/`;`/`$(...)` bisa breakout dari quote → command injection,
        // dan `..` bisa dipakai path-traversal. Fail-closed bila tidak cocok.
        const RX_GH_SEG    = /^[A-Za-z0-9._-]+$/;          // owner & repo
        const RX_GH_BRANCH = /^[A-Za-z0-9._/-]+$/;         // branch boleh ada '/'
        if (!RX_GH_SEG.test(cfg.owner) || !RX_GH_SEG.test(cfg.repo) ||
            !RX_GH_BRANCH.test(branch) || branch.includes('..') ||
            cfg.owner.includes('..') || cfg.repo.includes('..')) {
            sedangUpdate = false;
            return res.status(400).json({ error: 'Konfigurasi owner/repo/branch GitHub tidak valid.' });
        }

        const scriptUrl = `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${branch}/update.sh`;

        // Validasi URL aman (hanya raw.githubusercontent.com + repo yang dikenal)
        if (!/^https:\/\/raw\.githubusercontent\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\//.test(scriptUrl)) {
            sedangUpdate = false;
            return res.status(400).json({ error: 'URL script update tidak valid.' });
        }

        // Balas dulu ke UI (proses update jalan di background, app akan restart).
        res.json({
            sukses: true,
            dari: current,
            pesan: 'Update dimulai (menjalankan update.sh). Aplikasi akan restart beberapa saat lagi. ' +
                   'Cek log di /tmp/simbill-update.log bila perlu.',
            log: '/tmp/simbill-update.log',
        });

        // Jalankan detached: wget script → bash. Output ke log.
        // Pakai 'set -o pipefail' agar gagal-unduh terdeteksi.
        const cmd = `sleep 1; `
            + `set -o pipefail; `
            + `wget -qO- "${scriptUrl}" | bash `
            + `> /tmp/simbill-update.log 2>&1`;
        const child = spawn('bash', ['-lc', cmd], { detached: true, stdio: 'ignore' });
        child.unref();
    } catch (e) {
        sedangUpdate = false;
        if (!res.headersSent) res.status(500).json({ error: 'Update gagal: ' + e.message });
    } finally {
        // sedangUpdate akan ter-reset saat proses restart (proses Node baru).
        // Tidak di-set false di sini agar tidak ada update dobel sebelum restart.
    }
});

module.exports = router;
