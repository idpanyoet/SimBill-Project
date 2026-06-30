'use strict';
/**
 * routes/olt.js — Endpoint OLT untuk SimBill
 * Fase 1 (monitoring) + Auto-match ONU <-> pelanggan.
 *
 * Daftar di app utama:  app.use('/api/olt', require('./routes/olt'));
 * Index ONU (1/8/1:1) dikirim lewat QUERY (?index=...) karena ada slash.
 */

const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');
const olt = require('../services/olt');
const snmp = require('../services/snmp');

router.use(authMiddleware);

function handle(res, promise) {
  promise
    .then((data) => res.json({ ok: true, data }))
    .catch((err) => {
      console.error('[olt route]', err.message);
      res.status(500).json({ ok: false, error: err.message });
    });
}

// ── Monitoring ──────────────────────────────────────────────
router.get('/list', (req, res) => res.json({ ok: true, data: olt.listOlts() }));
router.get('/dashboard', (req, res) => handle(res, olt.getDashboard(req.query.olt)));
router.get('/onu/state', (req, res) => handle(res, olt.getOnuState(req.query.olt)));
router.get('/onu/uncfg', (req, res) => handle(res, olt.getUncfg(req.query.olt)));
router.get('/onu/power', (req, res) => handle(res, olt.getOnuPower(req.query.olt, req.query.index)));
router.get('/onu/detail', (req, res) => handle(res, olt.getOnuDetail(req.query.olt, req.query.index)));
// detail + power + pelanggan (modal)
router.get('/onu/info', (req, res) => handle(res, olt.getOnuInfo(req.query.olt, req.query.index)));
// statistik traffic (read-only, SSH — fallback)
router.get('/onu/traffic', (req, res) => handle(res, olt.getOnuTraffic(req.query.olt, req.query.index)));
router.get('/onu/metrics', (req, res) => handle(res, olt.getOnuMetrics(req.query.olt, req.query.index)));
// traffic via SNMP (cepat) — rate dari selisih counter (in-memory antar polling)
router.get('/onu/traffic-snmp', (req, res) => {
  const o = olt.getOlt(req.query.olt);
  if (!o) return res.status(404).json({ ok: false, error: 'OLT tidak ditemukan' });
  if (!snmp.available()) return res.status(503).json({ ok: false, error: 'net-snmp belum terpasang' });
  handle(res, snmp.pollRate(o, req.query.index));
});
// running-config (read-only)
router.get('/onu/config', (req, res) => handle(res, olt.getOnuConfig(req.query.olt, req.query.index)));

// ── Auto-match ──────────────────────────────────────────────
// Jalankan sinkronisasi match (berat; ?names=0 utk cepat / SN saja)
router.post('/sync', (req, res) => {
  const fetchNames = String(req.query.names || '1') !== '0';
  handle(res, olt.syncMatch(req.query.olt, { fetchNames }));
});

// Cari pelanggan utk picker link manual
router.get('/pelanggan/search', (req, res) => handle(res, olt.searchPelanggan(req.query.q)));

// Link manual ONU -> pelanggan
router.post('/link', (req, res) => {
  const { olt: oltId, index, pelanggan_id, sn, name } = req.body || {};
  handle(res, olt.setLink(oltId, index, pelanggan_id, { sn, name }));
});
router.delete('/link', (req, res) => handle(res, olt.deleteLink(req.query.olt, req.query.index)));

// Tandai / batalkan ONU sebagai voucher/hotspot
router.post('/voucher', (req, res) => {
  const { olt: oltId, index, on, sn, name } = req.body || {};
  handle(res, olt.markVoucher(oltId, index, on !== false, { sn, name }));
});

// ── Fase 2: Register ONU (WRITE) ────────────────────────────
// Default DRY-RUN. Kirim beneran HARUS dengan body.commit === true.
router.post('/onu/register', (req, res) => {
  const b = req.body || {};
  const dryRun = b.commit !== true;       // commit:true baru nulis ke OLT
  handle(res, olt.registerOnu(b.olt, {
    sn: b.sn, pon: b.pon, onuNumber: b.onuNumber, name: b.name, type: b.type,
    templateId: b.templateId, vars: b.vars || {}, skipOnuAdd: b.skipOnuAdd,
    write: b.write, pelanggan_id: b.pelanggan_id, dryRun,
  }));
});

// ── Konfigurasi OLT (tambah/edit/hapus) ──
router.get('/config/list', (req, res) => handle(res, Promise.resolve(olt.listOltsForEdit())));
router.post('/config/save', (req, res) => handle(res, Promise.resolve(olt.upsertOlt(req.body || {}))));
router.post('/config/delete', (req, res) => handle(res, Promise.resolve(olt.removeOlt((req.body || {}).id))));

// Daftar template register (buat dropdown)
router.get('/templates', (req, res) => handle(res, Promise.resolve(olt.getTemplates())));

// ── Fase 3: Write actions (reboot/disable/enable/restore/delete) ──
// DEFAULT DRY-RUN. commit:true baru kirim ke OLT.
router.get('/actions', (req, res) => handle(res, Promise.resolve(olt.listActions())));
router.post('/onu/action', (req, res) => {
  const b = req.body || {};
  handle(res, olt.onuAction(b.olt, { index: b.index, action: b.action, commit: b.commit === true }));
});

// Daftar profile tcont (buat dropdown register)
router.get('/profiles', (req, res) => handle(res, olt.getTcontProfiles(req.query.olt)));

module.exports = router;
