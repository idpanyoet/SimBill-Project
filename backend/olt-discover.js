const db = require('./config/db');
const olt = require('./services/olt');
(async () => {
  console.log('=== acs_link sample (format SN GenieACS) ===');
  try {
    const s = await db.query('SELECT serial_number, pelanggan_id FROM acs_link LIMIT 5');
    s.forEach(r => console.log(r.serial_number, '->', r.pelanggan_id));
    const c = await db.query('SELECT COUNT(*) AS n FROM acs_link');
    console.log('total acs_link:', c[0].n);
  } catch (e) { console.log('err acs_link:', e.message); }

  console.log('\n=== cek SN OLT "ZTXGCE24D67D" ada di acs_link (partial)? ===');
  try {
    const m = await db.query("SELECT serial_number, pelanggan_id FROM acs_link WHERE serial_number LIKE '%24D67D%'");
    console.log(m.length ? JSON.stringify(m) : '(tidak ada yang cocok partial 24D67D)');
  } catch (e) { console.log('err:', e.message); }

  console.log('\n=== cek Name "aris" cocok ke pelanggan.username? ===');
  try {
    const p = await db.query("SELECT id, nama, username, status FROM pelanggan WHERE username = 'aris' LIMIT 3");
    console.log(p.length ? JSON.stringify(p) : '(username "aris" tidak ada)');
  } catch (e) { console.log('err:', e.message); }

  console.log('\n=== OLT: show gpon onu baseinfo gpon-olt_1/8/1 ===');
  try {
    const o = olt.getOlt('c300');
    const cmd = 'show gpon onu baseinfo gpon-olt_1/8/1';
    const out = await olt.runCommands(o, ['terminal length 0', cmd]);
    console.log(out[cmd]);
  } catch (e) { console.log('err olt:', e.message); }

  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
