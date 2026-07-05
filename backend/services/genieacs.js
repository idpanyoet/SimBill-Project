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
    let url = (m.genieacs_url || 'http://127.0.0.1:7557').trim().replace(/\/+$/, '');
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
    if (cur && typeof cur === 'object') {
        // Node GenieACS: ambil _value bila ada; kalau objek tanpa _value
        // (mis. parameter belum terisi) → null, hindari "[object Object]".
        return ('_value' in cur) ? cur._value : null;
    }
    return cur;
}

// ── Helper: cari nilai RX power di mana pun dalam subtree (lintas vendor) ──
function deepFindRx(obj, depth) {
    depth = depth || 0;
    if (!obj || typeof obj !== 'object' || depth > 8) return null;
    const keys = Object.keys(obj);
    // 1) cek key yang namanya RXPower-like di level ini
    for (const k of keys) {
        if (/^(RXPower|RxPower|RXOpticalPower|RXOpticalLevel|OpticalReceivePower)$/i.test(k)) {
            const node = obj[k];
            const val = (node && typeof node === 'object' && '_value' in node) ? node._value : node;
            if (val != null && val !== '' && !isNaN(parseFloat(val))) return val;
        }
    }
    // 2) telusuri anak (lewati node meta _xxx)
    for (const k of keys) {
        if (k[0] === '_') continue;
        const child = obj[k];
        if (child && typeof child === 'object') {
            const found = deepFindRx(child, depth + 1);
            if (found != null) return found;
        }
    }
    return null;
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
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANIPConnection.1.ExternalIPAddress',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANIPConnection.1.ExternalIPAddress',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANIPConnection.1.ExternalIPAddress',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.ExternalIPAddress',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.ExternalIPAddress',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.1.ExternalIPAddress',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Username',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.3.WANPPPConnection.1.Username',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.4.WANPPPConnection.1.Username',
        // RX optik (redaman) — path beda per vendor
        'VirtualParameters.RXPower',
        'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.X_HW_WANGponInterfaceConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.X_GponInterfaceConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.X_CT-COM_WANGponLinkConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.X_CMCC_WANGponInterfaceConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.X_CU_WANGponInterfaceConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.TXPower',
        'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.RXPower',
        'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.TXPower',
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
    // Username PPPoE & IP WAN — bisa berada di WANConnectionDevice index mana pun
    // (sebagian ONU mis. XPON menaruhnya di .2/.3, bukan .1). Scan semua index.
    const wcdAll = ((igd.WANDevice || {})['1'] || {}).WANConnectionDevice || {};
    let pppUsername = '';
    let wanIp = '';
    // Scan SEMUA index WANConnectionDevice.* DAN semua WANPPPConnection.* /
    // WANIPConnection.* di dalamnya. Sebagian ONU (mis. ZTE F463N) menaruh
    // koneksi INTERNET di index .2/.3, bukan .1 (yang .1 sering TR069/mgmt) —
    // kalau cuma baca .1, IP & username PPPoE tidak ketemu (tampil 0.0.0.0/"–").
    const ambilKoneksi = (parent, type) => {
        const all = parent[type] || {};
        for (const j of Object.keys(all)) {
            if (j[0] === '_') continue;
            const c = all[j] || {};
            const ip   = gv(c, 'ExternalIPAddress');
            const user = (type === 'WANPPPConnection') ? gv(c, 'Username') : '';
            if (ip && ip !== '0.0.0.0') {
                // koneksi aktif (punya IP WAN) → sumber paling andal
                wanIp = ip;
                if (user) pppUsername = user;
            } else {
                if (!wanIp && ip) wanIp = ip;                 // simpan 0.0.0.0 sbg fallback
                if (user && !pppUsername) pppUsername = user; // username fallback
            }
        }
    };
    for (const idx of Object.keys(wcdAll)) {
        if (idx[0] === '_') continue;
        const wcd = wcdAll[idx] || {};
        ambilKoneksi(wcd, 'WANPPPConnection');
        ambilKoneksi(wcd, 'WANIPConnection');
    }
    const ssid = gv(igd, 'LANDevice.1.WLANConfiguration.1.SSID') || '';
    // RX optik (redaman) — coba beberapa path vendor
    const wd = (igd.WANDevice || {})['1'] || {};
    let rxPower = gv(d, 'VirtualParameters.RXPower')   // sudah dBm, lintas-vendor (paling andal)
               ?? gv(wd, 'X_ZTE-COM_WANPONInterfaceConfig.RXPower')
               ?? gv(wd, 'X_HW_WANGponInterfaceConfig.RXPower')
               ?? gv(wd, 'X_GponInterafceConfig.RXPower')
               ?? gv(wd, 'X_GponInterfaceConfig.RXPower')
               ?? gv(wd, 'WANPONInterfaceConfig.RXPower')
               ?? gv(wd, 'X_CT-COM_WANGponLinkConfig.RXPower')
               ?? gv(wd, 'X_CT-COM_EponInterfaceConfig.RXPower')
               ?? gv(wd, 'X_CT-COM_GponInterfaceConfig.RXPower')
               ?? gv(wd, 'X_CMCC_WANGponInterfaceConfig.RXPower')
               ?? gv(wd, 'X_CU_WANGponInterfaceConfig.RXPower')
               ?? deepFindRx(wd)   // fallback lintas-vendor: cari key RXPower di mana pun
               ?? null;
    // normalisasi: hasilkan dBm.
    //  - Nilai POSITIF = satuan linier (mis. EPON CT-COM dalam 0.1 µW):
    //      µW = v*0.1 → dBm = 10*log10(µW/1000) = 10*log10(v/10000)
    //  - Nilai sangat negatif (< -1000) = satuan 0.001 dBm → /1000
    //  - Selain itu sudah dBm.
    if (rxPower !== null && rxPower !== '' && !isNaN(parseFloat(rxPower))) {
        let v = parseFloat(rxPower);
        if (v > 0) {
            v = 10 * Math.log10(v / 10000);     // linier (0.1 µW) → dBm
        } else if (v < -1000) {
            v = v / 1000;                        // 0.001 dBm → dBm
        }
        rxPower = (isFinite(v)) ? Math.round(v * 100) / 100 : null;
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
    try {
        const r = await axios.post(url, task, {
            ...authOpts(cfg),
            // connection_request membuat GenieACS MENUNGGU ONU merespons; beri
            // waktu lebih lama dari default 15s agar ONU yang agak lambat sempat.
            timeout: 25000,
            headers: { 'Content-Type': 'application/json' },
            // 200/202 = sukses; 8xx GenieACS kadang balas 200 walau device offline
            validateStatus: s => s >= 200 && s < 300,
        });
        return r.data;
    } catch (e) {
        // PENTING: timeout connection_request BUKAN kegagalan. Task sudah masuk
        // antrian GenieACS dan akan dijalankan saat ONU terhubung / inform
        // berikutnya. Jadi kembalikan status "antri", bukan lempar error.
        if (e.code === 'ECONNABORTED' || /timeout/i.test(e.message || '')) {
            return { _queued: true, _timeout: true };
        }
        throw e;
    }
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
// ── Aksi: Ganti WiFi (SSID &/atau password) — tahan banting lintas vendor ──
// Strategi aman: BACA dulu tree device, lalu tulis HANYA ke path yang benar-benar
// ada (hindari CWMP fault 9005 karena path tidak ada). Ikut ubah semua radio
// (2.4 & 5 GHz) dan dukung TR-181 (Device.WiFi...) untuk ONU baru.
async function setWifi(genieId, { ssid, password, manufacturer }) {
    let raw = null;
    try { raw = await getDevice(genieId); } catch (e) { raw = null; }
    const parameterValues = [];
    const has = (obj, key) => obj && typeof obj === 'object' && (key in obj);

    // Huawei HG814x/HS814x menolak (CWMP 9002) bila KeyPassphrase dan
    // PreSharedKey.1.PreSharedKey ditulis BERSAMAAN — PreSharedKey turunan
    // dari KeyPassphrase. Untuk Huawei: tulis HANYA KeyPassphrase.
    const mfrRaw = String(
        manufacturer ||
        (((raw || {})._deviceId || {})._Manufacturer) || ''
    ).toLowerCase();
    const isHuawei = mfrRaw.includes('huawei') ||
                     String(genieId || '').startsWith('00259E') ||
                     /hg8\d|hs8\d|eg8\d/.test(mfrRaw);

    if (raw && raw.Device && raw.Device.WiFi) {
        // ── TR-181 ──
        const wifi = raw.Device.WiFi;
        const ssidObjs = wifi.SSID || {};
        for (const i of Object.keys(ssidObjs)) {
            if (i[0] === '_') continue;
            if (ssid && has(ssidObjs[i], 'SSID'))
                parameterValues.push([`Device.WiFi.SSID.${i}.SSID`, ssid, 'xsd:string']);
        }
        const aps = wifi.AccessPoint || {};
        for (const i of Object.keys(aps)) {
            if (i[0] === '_') continue;
            const sec = (aps[i] || {}).Security || {};
            if (password && has(sec, 'KeyPassphrase'))
                parameterValues.push([`Device.WiFi.AccessPoint.${i}.Security.KeyPassphrase`, password, 'xsd:string']);
        }
    } else if (raw) {
        // ── TR-098 (InternetGatewayDevice) ──
        const wlanRoot = ((((raw.InternetGatewayDevice || {}).LANDevice || {})['1'] || {}).WLANConfiguration) || {};
        for (const i of Object.keys(wlanRoot)) {
            if (i[0] === '_') continue;
            const w = wlanRoot[i] || {};
            // Hanya proses radio yang "ada" (punya node SSID).
            if (!has(w, 'SSID')) continue;
            const base = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}`;
            if (ssid) parameterValues.push([`${base}.SSID`, ssid, 'xsd:string']);
            if (password) {
                let tulisPass = 0;
                // Tulis hanya ke parameter password yang ADA di node ini.
                if (has(w, 'KeyPassphrase')) {
                    parameterValues.push([`${base}.KeyPassphrase`, password, 'xsd:string']); tulisPass++;
                }
                const psk1 = (w.PreSharedKey || {})['1'] || {};
                // Huawei: JANGAN tulis PreSharedKey bila KeyPassphrase sudah ditulis
                // (menulis keduanya bikin CWMP fault 9002). Vendor lain: tetap tulis.
                if (has(psk1, 'PreSharedKey') && !(isHuawei && tulisPass > 0)) {
                    parameterValues.push([`${base}.PreSharedKey.1.PreSharedKey`, password, 'xsd:string']); tulisPass++;
                }
                // Vendor-spesifik (tulis hanya bila ada).
                if (has(w, 'X_CT-COM_WPAKey')) {
                    parameterValues.push([`${base}.X_CT-COM_WPAKey`, password, 'xsd:string']); tulisPass++;
                }
                if (has(w, 'WPAKey')) {
                    parameterValues.push([`${base}.WPAKey`, password, 'xsd:string']); tulisPass++;
                }
                if (has(w, 'PreSharedKeyValue')) {
                    parameterValues.push([`${base}.PreSharedKeyValue`, password, 'xsd:string']); tulisPass++;
                }
                // Best-effort: radio ada SSID tapi parameter password tak terdeteksi
                // di tree (mis. write-only) → coba 2 path standar TR-098.
                if (tulisPass === 0) {
                    parameterValues.push([`${base}.KeyPassphrase`, password, 'xsd:string']);
                    parameterValues.push([`${base}.PreSharedKey.1.PreSharedKey`, password, 'xsd:string']);
                }
            }
        }
    }

    // Fallback: device tak terbaca / tak ada path terdeteksi → perilaku lama
    // (WLANConfiguration.1) agar tidak mundur untuk ONU umum.
    if (parameterValues.length === 0) {
        const mfr = (manufacturer || '').toLowerCase();
        const base = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1';
        if (ssid) parameterValues.push([`${base}.SSID`, ssid, 'xsd:string']);
        if (password) {
            if (mfr.includes('zte')) {
                parameterValues.push([`${base}.KeyPassphrase`, password, 'xsd:string']);
                parameterValues.push([`${base}.PreSharedKey.1.PreSharedKey`, password, 'xsd:string']);
            } else if (isHuawei || mfr.includes('huawei')) {
                // Huawei: cukup KeyPassphrase (menulis PreSharedKey bareng bikin 9002)
                parameterValues.push([`${base}.KeyPassphrase`, password, 'xsd:string']);
            } else {
                parameterValues.push([`${base}.PreSharedKey.1.PreSharedKey`, password, 'xsd:string']);
                parameterValues.push([`${base}.KeyPassphrase`, password, 'xsd:string']);
            }
        }
    }

    return kirimTask(genieId, { name: 'setParameterValues', parameterValues });
}

// ── Tes koneksi ke GenieACS ──
async function testConnection(urlOverride) {
    const cfg = await getGenieCfg();
    const base = (urlOverride && String(urlOverride).trim())
        ? String(urlOverride).trim().replace(/\/+$/, '')
        : cfg.url;
    const url = `${base}/devices/?limit=1&projection=_id`;
    const r = await axios.get(url, authOpts(cfg));
    return { ok: true, url: base, count: Array.isArray(r.data) ? r.data.length : 0 };
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
