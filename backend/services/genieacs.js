// services/genieacs.js — Integrasi GenieACS NBI API (port 7557)
// SimBill TIDAK lagi jadi ACS sendiri. GenieACS yang mengelola semua device
// (inform, poll, NAT, connection request, task queue). SimBill cukup baca data
// & kirim task via REST API GenieACS. Semua kerumitan TR-069 ditangani GenieACS.
'use strict';

const axios = require('axios');
const { query } = require('../config/db');

// Ambil base URL GenieACS NBI dari setting (default sesuai screenshot).
// NBI default TANPA auth. Kalau setup pakai auth, tambah genieacs_user/pass.
async function getGenieCfg() {
    const rows = await query(
        "SELECT kunci,nilai FROM setting WHERE kunci IN ('genieacs_url','genieacs_user','genieacs_password')"
    ).catch(() => []);
    const m = {};
    rows.forEach(r => { m[r.kunci] = r.nilai; });
    let url = (m.genieacs_url || 'http://103.193.145.255:7557').trim().replace(/\/+$/, '');
    return {
        url,
        user: (m.genieacs_user || '').trim(),
        password: (m.genieacs_password || '').trim(),
    };
}

function authOpts(cfg) {
    const o = { timeout: 15000 };
    if (cfg.user) o.auth = { username: cfg.user, password: cfg.password };
    return o;
}

// ── Helper: ambil nilai _value dari objek GenieACS (nested) ──
function gv(obj, path) {
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
        if (cur == null) return null;
        cur = cur[p];
    }
    return cur && typeof cur === 'object' && '_value' in cur ? cur._value : cur;
}

// ── Cari _id GenieACS berdasarkan SerialNumber ──
// GenieACS simpan serial di _deviceId._SerialNumber (BUKAN DeviceInfo.SerialNumber).
// _id format: OUI-ProductClass-SerialNumber (mis. 00259E-HG8145V5-485754433E84A4AF).
async function cariIdBySerial(serial) {
    const cfg = await getGenieCfg();
    const q = encodeURIComponent(JSON.stringify({ '_deviceId._SerialNumber': serial }));
    const url = `${cfg.url}/devices/?query=${q}&projection=_id`;
    const r = await axios.get(url, authOpts(cfg));
    if (Array.isArray(r.data) && r.data.length > 0) return r.data[0]._id;
    return null;
}

// ── Daftar device (real-time dari GenieACS) ──
// projection membatasi field agar respons ringan. Kembalikan bentuk yang
// sudah dinormalisasi untuk frontend SimBill.
async function listDevices({ limit = 1000 } = {}) {
    const cfg = await getGenieCfg();
    const projection = [
        '_id',
        '_deviceId',
        '_lastInform',
        '_tags',
        'InternetGatewayDevice.DeviceInfo.SerialNumber',
        'InternetGatewayDevice.DeviceInfo.Manufacturer',
        'InternetGatewayDevice.DeviceInfo.ModelName',
        'InternetGatewayDevice.DeviceInfo.HardwareVersion',
        'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
        'InternetGatewayDevice.DeviceInfo.UpTime',
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
        // RX optik (redaman) — path beda per vendor
        'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.X_HW_WANGponInterfaceConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower',
    ].join(',');
    const url = `${cfg.url}/devices/?projection=${encodeURIComponent(projection)}&limit=${limit}`;
    const r = await axios.get(url, authOpts(cfg));
    const arr = Array.isArray(r.data) ? r.data : [];
    return arr.map(normalizeDevice);
}

// ── Detail satu device by _id ──
async function getDevice(genieId) {
    const cfg = await getGenieCfg();
    const q = encodeURIComponent(JSON.stringify({ _id: genieId }));
    const url = `${cfg.url}/devices/?query=${q}&limit=1`;
    const r = await axios.get(url, authOpts(cfg));
    if (Array.isArray(r.data) && r.data.length > 0) return r.data[0];
    return null;
}

// ── Normalisasi device GenieACS → bentuk ringkas SimBill ──
function normalizeDevice(d) {
    const igd = d.InternetGatewayDevice || {};
    const di = igd.DeviceInfo || {};
    const did = d._deviceId || {};
    const wan = ((((igd.WANDevice || {})['1'] || {}).WANConnectionDevice || {})['1'] || {});
    const wanIp = gv(wan, 'WANIPConnection.1.ExternalIPAddress')
               || gv(wan, 'WANPPPConnection.1.ExternalIPAddress') || '';
    // Username PPPoE — untuk auto-match ke pelanggan SimBill
    const pppUsername = gv(wan, 'WANPPPConnection.1.Username') || '';
    const ssid = gv(igd, 'LANDevice.1.WLANConfiguration.1.SSID') || '';
    // RX optik (redaman) — coba beberapa path vendor
    const wd = (igd.WANDevice || {})['1'] || {};
    let rxPower = gv(wd, 'X_ZTE-COM_WANPONInterfaceConfig.RXPower')
               ?? gv(wd, 'X_HW_WANGponInterfaceConfig.RXPower')
               ?? gv(wd, 'X_GponInterafceConfig.RXPower')
               ?? gv(wd, 'WANPONInterfaceConfig.RXPower')
               ?? null;
    // normalisasi: angka (dBm). Sebagian device kirim *1000 atau string.
    if (rxPower !== null && rxPower !== '' && !isNaN(parseFloat(rxPower))) {
        let v = parseFloat(rxPower);
        if (v < -1000) v = v / 1000; // kadang dalam 0.001 dBm
        rxPower = Math.round(v * 100) / 100;
    } else {
        rxPower = null;
    }
    const lastInform = d._lastInform || null;
    // online: inform < 10 menit terakhir
    const online = lastInform
        ? (Date.now() - new Date(lastInform).getTime() < 10 * 60 * 1000)
        : false;
    const S = v => (v == null ? '' : String(v));
    return {
        genie_id: d._id,
        // _deviceId = sumber andal (selalu ada); fallback ke DeviceInfo tree.
        serial_number: S(did._SerialNumber || gv(di, 'SerialNumber') || ''),
        manufacturer: S(did._Manufacturer || gv(di, 'Manufacturer') || ''),
        product_class: S(did._ProductClass || ''),
        model: S(gv(di, 'ModelName') || did._ProductClass || ''),
        hardware_version: S(gv(di, 'HardwareVersion') || ''),
        software_version: S(gv(di, 'SoftwareVersion') || ''),
        uptime: gv(di, 'UpTime') || 0,
        ssid: S(ssid),
        ip_address: S(wanIp),
        pppoe_username: S(pppUsername),
        rx_power: rxPower,
        last_inform: lastInform,
        status: online ? 'online' : 'offline',
        tags: d._tags || [],
    };
}

// ── Ratakan parameter penting GenieACS → {namaParam: nilai} ──
// GenieACS kembalikan tree bersarang; frontend butuh objek datar param→nilai.
// Ambil parameter yang umum berguna (info, WAN, WiFi, optik).
function flattenParams(raw) {
    const out = {};
    const want = [
        'InternetGatewayDevice.DeviceInfo.SerialNumber',
        'InternetGatewayDevice.DeviceInfo.Manufacturer',
        'InternetGatewayDevice.DeviceInfo.ModelName',
        'InternetGatewayDevice.DeviceInfo.HardwareVersion',
        'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
        'InternetGatewayDevice.DeviceInfo.UpTime',
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
    ];
    for (const path of want) {
        const v = gv(deepGet(raw, path) || {}, '_value');
        const val = (typeof v !== 'undefined' && v !== null) ? v : gvByPath(raw, path);
        if (val !== null && typeof val !== 'undefined' && typeof val !== 'object') {
            out[path] = val;
        }
    }
    return out;
}

// ambil node by dotted path
function deepGet(obj, path) {
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
        if (cur == null) return null;
        cur = cur[p];
    }
    return cur;
}
// ambil _value by dotted path (langsung)
function gvByPath(obj, path) {
    const node = deepGet(obj, path);
    if (node && typeof node === 'object' && '_value' in node) return node._value;
    return null;
}
// connection_request = GenieACS langsung trigger device. Kalau device offline,
// task tetap antri & jalan saat device inform berikutnya.
async function kirimTask(genieId, task, { connectionRequest = true } = {}) {
    const cfg = await getGenieCfg();
    const cr = connectionRequest ? '?connection_request' : '';
    const url = `${cfg.url}/devices/${encodeURIComponent(genieId)}/tasks${cr}`;
    const r = await axios.post(url, task, {
        ...authOpts(cfg),
        headers: { 'Content-Type': 'application/json' },
        // 200/202 = sukses; 8xx GenieACS kadang balas 200 walau device offline
        validateStatus: s => s >= 200 && s < 300,
    });
    return r.data;
}

// ── Aksi: Ambil Status (refresh parameter dari device) ──
async function refreshDevice(genieId) {
    // refreshObject memaksa GenieACS ambil ulang subtree dari device.
    return kirimTask(genieId, {
        name: 'refreshObject',
        objectName: 'InternetGatewayDevice',
    });
}

// ── Aksi: Reboot ──
async function rebootDevice(genieId) {
    return kirimTask(genieId, { name: 'reboot' });
}

// ── Aksi: Ganti WiFi (SSID &/atau password) ──
async function setWifi(genieId, { ssid, password, manufacturer }) {
    const mfr = (manufacturer || '').toLowerCase();
    const base = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1';
    const parameterValues = [];
    if (ssid) parameterValues.push([`${base}.SSID`, ssid, 'xsd:string']);
    if (password) {
        if (mfr.includes('zte')) {
            // ZTE umumnya pakai KeyPassphrase
            parameterValues.push([`${base}.KeyPassphrase`, password, 'xsd:string']);
            parameterValues.push([`${base}.PreSharedKey.1.PreSharedKey`, password, 'xsd:string']);
        } else {
            // Huawei & umum: set keduanya (firmware beda pakai salah satu)
            parameterValues.push([`${base}.PreSharedKey.1.PreSharedKey`, password, 'xsd:string']);
            parameterValues.push([`${base}.KeyPassphrase`, password, 'xsd:string']);
        }
    }
    return kirimTask(genieId, { name: 'setParameterValues', parameterValues });
}

// ── Tes koneksi ke GenieACS ──
async function testConnection() {
    const cfg = await getGenieCfg();
    const url = `${cfg.url}/devices/?limit=1&projection=_id`;
    const r = await axios.get(url, authOpts(cfg));
    return { ok: true, url: cfg.url, count: Array.isArray(r.data) ? r.data.length : 0 };
}

module.exports = {
    getGenieCfg,
    cariIdBySerial,
    listDevices,
    getDevice,
    normalizeDevice,
    flattenParams,
    kirimTask,
    refreshDevice,
    rebootDevice,
    setWifi,
    testConnection,
};
