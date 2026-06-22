// Tes langsung ke Duitku — lihat respons mentah untuk satu metode
const { query } = require('/opt/simbill/backend/config/db');
const crypto = require('crypto');
const axios = require('axios');

(async () => {
  const rows = await query(`SELECT kunci,nilai FROM setting WHERE kunci IN
    ('pg_merchant_code_duitku','pg_api_key_duitku','pg_sandbox','app_url','pg_metode_aktif_duitku')`);
  const m = {}; rows.forEach(r => m[r.kunci]=r.nilai);

  const merchantCode = m.pg_merchant_code_duitku;
  const apiKey = m.pg_api_key_duitku;
  const sandbox = m.pg_sandbox !== '0';
  const appUrl = m.app_url || 'https://dash.rfnet.id';

  console.log('merchantCode:', merchantCode ? merchantCode.slice(0,4)+'****' : '(KOSONG)');
  console.log('apiKey      :', apiKey ? apiKey.slice(0,4)+'****'+' ('+apiKey.length+' char)' : '(KOSONG)');
  console.log('sandbox     :', sandbox);
  console.log('metode_aktif:', m.pg_metode_aktif_duitku);
  console.log('');

  const orderId = 'TEST'+Date.now().toString(36).toUpperCase();
  const amount = 50000;
  const metode = process.argv[2] || 'SP';  // default ShopeePay
  const sig = crypto.createHash('md5').update(`${merchantCode}${orderId}${amount}${apiKey}`).digest('hex');
  const url = sandbox
    ? 'https://sandbox.duitku.com/webapi/api/merchant/v2/inquiry'
    : 'https://passport.duitku.com/webapi/api/merchant/v2/inquiry';

  console.log('Tes metode:', metode, '| order:', orderId);
  try {
    const resp = await axios.post(url, {
      merchantCode, paymentAmount: amount, paymentMethod: metode,
      merchantOrderId: orderId, productDetails: 'Tes', email: 'test@test.id',
      phoneNumber: '081234567890', customerVaName: 'Test',
      callbackUrl: `${appUrl}/webhook/duitku`, returnUrl: `${appUrl}/pembayaran/selesai`,
      signature: sig, expiryPeriod: 60
    });
    console.log('✅ SUKSES:', JSON.stringify(resp.data, null, 2));
  } catch (e) {
    console.log('❌ GAGAL:', e.response?.status, JSON.stringify(e.response?.data || e.message));
  }
  process.exit(0);
})();
