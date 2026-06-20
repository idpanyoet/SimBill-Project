// services/acs.js — ACS TR-069 CWMP Service
// Menangani koneksi dari router pelanggan via protokol CWMP (TR-069)
'use strict';

const express = require('express');
const { query, queryOne } = require('../config/db');

// ── XML Helper ───────────────────────────────────────────────
function xmlVal(xml, tag) {
    const m = xml.match(new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${tag}>`, 'i'));
    return m ? m[1].trim() : null;
}

function xmlAllVals(xml, tag) {
    const re = new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[^:>]+:)?${tag}>`, 'gi');
    const vals = [];
    let m;
    while ((m = re.exec(xml)) !== null) vals.push(m[1].trim());
    return vals;
}

function xmlParam(xml) {
    // Parse <ParameterValueStruct> blocks
    const re = /<ParameterValueStruct[\s\S]*?<\/ParameterValueStruct>/gi;
    const params = {};
    let m;
    while ((m = re.exec(xml)) !== null) {
        const name  = xmlVal(m[0], 'Name');
        const value = xmlVal(m[0], 'Value');
        if (name) params[name] = value || '';
    }
    return params;
}

// ── SOAP Builder ──────────────────────────────────────────────
function soapEnv(body) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope
  xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:cwmp="urn:dslforum-org:cwmp-1-2">
<SOAP-ENV:Header>
  <cwmp:ID SOAP-ENV:mustUnderstand="1">1</cwmp:ID>
</SOAP-ENV:Header>
<SOAP-ENV:Body>${body}</SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
}

function soapInformResponse() {
    return soapEnv(`<cwmp:InformResponse><MaxEnvelopes>1</MaxEnvelopes></cwmp:InformResponse>`);
}

function soapGetParam(params) {
    const list = params.map(p => `<string>${p}</string>`).join('');
    return soapEnv(`
<cwmp:GetParameterValues>
  <ParameterNames SOAP-ENC:arrayType="xsd:string[${params.length}]">${list}</ParameterNames>
</cwmp:GetParameterValues>`);
}

function soapSetParam(pairs) {
    // pairs = [{name, value, type}]
    const list = pairs.map(p =>
        `<ParameterValueStruct>
           <Name>${p.name}</Name>
           <Value xsi:type="${p.type || 'xsd:string'}">${p.value}</Value>
         </ParameterValueStruct>`
    ).join('');
    return soapEnv(`
<cwmp:SetParameterValues>
  <ParameterList SOAP-ENC:arrayType="cwmp:ParameterValueStruct[${pairs.length}]">${list}</ParameterList>
  <ParameterKey>netbilling</ParameterKey>
</cwmp:SetParameterValues>`);
}

function soapReboot() {
    return soapEnv(`<cwmp:Reboot><CommandKey>netbilling-reboot</CommandKey></cwmp:Reboot>`);
}

function soapEmpty() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
<SOAP-ENV:Body></SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
}

// ── Parameter map per vendor ──────────────────────────────────
function getWifiParams(manufacturer) {
    const mfr = (manufacturer || '').toLowerCase();
    if (mfr.includes('huawei') || mfr.includes('hg8')) {
        return {
            ssid:     'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
            password: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey',
            enabled:  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable',
        };
    }
    if (mfr.includes('zte')) {
        return {
            ssid:     'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
            password: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase',
            enabled:  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable',
        };
    }
    // Generic TR-069 (TP-Link, dll)
    return {
        ssid:     'Device.WiFi.SSID.1.SSID',
        password: 'Device.WiFi.AccessPoint.1.Security.KeyPassphrase',
        enabled:  'Device.WiFi.SSID.1.Enable',
    };
}

// Parameter optik (redaman) ONU per vendor. Partial-path agar tidak memicu
// SOAP Fault "Invalid parameter name" jika leaf-nya tidak ada.
function redamanParams(manufacturer) {
    const mfr = (manufacturer || '').toLowerCase();
    if (mfr.includes('zte')) return ['InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.'];
    if (mfr.includes('huawei') || mfr.includes('hg')) return ['InternetGatewayDevice.WANDevice.1.X_HW_WANGponInterfaceConfig.'];
    if (mfr.includes('fiberhome') || mfr.includes('fh')) return ['InternetGatewayDevice.WANDevice.1.X_FH_GponInterfaceConfig.'];
    // Fallback paling aman: seluruh subtree WANDevice (mengandung param optik)
    return ['InternetGatewayDevice.WANDevice.1.'];
}

function getStatusParams(manufacturer) {
    const mfr = (manufacturer || '').toLowerCase();
    if (mfr.includes('huawei') || mfr.includes('zte') || mfr.includes('hg')) {
        return [
            'InternetGatewayDevice.DeviceInfo.UpTime',
            'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
            'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
            'InternetGatewayDevice.LANDevice.1.Hosts.HostNumberOfEntries',
            'InternetGatewayDevice.LANDevice.1.Hosts.Host.',
            'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
        ];
    }
    return [
        'Device.DeviceInfo.UpTime',
        'Device.DeviceInfo.SoftwareVersion',
        'Device.IP.Interface.1.IPv4Address.1.IPAddress',
        'Device.Hosts.HostNumberOfEntries',
        'Device.Hosts.Host.',
        'Device.WiFi.SSID.1.SSID',
    ];
}

// ── Middleware: parse raw XML body ────────────────────────────
function rawXmlParser(req, res, next) {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => data += chunk);
    req.on('end', () => { req.rawBody = data; next(); });
}

// ── CWMP Router ───────────────────────────────────────────────
function createCwmpRouter() {
    const router = express.Router();
    router.use(rawXmlParser);

    router.post('/', async (req, res) => {
        try {
            const xml = req.rawBody || '';
            res.setHeader('Content-Type', 'text/xml; charset=utf-8');

            // Kosong = device menunggu perintah
            if (!xml || xml.trim().length < 10) {
                return await handleEmpty(req, res);
            }

            // Detect method
            if (xml.includes('Inform')) {
                return await handleInform(req, res, xml);
            }
            if (xml.includes('GetParameterValuesResponse')) {
                return await handleGetParamResponse(req, res, xml);
            }
            if (xml.includes('SetParameterValuesResponse')) {
                return await handleSetParamResponse(req, res, xml);
            }
            if (xml.includes('RebootResponse')) {
                return await handleRebootResponse(req, res, xml);
            }
            if (xml.includes('Fault')) {
                return await handleFault(req, res, xml);
            }

            // Default kosong
            res.status(204).end();
        } catch(e) {
            console.error('[ACS]', e.message);
            res.status(204).end();
        }
    });

    return router;
}

// ── Handler: Inform ───────────────────────────────────────────
async function handleInform(req, res, xml) {
    const serialNumber = xmlVal(xml, 'SerialNumber');
    const productClass = xmlVal(xml, 'ProductClass');
    const manufacturer = xmlVal(xml, 'Manufacturer');
    const oui          = xmlVal(xml, 'OUI');
    const swVersion    = xmlVal(xml, 'SoftwareVersion');
    const hwVersion    = xmlVal(xml, 'HardwareVersion');
    const connReqUrl   = xmlVal(xml, 'ConnectionRequestURL');
    const reqIp        = req.ip?.replace('::ffff:', '') || req.connection?.remoteAddress || '';

    // Parse parameter values dari Inform
    const params = xmlParam(xml);

    // Ambil IP WAN dari parameter yang dikirim router
    const wanIpKeys = [
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
        'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
        'Device.IP.Interface.1.IPv4Address.1.IPAddress',
    ];
    let ip = reqIp;
    for (const key of wanIpKeys) {
        if (params[key] && params[key] !== '0.0.0.0') { ip = params[key]; break; }
    }

    // Jika IP dari req adalah IP VPS sendiri, coba ambil dari X-Forwarded-For
    const xForwardedFor = req.headers['x-forwarded-for'];
    if (xForwardedFor && ip === reqIp) {
        const forwardedIp = xForwardedFor.split(',')[0].trim();
        if (forwardedIp && forwardedIp !== '127.0.0.1') ip = forwardedIp;
    }

    console.log(`[ACS] Inform dari ${serialNumber} (${manufacturer} ${productClass}) IP:${ip}`);

    if (serialNumber) {
        try {
            await query(`
                INSERT INTO acs_device
                  (serial_number, product_class, manufacturer, oui, software_version,
                   hardware_version, ip_address, connection_url, last_inform, status, param_cache)
                VALUES (?,?,?,?,?,?,?,?,NOW(),'online',?)
                ON DUPLICATE KEY UPDATE
                  product_class=VALUES(product_class), manufacturer=VALUES(manufacturer),
                  oui=VALUES(oui), software_version=VALUES(software_version),
                  hardware_version=VALUES(hardware_version), ip_address=VALUES(ip_address),
                  connection_url=COALESCE(VALUES(connection_url),connection_url),
                  last_inform=NOW(), status='online',
                  param_cache=IF(VALUES(param_cache)!='{}',VALUES(param_cache),param_cache)
            `, [serialNumber, productClass, manufacturer, oui, swVersion, hwVersion,
                ip, connReqUrl, JSON.stringify(params)]);
        } catch(e) { console.warn('[ACS] DB upsert:', e.message); }
    }

    res.status(200).send(soapInformResponse());
}

// ── Handler: Empty (device poll) ─────────────────────────────
async function handleEmpty(req, res) {
    const ip = req.ip?.replace('::ffff:', '') || '';
    const xForwardedFor = req.headers['x-forwarded-for'];
    const realIp = xForwardedFor ? xForwardedFor.split(',')[0].trim() : ip;

    let device = null;
    try {
        // Cari device berdasarkan IP (coba beberapa kemungkinan IP)
        device = await queryOne(
            `SELECT * FROM acs_device WHERE (ip_address=? OR ip_address=?) AND last_inform > DATE_SUB(NOW(), INTERVAL 15 MINUTE) ORDER BY last_inform DESC LIMIT 1`,
            [realIp, ip]
        );
        // Fallback: device yang paling baru inform dalam 2 menit terakhir
        if (!device) {
            device = await queryOne(
                `SELECT * FROM acs_device WHERE last_inform > DATE_SUB(NOW(), INTERVAL 2 MINUTE) ORDER BY last_inform DESC LIMIT 1`
            );
        }
    } catch(e) {}

    if (!device) return res.status(204).end();

    // Cek apakah ada task pending untuk device ini
    let task = null;
    try {
        task = await queryOne(
            'SELECT * FROM acs_task WHERE device_id=? AND status="pending" ORDER BY id ASC LIMIT 1',
            [device.id]
        );
    } catch(e) {}

    if (!task) return res.status(204).end();

    // Tandai task sedang berjalan
    await query('UPDATE acs_task SET status="running" WHERE id=?', [task.id]).catch(()=>{});

    let soapBody = '';
    if (task.type === 'GetParameterValues') {
        const params = getStatusParams(device.manufacturer);
        soapBody = soapGetParam(params);
    } else if (task.type === 'GetRedaman') {
        soapBody = soapGetParam(redamanParams(device.manufacturer));
    } else if (task.type === 'SetParameterValues') {
        const pairs = JSON.parse(task.params || '[]');
        soapBody = soapSetParam(pairs);
    } else if (task.type === 'Reboot') {
        soapBody = soapReboot();
    }

    res.status(200).send(soapBody);
}

// ── Handler: GetParameterValues Response ──────────────────────
async function handleGetParamResponse(req, res, xml) {
    const ip = req.ip?.replace('::ffff:', '') || '';
    const params = xmlParam(xml);

    try {
        const device = await queryOne('SELECT * FROM acs_device WHERE ip_address=?', [ip]);
        if (device) {
            // Merge params ke cache
            let cache = {};
            try { cache = JSON.parse(device.param_cache || '{}'); } catch(e) {}
            Object.assign(cache, params);
            await query('UPDATE acs_device SET param_cache=? WHERE id=?',
                [JSON.stringify(cache), device.id]);

            // Tandai task done
            await query('UPDATE acs_task SET status="done", result=?, done_at=NOW() WHERE device_id=? AND status="running" AND type IN ("GetParameterValues","GetRedaman")',
                [JSON.stringify(params), device.id]);
        }
    } catch(e) { console.warn('[ACS] GetParam response:', e.message); }

    res.status(204).end();
}

// ── Handler: SetParameterValues Response ──────────────────────
async function handleSetParamResponse(req, res, xml) {
    const ip = req.ip?.replace('::ffff:', '') || '';
    try {
        const device = await queryOne('SELECT id FROM acs_device WHERE ip_address=?', [ip]);
        if (device) {
            await query('UPDATE acs_task SET status="done", done_at=NOW() WHERE device_id=? AND status="running" AND type="SetParameterValues"', [device.id]);
        }
    } catch(e) {}
    res.status(204).end();
}

// ── Handler: Reboot Response ──────────────────────────────────
async function handleRebootResponse(req, res, xml) {
    const ip = req.ip?.replace('::ffff:', '') || '';
    try {
        const device = await queryOne('SELECT id FROM acs_device WHERE ip_address=?', [ip]);
        if (device) {
            await query('UPDATE acs_task SET status="done", done_at=NOW() WHERE device_id=? AND status="running" AND type="Reboot"', [device.id]);
        }
    } catch(e) {}
    res.status(204).end();
}

// ── Handler: Fault ────────────────────────────────────────────
async function handleFault(req, res, xml) {
    const ip = req.ip?.replace('::ffff:', '') || '';
    const faultCode   = xmlVal(xml, 'FaultCode') || xmlVal(xml, 'faultcode') || '?';
    const faultString = xmlVal(xml, 'FaultString') || xmlVal(xml, 'faultstring') || 'Unknown';
    console.warn(`[ACS] Fault dari ${ip}: ${faultCode} - ${faultString}`);
    try {
        const device = await queryOne('SELECT id FROM acs_device WHERE ip_address=?', [ip]);
        if (device) {
            await query('UPDATE acs_task SET status="failed", result=?, done_at=NOW() WHERE device_id=? AND status="running"',
                [faultCode + ': ' + faultString, device.id]);
        }
    } catch(e) {}
    res.status(204).end();
}

// ── Export helpers untuk route admin ─────────────────────────
module.exports = {
    createCwmpRouter,
    getWifiParams,
    getStatusParams,
    soapSetParam,
    soapReboot,
    soapGetParam
};
