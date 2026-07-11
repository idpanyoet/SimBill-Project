## v1.12.0 — 11 Juli 2026

### ✨ Fitur baru
- **Integrasi API MikroTik.** SimBill kini bisa membaca sesi PPP **langsung dari router** (`/ppp active`) lewat RouterOS API. Tambahkan router di **Pengaturan Sistem → Router MikroTik**: nama, IP, port 8728, user & password API (password disimpan terenkripsi). Ada tombol tes koneksi.
- **Deteksi "Pelanggan Nyangkut".** Profile PPPoE hanya berubah saat *reconnect*, sehingga sesi lama bisa tak sesuai status billing. SimBill kini mendeteksi dan memutusnya sekali klik:
  - **Sudah bayar tapi sesinya masih IP isolir** → pelanggan tak bisa internet padahal sudah lunas.
  - **Sudah suspended tapi sesinya masih profile normal** → pelanggan masih bisa internet.
  Karena datanya dibaca dari router (bukan dari tabel akunting), sesi yang tak tercatat pun tetap ketahuan.

### 🐞 Perbaikan penting
- **Pelanggan yang sudah bayar tak lagi tersangkut di profile isolir.** Bila sesi PPPoE tidak tercatat di `radacct` (mis. akunting sempat terputus atau server berpindah), SimBill dulu melewati perintah putus sesi — akibatnya pelanggan yang sudah melunasi tagihan tetap memakai IP isolir. Kini SimBill mengirim Disconnect-Request ke seluruh NAS terdaftar sebagai cadangan, sehingga sesi lama tetap diputus dan pelanggan langsung reconnect ke profile normal.

### 🔧 Catatan teknis
- Dependensi baru: `node-routeros` (dipasang otomatis saat update).
- Tabel `router` dibuat otomatis saat aplikasi start (migrasi bawaan).
- **Keamanan:** jangan ekspos port API MikroTik (8728) ke internet — batasi ke jaringan internal/VPN, dan gunakan user MikroTik khusus berhak terbatas.
