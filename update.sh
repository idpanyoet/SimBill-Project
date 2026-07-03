#!/usr/bin/env bash
# =============================================================================
#  SimBill — Update Script
#  Jalankan: wget -qO- https://raw.githubusercontent.com/idpanyoet/SimBill-Project/master/update.sh | sudo bash
#
#  Update aman berbasis git:
#   - backup kode + .env dulu (untuk rollback)
#   - git pull versi terbaru dari master repo customer (SimBill-Project, PUBLIC,
#     isinya build TEROBFUSCATE) — JAGA .env, uploads, node_modules
#   - npm install dependensi baru
#   - restart pm2
#
#  CATATAN: repo customer (SimBill-Project) master = build terobfuscate.
#  Source plain ada di repo TERPISAH & PRIVAT (SimBill-Source) — tidak disentuh
#  script ini. 'git reset --hard origin/master' memakai origin repo LOKAL,
#  jadi commit/perubahan lokal yang belum di-commit akan hilang: commit dulu.
# =============================================================================
set -e

APP_DIR="/opt/simbill"
BACKEND_DIR="${APP_DIR}/backend"
BACKUP_DIR="${APP_DIR}/_backup"
PM2_NAME="billing-radius"
BRANCH="master"

c_ok()   { echo -e "\033[32m✓\033[0m $1"; }
c_info() { echo -e "\033[36mℹ\033[0m $1"; }
c_err()  { echo -e "\033[31m✗\033[0m $1"; }

echo "============================================================"
echo "  SimBill — Update"
echo "============================================================"

# 0) Pastikan berjalan di folder app + ada git
if [ ! -d "$APP_DIR/.git" ]; then
    c_err "Folder $APP_DIR bukan repo git. Update via git tidak bisa dijalankan."
    c_info "Pastikan SimBill di-clone dari GitHub (ada folder .git)."
    exit 1
fi
cd "$APP_DIR"

# 1) Backup kode + .env (untuk rollback)
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/backup-${STAMP}.tar.gz"
c_info "Membuat backup ke ${BACKUP_FILE} ..."
tar czf "$BACKUP_FILE" \
    --exclude=node_modules \
    --exclude=_backup \
    --exclude=.git \
    -C "$APP_DIR" . 2>/dev/null && c_ok "Backup dibuat" \
    || c_info "Backup best-effort (lanjut)"

# 2) Simpan .env (jaga-jaga) + pastikan tidak ke-overwrite git
if [ -f "${BACKEND_DIR}/.env" ]; then
    cp "${BACKEND_DIR}/.env" "${BACKUP_DIR}/.env.${STAMP}"
    c_ok ".env diamankan"
fi

# 3) Pastikan perubahan lokal (selain .env/uploads) tidak menghalangi pull
#    .env & uploads sudah di .gitignore, jadi aman. Reset file kode lokal
#    agar git pull mulus (file kode = ikut versi GitHub).
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
VERSI_LAMA=$(git rev-parse --short HEAD 2>/dev/null || echo "?")
c_info "Versi saat ini: ${VERSI_LAMA}"

# Stash perubahan lokal yang tidak perlu (kalau ada), lalu pull
git fetch origin "$BRANCH" 2>&1 | tail -1
# buang perubahan lokal pada file yang dilacak (kode), JANGAN sentuh untracked (.env, uploads)
git checkout -- . 2>/dev/null || true
git reset --hard "origin/${BRANCH}" 2>&1 | tail -1
c_ok "Kode diperbarui ke versi terbaru"

VERSI_BARU=$(git rev-parse --short HEAD 2>/dev/null || echo "?")
c_info "Versi baru: ${VERSI_BARU}"

# 4) Install dependensi (kalau package.json berubah)
if [ -f "${BACKEND_DIR}/package.json" ]; then
    cd "$BACKEND_DIR"

    # Pastikan registry npm resmi SEBELUM install. Sebagian VPS (Tencent Cloud/China)
    # default memakai mirror lokal (mirrors.tencentyun.com) yang kerap tidak dapat
    # diakses → npm install gagal "ENOTFOUND / network" & update mati di tengah.
    CUR_REG="$(npm config get registry 2>/dev/null)"
    case "$CUR_REG" in
      *registry.npmjs.org*)
        curl -fsS -m 8 -o /dev/null https://registry.npmjs.org/express 2>/dev/null \
          || npm config set registry https://registry.npmjs.org/ >/dev/null 2>&1 ;;
      *)
        c_info "Registry npm ($CUR_REG) bukan resmi — mengalihkan ke registry.npmjs.org"
        npm config set registry https://registry.npmjs.org/ >/dev/null 2>&1 ;;
    esac
    npm config delete proxy >/dev/null 2>&1 || true
    npm config delete https-proxy >/dev/null 2>&1 || true
    npm config set fetch-retries 5 >/dev/null 2>&1 || true
    npm config set fetch-timeout 300000 >/dev/null 2>&1 || true

    c_info "Menginstal dependensi (npm install) ..."
    # JANGAN exit bila npm gagal: dependensi lama kemungkinan sudah ada, dan
    # menghentikan update di tengah (kode sudah ter-pull) justru merusak. Cukup
    # peringatkan; safety-net ensure_dep di bawah akan memverifikasi modul kritis.
    npm install --no-audit --no-fund 2>&1 | tail -3
    if [ "${PIPESTATUS[0]}" -eq 0 ]; then
        c_ok "Dependensi siap"
    else
        c_info "npm install ada peringatan (lanjut; modul kritis dicek di tahap berikutnya)"
    fi
else
    c_err "package.json tidak ditemukan di ${BACKEND_DIR} — lewati npm install"
fi

# 4a) Safety-net dependensi modul OLT.
#     ssh2 pernah hilang dari package.json rilis lama → server crash-loop
#     ("Cannot find module 'ssh2'") & semua endpoint /api/olt jadi 404.
#     Di sini kita VERIFIKASI tiap modul kritis benar-benar bisa di-require;
#     kalau belum ada (mis. node_modules nyangkut / rilis lama), pasang otomatis.
ensure_dep() {
    local mod="$1"
    if node -e "require('${mod}')" >/dev/null 2>&1; then
        return 0
    fi
    c_info "Dependensi '${mod}' belum terpasang — menginstal ..."
    if npm install "${mod}" --no-audit --no-fund >/dev/null 2>&1; then
        c_ok "'${mod}' terpasang"
    else
        c_err "Gagal pasang '${mod}' — coba manual: cd ${BACKEND_DIR} && npm install ${mod}"
    fi
    return 0
}
if [ -d "$BACKEND_DIR" ]; then
    cd "$BACKEND_DIR"
    ensure_dep ssh2
    ensure_dep net-snmp
fi

# 4a-2) BlastRADIUS (CVE-2024-3596): paksa require_message_authenticator = yes.
#   Default FreeRADIUS 3.2.5+ = 'auto' → request PERTAMA tiap NAS baru di-drop
#   ("no response") sambil "belajar". MikroTik kirim Message-Authenticator,
#   jadi aman dipaksa 'yes'. Idempotent: dijalankan tiap update.
RADDIR="$(ls -d /etc/freeradius/*/ 2>/dev/null | head -1)"
if [ -n "$RADDIR" ] && [ -f "${RADDIR}radiusd.conf" ]; then
    RADCONF="${RADDIR}radiusd.conf"
    if grep -qE '^[[:space:]]*require_message_authenticator[[:space:]]*=' "$RADCONF"; then
        if ! grep -qE '^[[:space:]]*require_message_authenticator[[:space:]]*=[[:space:]]*yes' "$RADCONF"; then
            sed -i -E 's|^([[:space:]]*)require_message_authenticator[[:space:]]*=.*|\1require_message_authenticator = yes|' "$RADCONF"
            systemctl restart freeradius >/dev/null 2>&1 || true
            c_ok "BlastRADIUS: require_message_authenticator = yes"
        fi
    fi
fi

# 4a-3) Safety-net config xl2tpd: kalau xl2tpd terpasang tapi /etc/xl2tpd/xl2tpd.conf
#   masih file CONTOH (semua ';', tidak ada [lns] aktif) → semua peer L2TP ditolak
#   "No Authorization". Tulis config benar HANYA jika belum ada [lns] aktif; config
#   valid (skema IP-mu sendiri) TIDAK disentuh.
if command -v xl2tpd >/dev/null 2>&1; then
    if ! grep -qE '^[[:space:]]*\[lns' /etc/xl2tpd/xl2tpd.conf 2>/dev/null; then
        c_info "xl2tpd.conf belum punya [lns] aktif — menulis config default SimBill"
        mkdir -p /etc/xl2tpd
        cat > /etc/xl2tpd/xl2tpd.conf <<'XL2'
[global]
[lns default]
  ip range = 10.10.29.10-10.10.29.100
  local ip = 10.10.29.1
  require chap = yes
  refuse pap = no
  require authentication = yes
  ppp debug = yes
  pppoptfile = /etc/ppp/options.l2tpd.lns
  length bit = yes
XL2
        [ -f /etc/ppp/options.l2tpd.lns ] || cat > /etc/ppp/options.l2tpd.lns <<'PPPO'
ipcp-accept-local
ipcp-accept-remote
require-chap
refuse-pap
auth
name l2tpd
ms-dns 8.8.8.8
ms-dns 1.1.1.1
asyncmap 0
noccp
nodefaultroute
proxyarp
mtu 1400
mru 1400
lcp-echo-interval 30
lcp-echo-failure 4
connect-delay 5000
PPPO
        systemctl restart xl2tpd >/dev/null 2>&1 || true
        c_ok "xl2tpd.conf diperbaiki ([lns default] aktif)"
    fi
fi

# 4a-4) Safety-net WireGuard: kalau wireguard-tools TERPASANG & kernel MENDUKUNG,
#   tapi /etc/wireguard/wg0.conf BELUM ADA → tombol "Start" WireGuard di panel
#   gagal ("wg0.conf does not exist"). Buat config server minimal (keypair + NAT +
#   ListenPort) + aktifkan ip_forward + buka UDP 51820. Idempotent & aman:
#   config yang SUDAH ADA sama sekali TIDAK disentuh; hanya dibuat bila belum ada.
if command -v wg >/dev/null 2>&1 && [ ! -f /etc/wireguard/wg0.conf ]; then
    # Pastikan kernel benar-benar bisa membuat interface wireguard dulu
    if modprobe wireguard 2>/dev/null && ip link add dev _wgchk type wireguard 2>/dev/null; then
        ip link del _wgchk 2>/dev/null || true
        c_info "WireGuard terpasang tapi belum ada wg0.conf — membuat config server ..."
        mkdir -p /etc/wireguard && chmod 700 /etc/wireguard
        WG_IFACE="$(ip route get 8.8.8.8 2>/dev/null | grep -oP 'dev \K\S+' | head -1)"
        [ -z "$WG_IFACE" ] && WG_IFACE="eth0"
        (
          umask 077
          WG_PRIV="$(wg genkey)"
          printf '%s' "$WG_PRIV" | wg pubkey > /etc/wireguard/server_public.key
          cat > /etc/wireguard/wg0.conf <<WGCONF
[Interface]
Address = 10.20.0.1/24
ListenPort = 51820
PrivateKey = ${WG_PRIV}
PostUp   = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -A FORWARD -o wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o ${WG_IFACE} -j MASQUERADE
PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -D FORWARD -o wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o ${WG_IFACE} -j MASQUERADE
WGCONF
          chmod 600 /etc/wireguard/wg0.conf
        ) && c_ok "wg0.conf dibuat (NAT via ${WG_IFACE})" || c_err "Gagal membuat wg0.conf"
        # ip_forward (wajib untuk routing tunnel), permanen
        sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
        grep -q '^net.ipv4.ip_forward=1' /etc/sysctl.conf 2>/dev/null || echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf
        # buka UDP 51820 (idempotent — cek dulu sebelum insert)
        iptables -C INPUT -p udp --dport 51820 -j ACCEPT 2>/dev/null \
            || iptables -I INPUT -p udp --dport 51820 -j ACCEPT 2>/dev/null || true
        c_ok "WireGuard siap. Aktifkan lewat tombol Start di panel (atau: systemctl enable --now wg-quick@wg0)"
    else
        ip link del _wgchk 2>/dev/null || true
        c_info "WireGuard terpasang tapi kernel tidak mendukung interface wg — dilewati"
    fi
fi

# 4a-5) Halaman Syarat & Ketentuan (untuk verifikasi payment gateway & kredibilitas).
#   Payment gateway (mis. Tripay) mensyaratkan situs punya halaman S&K + kontak CS.
#   (1) Buat /frontend/syarat-ketentuan.html bila BELUM ADA (auto-isi nama usaha/WA/
#       alamat dari /voucher/info, tidak hardcode). (2) Sisipkan link S&K di footer
#   index.html tiap update (index.html di-reset git tiap pull, jadi link perlu
#   dipasang ulang). Idempotent: file yang sudah ada TIDAK ditimpa; link tidak dobel.
FRONTEND_DIR="${APP_DIR}/frontend"
STK_FILE="${FRONTEND_DIR}/syarat-ketentuan.html"
if [ -d "$FRONTEND_DIR" ]; then
    if [ ! -f "$STK_FILE" ]; then
        c_info "Membuat halaman Syarat & Ketentuan ..."
        cat > "$STK_FILE" <<'STK_HTML_EOF'
<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Syarat &amp; Ketentuan</title>
<meta name="description" content="Syarat dan Ketentuan penggunaan layanan serta pembelian voucher internet.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#f6f5fb; --card:#ffffff; --text:#161325; --text2:#413d59;
    --text3:#8b87a3; --border:#e8e6f2; --accent:#6d5cf5; --accent2:#8b5cf6;
    --green:#16a34a; --radius:16px;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.7;font-size:15px}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}
  .topbar{background:#fff;border-bottom:1px solid var(--border);position:sticky;top:0;z-index:5}
  .topbar-inner{max-width:860px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;justify-content:space-between}
  .brand{display:flex;align-items:center;gap:9px}
  .brand .mark{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;color:#fff}
  .brand .name{font-family:'Bricolage Grotesque',sans-serif;font-size:17px;font-weight:800;letter-spacing:-.01em}
  .back{font-size:13px;font-weight:600;color:var(--text2);display:inline-flex;align-items:center;gap:5px}
  .wrap{max-width:860px;margin:0 auto;padding:34px 20px 60px}
  .hero-badge{display:inline-block;font-size:12px;font-weight:600;color:var(--accent);background:rgba(109,92,245,.1);padding:5px 12px;border-radius:20px;margin-bottom:14px}
  h1{font-family:'Bricolage Grotesque',sans-serif;font-size:30px;font-weight:800;letter-spacing:-.02em;margin-bottom:6px}
  .updated{font-size:13px;color:var(--text3);margin-bottom:26px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:26px 28px;box-shadow:0 14px 40px -28px rgba(60,40,120,.35)}
  h2{font-family:'Bricolage Grotesque',sans-serif;font-size:18px;font-weight:700;margin:26px 0 8px;color:var(--text)}
  h2:first-of-type{margin-top:0}
  p{margin-bottom:10px;color:var(--text2)}
  ul{margin:0 0 12px 20px;color:var(--text2)}
  li{margin-bottom:6px}
  .cs-box{background:linear-gradient(135deg,rgba(109,92,245,.06),rgba(139,92,246,.06));border:1px solid var(--border);border-radius:14px;padding:22px 24px;margin-top:28px}
  .cs-box h2{margin-top:0}
  .cs-row{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;font-size:14px;color:var(--text2)}
  .cs-row .ico{width:20px;flex-shrink:0;text-align:center}
  .wa-btn{display:inline-flex;align-items:center;gap:8px;margin-top:8px;background:#25D366;color:#fff;font-weight:600;font-size:14px;padding:11px 20px;border-radius:11px}
  .wa-btn:hover{text-decoration:none;filter:brightness(.96)}
  footer{text-align:center;padding:26px 20px;color:var(--text3);font-size:12px}
  strong{color:var(--text)}
</style>
</head>
<body>

<div class="topbar">
  <div class="topbar-inner">
    <a href="/" class="brand">
      <span class="mark"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5a9 9 0 0 1 14 0"/><path d="M8.5 15.5a4.5 4.5 0 0 1 7 0"/><circle cx="12" cy="18.5" r="1.3" fill="currentColor" stroke="none"/></svg></span>
      <span class="name js-app-name">SimBill</span>
    </a>
    <a href="/" class="back">← Kembali ke Beranda</a>
  </div>
</div>

<div class="wrap">
  <span class="hero-badge">Legal</span>
  <h1>Syarat &amp; Ketentuan</h1>
  <div class="updated">Terakhir diperbarui: 3 Juli 2026</div>

  <div class="card">
    <p>Selamat datang di layanan <strong class="js-app-name">SimBill</strong>. Dengan mengakses situs ini dan/atau melakukan pembelian voucher maupun pembayaran tagihan internet, Anda dianggap telah membaca, memahami, dan menyetujui seluruh Syarat &amp; Ketentuan di bawah ini.</p>

    <h2>1. Ketentuan Umum</h2>
    <ul>
      <li>Layanan ini menyediakan penjualan <strong>voucher internet hotspot</strong> dan pembayaran tagihan layanan internet (PPPoE) milik penyedia.</li>
      <li>"Pengguna" adalah setiap pihak yang mengakses situs, membeli voucher, atau membayar tagihan melalui situs ini.</li>
      <li>Penyedia berhak sewaktu-waktu mengubah, menambah, atau menghapus sebagian isi ketentuan ini. Perubahan berlaku sejak dipublikasikan di halaman ini.</li>
    </ul>

    <h2>2. Produk &amp; Layanan</h2>
    <ul>
      <li>Voucher internet dijual berdasarkan <strong>paket</strong> tertentu (kuota/kecepatan dan durasi masa aktif) yang tercantum jelas beserta harganya sebelum pembayaran.</li>
      <li>Masa aktif voucher dihitung sesuai durasi paket dan mulai berjalan saat voucher pertama kali digunakan untuk login, kecuali ditentukan lain pada deskripsi paket.</li>
      <li>Ketersediaan dan cakupan jaringan mengikuti area layanan penyedia.</li>
    </ul>

    <h2>3. Harga &amp; Pembayaran</h2>
    <ul>
      <li>Seluruh harga tercantum dalam Rupiah (IDR) dan sudah final sebagaimana ditampilkan pada halaman pembelian.</li>
      <li>Pembayaran diproses melalui <strong>payment gateway resmi</strong> (mis. QRIS, Virtual Account bank, dan metode lain yang tersedia). Kami tidak menyimpan data kartu/kredensial pembayaran Anda.</li>
      <li>Pembeli wajib membayar dengan <strong>nominal yang tepat</strong> dan sebelum batas waktu pembayaran berakhir. Transaksi yang melewati batas waktu akan otomatis dibatalkan.</li>
      <li>Voucher/aktivasi baru diproses setelah pembayaran <strong>terkonfirmasi lunas</strong> oleh payment gateway.</li>
    </ul>

    <h2>4. Pengiriman Voucher</h2>
    <ul>
      <li>Kode voucher dikirim <strong>otomatis ke nomor WhatsApp</strong> yang Anda masukkan saat checkout setelah pembayaran berhasil.</li>
      <li>Pastikan nomor WhatsApp yang dimasukkan <strong>benar dan aktif</strong>. Kesalahan penulisan nomor di luar tanggung jawab penyedia.</li>
      <li>Jika dalam beberapa menit voucher belum diterima padahal pembayaran sudah berhasil, silakan hubungi Customer Service kami (lihat bagian bawah) dengan menyertakan bukti pembayaran / nomor referensi.</li>
    </ul>

    <h2>5. Kebijakan Pengembalian Dana (Refund)</h2>
    <ul>
      <li>Voucher yang <strong>sudah terkirim dan/atau sudah digunakan</strong> tidak dapat dikembalikan (non-refundable).</li>
      <li>Apabila pembayaran <strong>berhasil namun voucher gagal dikirim</strong> karena kendala sistem, penyedia akan mengirim ulang voucher atau mengembalikan dana setelah verifikasi. Ajukan melalui Customer Service disertai nomor referensi transaksi.</li>
      <li>Pengembalian dana (bila disetujui) diproses ke metode/rekening yang sama, sesuai waktu proses masing-masing bank/penyedia pembayaran.</li>
    </ul>

    <h2>6. Kewajiban &amp; Larangan Pengguna</h2>
    <ul>
      <li>Menggunakan layanan secara sah dan tidak untuk aktivitas melanggar hukum yang berlaku di Indonesia.</li>
      <li>Tidak menyalahgunakan, meretas, atau mengganggu jaringan dan sistem penyedia.</li>
      <li>Tidak memperjualbelikan kembali voucher/akun tanpa izin tertulis dari penyedia.</li>
    </ul>

    <h2>7. Privasi &amp; Data Pribadi</h2>
    <ul>
      <li>Data yang kami kumpulkan (mis. nomor WhatsApp dan nama) digunakan <strong>hanya</strong> untuk memproses transaksi, mengirim voucher, dan keperluan layanan pelanggan.</li>
      <li>Kami tidak menjual atau membagikan data pribadi Anda kepada pihak ketiga selain yang diperlukan untuk memproses pembayaran dan pengiriman voucher.</li>
    </ul>

    <h2>8. Batasan Tanggung Jawab</h2>
    <ul>
      <li>Penyedia berupaya menjaga layanan berjalan optimal, namun tidak menjamin bebas gangguan sepenuhnya akibat pemeliharaan, gangguan jaringan, atau keadaan di luar kendali (force majeure).</li>
      <li>Penyedia tidak bertanggung jawab atas kerugian yang timbul dari kesalahan input data oleh Pengguna atau penyalahgunaan oleh pihak lain.</li>
    </ul>

    <h2>9. Hukum yang Berlaku</h2>
    <p>Syarat &amp; Ketentuan ini tunduk pada hukum Republik Indonesia. Setiap perselisihan akan diupayakan diselesaikan secara musyawarah terlebih dahulu.</p>

    <div class="cs-box">
      <h2>📞 Hubungi Customer Service</h2>
      <p style="margin-bottom:14px">Ada pertanyaan seputar pembelian, voucher, atau pembayaran? Tim kami siap membantu.</p>
      <div class="cs-row"><span class="ico">🏢</span><span><strong class="js-app-name">SimBill</strong></span></div>
      <div class="cs-row" id="cs-alamat-row" style="display:none"><span class="ico">📍</span><span id="cs-alamat"></span></div>
      <div class="cs-row" id="cs-wa-row" style="display:none"><span class="ico">💬</span><span>WhatsApp: <strong id="cs-wa-text"></strong></span></div>
      <a class="wa-btn" id="cs-wa-btn" href="#" target="_blank" rel="noopener" style="display:none">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38c1.45.79 3.08 1.21 4.79 1.21 5.46 0 9.91-4.45 9.91-9.91S17.5 2 12.04 2zm5.8 14.03c-.24.68-1.42 1.31-1.96 1.36-.5.05-.96.23-3.23-.67-2.72-1.07-4.44-3.86-4.57-4.04-.13-.18-1.1-1.46-1.1-2.79s.7-1.98.95-2.25c.24-.27.53-.34.71-.34.18 0 .35 0 .5.01.16.01.38-.06.59.45.24.58.79 2 .86 2.14.07.14.12.31.02.49-.09.18-.14.29-.27.45-.14.16-.29.36-.41.48-.14.14-.28.29-.12.57.16.27.71 1.17 1.53 1.9 1.05.93 1.94 1.22 2.22 1.36.27.14.43.12.59-.07.16-.18.68-.79.86-1.06.18-.27.36-.23.61-.14.24.09 1.55.73 1.82.86.27.14.45.2.51.31.07.11.07.63-.17 1.31z"/></svg>
        Chat via WhatsApp
      </a>
    </div>
  </div>
</div>

<footer>
  <p>© 2026 <span class="js-app-name">SimBill</span> · Seluruh hak cipta dilindungi.</p>
</footer>

<script>
  fetch('/voucher/info').then(function(r){ return r.json(); }).then(function(d){
    if(d && d.app_name){
      document.querySelectorAll('.js-app-name').forEach(function(e){ e.textContent = d.app_name; });
      document.title = 'Syarat & Ketentuan — ' + d.app_name;
    }
    if(d && d.alamat){
      document.getElementById('cs-alamat').textContent = d.alamat;
      document.getElementById('cs-alamat-row').style.display = 'flex';
    }
    if(d && d.wa_number){
      var wa = String(d.wa_number).replace(/\D/g,'');
      document.getElementById('cs-wa-text').textContent = '+' + wa;
      document.getElementById('cs-wa-row').style.display = 'flex';
      var b = document.getElementById('cs-wa-btn');
      b.href = 'https://wa.me/' + wa;
      b.style.display = 'inline-flex';
    }
  }).catch(function(){});
</script>
</body>
</html>
STK_HTML_EOF
        c_ok "syarat-ketentuan.html dibuat"
    fi
    # Sisipkan link S&K di footer index.html bila belum ada (idempotent)
    if [ -f "${FRONTEND_DIR}/index.html" ] && ! grep -q 'syarat-ketentuan.html' "${FRONTEND_DIR}/index.html"; then
        sed -i 's|<footer>|<footer>\n  <p style="margin-bottom:6px"><a href="/syarat-ketentuan.html" style="color:inherit;text-decoration:underline">Syarat \&amp; Ketentuan</a></p>|' "${FRONTEND_DIR}/index.html" \
            && c_ok "Link Syarat & Ketentuan ditambahkan ke footer index.html" \
            || c_info "Pola <footer> di index.html tak cocok — link S&K dilewati"
    fi
fi

# 4b) Selaraskan versi yang ditampilkan panel dengan rilis GitHub terbaru.
#     Panel baca file VERSION (prioritas pertama). Ambil tag rilis terbaru;
#     jika belum ada rilis, pakai short commit sebagai versi.
REPO_OWNER="idpanyoet"
REPO_NAME="SimBill-Project"
c_info "Menyelaraskan versi ..."
LATEST_TAG=$(wget -qO- "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest" 2>/dev/null \
    | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
if [ -z "$LATEST_TAG" ]; then
    LATEST_TAG="git-${VERSI_BARU}"
fi
echo "$LATEST_TAG" > "${APP_DIR}/VERSION"
c_ok "Versi di-set ke ${LATEST_TAG}"

# 5) Restart pm2
c_info "Restart aplikasi (pm2: ${PM2_NAME}) ..."
if command -v pm2 >/dev/null 2>&1; then
    pm2 restart "$PM2_NAME" 2>&1 | tail -2 && c_ok "Aplikasi di-restart" \
        || c_info "pm2 restart gagal — restart manual: pm2 restart ${PM2_NAME}"
else
    c_err "pm2 tidak ditemukan — restart manual aplikasi."
fi

echo "============================================================"
c_ok "UPDATE SELESAI: ${VERSI_LAMA} → ${VERSI_BARU}"
echo "  Backup: ${BACKUP_FILE}"
echo "  Rollback bila perlu:"
echo "    cd ${APP_DIR} && tar xzf ${BACKUP_FILE} && pm2 restart ${PM2_NAME}"
echo "============================================================"
