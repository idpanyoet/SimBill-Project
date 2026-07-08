'use strict';
/**
 * routes/olt.js — Endpoint OLT untuk SimBill
 * Fase 1 (monitoring) + Auto-match ONU <-> pelanggan.
 *
 * Daftar di app utama:  app.use('/api/olt', require('./routes/olt'));
 * Index ONU (1/8/1:1) dikirim lewat QUERY (?index=...) karena ada slash.
 */

const router = require('express').Router();
const { authMiddleware, requireAdmin } = require('../middleware/auth');
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
// Metrik banyak ONU sekaligus: ?index=1/8/1:1,1/8/1:3,...  (1 sesi SSH)
router.get('/onu/metrics-batch', (req, res) => handle(res, olt.getOnuMetricsBatch(req.query.olt, req.query.index, req.query.fields)));
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
router.post('/sync', requireAdmin, (req, res) => {
  const fetchNames = String(req.query.names || '1') !== '0';
  handle(res, olt.syncMatch(req.query.olt, { fetchNames }));
});

// Cari pelanggan utk picker link manual
router.get('/pelanggan/search', (req, res) => handle(res, olt.searchPelanggan(req.query.q)));

// Link manual ONU -> pelanggan
router.post('/link', requireAdmin, (req, res) => {
  const { olt: oltId, index, pelanggan_id, sn, name } = req.body || {};
  handle(res, olt.setLink(oltId, index, pelanggan_id, { sn, name }));
});
router.delete('/link', requireAdmin, (req, res) => handle(res, olt.deleteLink(req.query.olt, req.query.index)));

// Tandai / batalkan ONU sebagai voucher/hotspot
router.post('/voucher', requireAdmin, (req, res) => {
  const { olt: oltId, index, on, sn, name } = req.body || {};
  handle(res, olt.markVoucher(oltId, index, on !== false, { sn, name }));
});

// ── Fase 2: Register ONU (WRITE) ────────────────────────────
// Default DRY-RUN. Kirim beneran HARUS dengan body.commit === true.
router.post('/onu/register', requireAdmin, (req, res) => {
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
router.post('/config/save', requireAdmin, (req, res) => handle(res, Promise.resolve(olt.upsertOlt(req.body || {}))));
router.post('/config/delete', requireAdmin, (req, res) => handle(res, Promise.resolve(olt.removeOlt((req.body || {}).id))));

// Daftar template register (buat dropdown)
router.get('/templates', (req, res) => handle(res, Promise.resolve(olt.getTemplates())));

// ── Fase 3: Write actions (reboot/disable/enable/restore/delete) ──
// DEFAULT DRY-RUN. commit:true baru kirim ke OLT.
router.get('/actions', (req, res) => handle(res, Promise.resolve(olt.listActions())));
router.post('/onu/action', (req, res) => {
  const b = req.body || {};
  // Aksi destruktif (factory reset & hapus ONU) hanya untuk admin/superadmin.
  // reboot/enable/disable/restore_wifi tetap boleh teknisi untuk kerja lapangan.
  const DESTRUCTIVE = ['restore', 'delete'];
  if (DESTRUCTIVE.includes(b.action) && !['superadmin', 'admin'].includes(req.admin?.role)) {
    return res.status(403).json({ ok: false, error: 'Aksi ini (factory reset / hapus ONU) hanya untuk admin' });
  }
  handle(res, olt.onuAction(b.olt, { index: b.index, action: b.action, commit: b.commit === true }));
});

// ── TR069 (ACS) per ONU ──
// GET baca config TR069 saat ini; POST set (DRY-RUN default, commit:true baru tulis).
router.get('/onu/tr069', (req, res) => handle(res, olt.getTr069(req.query.olt, req.query.index)));
router.post('/onu/tr069', requireAdmin, (req, res) => {
  const b = req.body || {};
  handle(res, olt.onuTr069(b.olt, {
    index: b.index, acsUrl: b.acsUrl, user: b.user, pass: b.pass,
    vlan: b.vlan, priority: b.priority, enable: b.enable, commit: b.commit === true,
  }));
});

// ── T-CONT per ONU ──
router.get('/onu/tcont', (req, res) => handle(res, olt.getTcont(req.query.olt, req.query.index)));
router.post('/onu/tcont', requireAdmin, (req, res) => {
  const b = req.body || {};
  handle(res, olt.onuTcont(b.olt, {
    index: b.index, tcontId: b.tcontId, name: b.name, profile: b.profile,
    remove: b.remove === true, commit: b.commit === true,
  }));
});

// ── GEM Port per ONU ──
router.get('/onu/gemport', (req, res) => handle(res, olt.getGemport(req.query.olt, req.query.index)));
router.post('/onu/gemport', requireAdmin, (req, res) => {
  const b = req.body || {};
  handle(res, olt.onuGemport(b.olt, {
    index: b.index, gemId: b.gemId, name: b.name, tcont: b.tcont,
    remove: b.remove === true, commit: b.commit === true,
  }));
});

// ── Service (service-port) per ONU ──
router.get('/onu/service', (req, res) => handle(res, olt.getService(req.query.olt, req.query.index)));
router.post('/onu/service', requireAdmin, (req, res) => {
  const b = req.body || {};
  handle(res, olt.onuService(b.olt, {
    index: b.index, svcId: b.svcId, vport: b.vport, vlan: b.vlan, description: b.description,
    remove: b.remove === true, commit: b.commit === true,
  }));
});

// ── Ports (vlan port) per ONU ──
router.get('/onu/ports', (req, res) => handle(res, olt.getPorts(req.query.olt, req.query.index)));
router.post('/onu/ports', requireAdmin, (req, res) => {
  const b = req.body || {};
  handle(res, olt.onuPorts(b.olt, {
    index: b.index, port: b.port, mode: b.mode, vlan: b.vlan, priority: b.priority,
    remove: b.remove === true, commit: b.commit === true,
  }));
});

// ── ONU Service (service ... gemport ... vlan) per ONU ──
router.get('/onu/onusvc', (req, res) => handle(res, olt.getOnuService(req.query.olt, req.query.index)));
router.post('/onu/onusvc', requireAdmin, (req, res) => {
  const b = req.body || {};
  handle(res, olt.onuServiceMng(b.olt, {
    index: b.index, name: b.name, gemport: b.gemport, vlan: b.vlan,
    remove: b.remove === true, commit: b.commit === true,
  }));
});

// ── WAN IP (wan-ip: pppoe/static/dhcp) per ONU ──
router.get('/onu/wanip', (req, res) => handle(res, olt.getWanIp(req.query.olt, req.query.index)));
router.post('/onu/wanip', requireAdmin, (req, res) => {
  const b = req.body || {};
  handle(res, olt.onuWanIp(b.olt, {
    index: b.index, wanId: b.wanId, mode: b.mode,
    username: b.username, password: b.password, serviceName: b.serviceName,
    ipProfile: b.ipProfile, vlanProfile: b.vlanProfile, host: b.host,
    remove: b.remove === true, commit: b.commit === true,
  }));
});

// Daftar profile tcont (buat dropdown register)
router.get('/profiles', (req, res) => handle(res, olt.getTcontProfiles(req.query.olt)));

// Daftar profile VLAN (buat dropdown wan-ip / network config)
router.get('/vlan-profiles', (req, res) => handle(res, olt.getVlanProfiles(req.query.olt)));

// Serial number massal (lazy, dipanggil setelah daftar tampil): ?pons=1/8/1,1/8/2
router.get('/sn-map', (req, res) => handle(res, olt.getSnMapForPons(req.query.olt, req.query.pons)));

module.exports = router;
