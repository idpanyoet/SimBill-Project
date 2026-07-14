## v1.13.5 — 14 Juli 2026

Halaman cek voucher publik: lebih informatif, dan tanggal akhirnya benar.

### 🐛 Tanggal voucher tampil dalam UTC, bukan WIB

Halaman "Cek Status Voucher" menampilkan tanggal mentah:
`2026-06-21T10:00:49.000Z`. Selain jelek, itu **UTC** — pelanggan melihat pukul
10:00 padahal voucher dipakai pukul **17:00 WIB**. Selisih 7 jam yang
membingungkan.

**Perbaikan:** tanggal diformat di server ke WIB —
"21 Juni 2026 pukul 17.00 WIB".

### ✨ Info voucher lebih lengkap

Dulu hasil cek hanya "sudah dipakai pada <tanggal>". Sekarang menampilkan paket,
kecepatan, masa aktif, dan — sesuai status — kapan mulai dipakai / berlaku sampai
kapan, plus keterangan yang membantu (mis. "hanya bisa dipakai sekali, kalau
merasa belum memakainya hubungi penjual"). Status `expired` kini punya tampilan
sendiri, tidak lagi jatuh ke "Tidak Aktif" yang generik.

### 🔒 Endpoint tidak lagi membocorkan data internal

`/voucher/cek` dulu mengembalikan seluruh baris voucher (`SELECT v.*`) —
termasuk **password voucher** dan kolom internal. Sekarang hanya field yang perlu
ditampilkan yang dikirim.

---

## v1.13.4 — 14 Juli 2026

**L2TP tidak pernah bisa dipakai di instalasi baru.** Tiga bug saling menutupi.

### 🐛 KRITIS — xl2tpd dijalankan TANPA konfigurasi

`install.sh` memasang paket `xl2tpd` dan systemd langsung menjalankannya — tapi
yang **menulis konfigurasi** justru tombol "Install L2TP" di panel. Kalau tombol
itu tidak ditekan, xl2tpd hidup memakai `/etc/xl2tpd/xl2tpd.conf` **bawaan Ubuntu
yang seluruh isinya comment**, termasuk `[lns default]`.

Tanpa LNS, xl2tpd **menolak setiap koneksi**:

```
control_finish: Denied connection to unauthorized peer 103.193.145.165
Connection 346 closed to ..., port 1701 (No Authorization)
```

Kasus nyata: MikroTik pelanggan retry berjam-jam. `systemctl status xl2tpd` bilang
`active (running)`, UDP 1701 listen, user ada di `chap-secrets` — semua tampak
benar, tapi setiap koneksi ditolak.

**Perbaikan:** `install.sh` sekarang **langsung menulis konfigurasi yang benar**
(`xl2tpd.conf` dengan `[lns default]`, `options.l2tpd.lns`, PSK IPSec acak).
Selesai install, L2TP **siap pakai** — tanpa menekan tombol apa pun. Konfigurasi
yang sudah benar **tidak ditimpa**; yang rusak di-backup dulu.

Bisa diatur saat install: `L2TP_IP_LOCAL`, `L2TP_IP_RANGE`, `L2TP_PSK`.

### 🐛 KRITIS — panel bilang "L2TP aktif" padahal menolak semua koneksi

Status L2TP hanya mengecek apakah *service* hidup:

```js
const running = installed && isRunning('xl2tpd') && swanRunning;
```

Service hidup tanpa konfigurasi → panel menampilkan **"L2TP/IPSec aktif — 3 user"**
dengan titik **hijau**. Admin melihat itu dan berhenti mencari masalah.

Service yang hidup tanpa konfigurasi lebih menyesatkan daripada service yang mati.

**Perbaikan:** status kini memeriksa `[lns default]` dan `options.l2tpd.lns`.
Kalau belum dikonfigurasi, panel menampilkan **kuning**: *"L2TP terpasang tapi
BELUM DIKONFIGURASI — semua koneksi ditolak"*, beserta tombol **Install**
(bukan Start — Start tidak memperbaiki konfigurasi yang kosong).

### 🐛 UDP 500 & 4500 tidak pernah dibuka

`install.sh` mencetak di akhir instalasi:

```
1812-1813/udp (RADIUS) · 51820/udp (WireGuard) · 1701/500/4500/udp (L2TP/IPSec)
```

Tapi aturan iptables-nya **hanya 1812, 1813, 1701**. UDP **500** (IKE) dan **4500**
(NAT-T) tidak pernah dibuka, jadi setiap pelanggan yang memakai L2TP **dengan
IPSec** pasti gagal — sementara pesan instalasi meyakinkan mereka port itu sudah
terbuka.

**Perbaikan:** UDP 500 dan 4500 benar-benar dibuka, plus protokol **ESP** (untuk
IPSec tanpa NAT). Berlaku untuk jalur `ufw` maupun `iptables`.

---

## v1.13.3 — 13 Juli 2026

Perbaikan ganti WiFi via TR-069. **Tiga bug, satu di antaranya merusak diam-diam.**

### 🐛 KRITIS — /gantisandi mengubah SEMUA SSID, termasuk milik ISP dan CCTV

`setWifi()` menulis ke **setiap** `WLANConfiguration` yang ditemukan di ONU.
Satu ONU bisa punya beberapa SSID untuk keperluan berbeda. Contoh nyata
(HS8145C5 di lapangan):

```
WLANConfiguration.1 = "Kioss DBoy"   ← WiFi pelanggan
WLANConfiguration.2 = "RFNET.ID"     ← SSID milik ISP
WLANConfiguration.3 = "cctv dBoy"    ← jaringan CCTV pelanggan
```

Ganti sandi WiFi pelanggan → sandi SSID ISP dan **CCTV ikut berubah**. CCTV
terputus, dan tidak ada yang tahu penyebabnya.

**Perbaikan:** hanya radio utama (`WLANConfiguration.1`) yang disentuh.

### 🐛 KRITIS — sandi Huawei tidak pernah berubah, tapi bot bilang berhasil

Aturan Huawei di kode justru **terbalik**. Diverifikasi langsung di HS8145C5:

| Parameter | Hasil |
|---|---|
| `WLANConfiguration.1.KeyPassphrase` | **202 Task faulted** (cwmp.9003) |
| `WLANConfiguration.1.PreSharedKey.1.KeyPassphrase` | **200 OK** |

Kode lama menulis **persis parameter yang ditolak**, dan tidak pernah mengenal
`PreSharedKey.1.KeyPassphrase` sama sekali. Akibatnya setiap `/gantisandi` ke ONU
Huawei gagal — sementara fault 9003 menumpuk sampai 9× retry di GenieACS.

**Perbaikan:** parameter sandi dicoba **berurutan sampai ONU menerimanya**
(200 OK), bukan ditebak dari merek. Untuk Huawei, `PreSharedKey.1.KeyPassphrase`
didahulukan karena terbukti diterima.

Setiap parameter juga dikirim sebagai **task terpisah**. `setParameterValues`
bersifat **atomik** — dulu SSID + sandi untuk semua radio dikirim dalam satu task,
sehingga satu parameter ditolak membuat **seluruh** perubahan batal.

### 🐛 Bot selalu bilang "✅ berhasil" — bahkan saat ONU menolak

Hasil `setWifi()` **dibuang** oleh bot WA, panel, dan portal pelanggan. Ketiganya
langsung melaporkan sukses. Task yang cuma **diantre** (ONU offline), task yang
**ditolak** ONU, bahkan task yang **tidak menulis parameter apa pun** — semuanya
dapat centang hijau. Pesan sukses jadi tidak berarti apa-apa.

**Perbaikan:** status dilaporkan apa adanya, dan dibedakan:

- **✅ diterapkan** — ONU menjawab 200, perubahan benar-benar masuk
- **⏳ diantre** — ONU tidak merespons (mungkin mati); akan dijalankan saat terhubung
- **❌ ditolak** — ONU menjawab tapi menolak parameternya (CWMP fault)
- **❌ tidak ada parameter** — ONU belum sinkron ke ACS

ONU offline sengaja dilaporkan "diantre", **bukan** "menolak" — supaya teknisi
tidak dikirim mencari masalah yang salah.

---

## v1.13.2 — 13 Juli 2026

Perbaikan billing Fixed Date. **Menutup dua kebocoran penagihan.**

### 🐛 KRITIS — Postpaid + Fixed Date: invoice dibatalkan sendiri, pelanggan tak pernah ditagih

Pelanggan **postpaid + periode `kalender` (Fixed Date)** dibuatkan invoice tiap
bulan — lalu invoice itu **dibatalkan sendiri oleh sistem sehari kemudian**.
Pelanggan tidak pernah bayar, dan tidak pernah ter-isolir.

**Akar masalah.** `tgl_expired` dihitung anniversary (`tgl_aktif + masa_aktif`),
padahal jatuh tempo invoice-nya mengikuti Fixed Date (`billing_tgl_isolir`).
Contoh: pasang 15 Juli → `tgl_expired` = 15 Agustus, tapi invoice jatuh tempo
5 Agustus. Karena `tgl_expired` **selalu** lebih jauh dari jatuh tempo, cron
"auto-cancel invoice basi" (syarat `tgl_expired > tgl_jatuh_tempo`) menganggap
invoice yang baru sehari lahir itu sudah basi, lalu membatalkannya:

```
1 Agu 07:10  invoice dibuat, jatuh tempo 5 Agu        ✅
2 Agu 06:00  auto-cancel: 15 Agu > 5 Agu → DIBATALKAN ❌
6 Agu 09:10  isolir cari invoice unpaid → tidak ada   ❌
```

Terulang setiap bulan, selamanya.

**Perbaikan.** `tgl_expired` pelanggan **postpaid + Fixed Date** kini diselaraskan
ke Fixed Date, bukan tanggal pasang:

- Pasang 15 Juli → `tgl_expired` = **5 Agustus** (bukan 15 Agustus)
- Bayar invoice Agustus → `tgl_expired` = **5 September**
- Telat bayar → tetap 5 September (telat tidak memberi bonus masa aktif)

Karena `tgl_expired` kini **sama dengan** jatuh tempo, dan auto-cancel memakai
`>` (bukan `>=`), invoice sah tidak ikut dibatalkan. Akar masalahnya hilang —
bukan gejalanya ditambal.

Efek samping yang diminta pengguna: kolom masa aktif di daftar pelanggan jadi
**seragam mengikuti setingan billing**, tidak lagi acak mengikuti tanggal pasang.

**Prepaid + Fixed Date SENGAJA TIDAK diubah.** Masa aktifnya sudah dibayar penuh;
memaksanya ke Fixed Date akan **memotong hak yang sudah dibayar**.

### 🐛 Prepaid + Fixed Date tidak pernah ter-isolir (dari v1.13.1)

Prepaid tidak punya invoice otomatis (pelanggan perpanjang sendiri lewat portal).
Yang meng-isolir prepaid adalah cron masa-aktif — tapi cron itu mengecualikan
SEMUA `periode='kalender'`. Pengecualian itu benar untuk postpaid (mereka diurus
`_isolirKalender()` berbasis invoice), tapi prepaid+kalender jatuh ke celah di
antara keduanya: tidak punya invoice, dan dikecualikan dari cron masa aktif.
Hasilnya internet jalan terus tanpa bayar.

Diperbaiki: prepaid+kalender kini ikut aturan masa aktif, sama seperti
prepaid+tetap.

### Tidak berubah

Postpaid+tetap, prepaid+tetap, dan VIP (`tgl_expired` NULL): perilaku persis sama.
Prorata bulan pertama tetap hanya untuk prepaid+Fixed Date (postpaid yang pasang
di tengah bulan tetap gratis sisa bulan itu — sesuai keputusan ISP).

---

## v1.13.1 — 13 Juli 2026

Perbaikan 1 baris, tapi menutup kebocoran penagihan.

### 🐛 Prepaid + Fixed Date tidak pernah ter-isolir

Pelanggan dengan **siklus `prepaid` + periode `kalender` (Fixed Date)** tidak
pernah di-isolir walaupun masa aktifnya sudah habis — internet jalan terus tanpa
bayar, tanpa batas waktu.

**Penyebab.** Prepaid tidak punya invoice otomatis (by design — pelanggan
perpanjang sendiri lewat portal). Yang meng-isolir prepaid adalah cron "masa
aktif habis" (`tgl_expired` lewat). Tapi cron itu mengecualikan SEMUA pelanggan
`periode='kalender'`:

```sql
AND (periode IS NULL OR periode <> 'kalender')
```

Pengecualian itu benar untuk **postpaid**+kalender — mereka di-isolir oleh
`_isolirKalender()` yang berbasis invoice lewat jatuh tempo. Tapi **prepaid**
+kalender tidak punya invoice sama sekali sampai pelanggannya sendiri menekan
tombol Perpanjang. Kalau dia tidak menekan, tidak ada invoice → `_isolirKalender()`
tidak menemukan apa pun → dan cron masa-aktif sudah mengecualikannya.
Jatuh ke celah di antara keduanya.

**Perbaikan.**

```sql
AND (periode IS NULL OR periode <> 'kalender' OR siklus = 'prepaid')
```

Postpaid+Fixed Date tetap diurus `_isolirKalender()` (tidak berubah).
Prepaid+Fixed Date kini ikut aturan masa aktif, sama seperti prepaid+tetap.

**Tidak ada perubahan lain.** Diuji dengan SQL sungguhan: dari 4 kombinasi
siklus×periode, hanya prepaid+kalender yang perilakunya berubah. Postpaid+tetap,
postpaid+kalender, prepaid+tetap, dan VIP (`tgl_expired` NULL) semuanya persis
sama seperti sebelumnya.

---

## v1.13.0 — 13 Juli 2026

Rilis besar: keamanan hak akses, jejak audit, perbaikan data laporan, dan
manajemen port OLT.

**Ada migrasi database** (otomatis lewat `update.sh`): kolom `admin.permissions`.
Tidak ada dependensi baru.

### 🔐 Hak akses (RBAC)

- **Celah naik-hak ditutup.** Sebelumnya operator bisa mengirim `role:superadmin`
  saat membuat pengguna, mereset password superadmin, dan menonaktifkan
  superadmin terakhir sehingga panel terkunci total. Kini ada hierarki peran:
  pengguna hanya bisa mengelola peran di bawahnya.
- **Middleware RBAC terpusat** (`middleware/rbac.js`, 59 aturan). Punya 3 mode
  lewat setting `rbac_mode`:
  - `off` — mati
  - `audit` — **DEFAULT**: tidak memblokir apa pun, hanya mencatat "seandainya
    diblokir". Jalankan 1–2 hari, periksa Log Admin, baru pindah ke `enforce`.
  - `enforce` — memblokir sungguhan.

  Ganti mode cukup lewat SQL, tanpa restart:
  `UPDATE setting SET nilai='enforce' WHERE kunci='rbac_mode';`
- **Migrasi `admin.permissions`.** Kolom ini dibutuhkan `perm.js` tapi belum
  pernah ada di `schema.sql` — instalasi baru akan error "Unknown column".
  Kini ditambahkan ke schema dan di-`ALTER` otomatis saat update (idempoten).

### 📋 Jejak audit

- **Endpoint destruktif yang selama ini SENYAP kini tercatat**: hapus pelanggan,
  hapus voucher (satuan/massal/batch), hapus paket, putus sesi PPPoE,
  single-session on/off, dan konfirmasi/approve top-up reseller.
- Kartu kategori Hotspot / PPPoE / Reseller di Log Admin dulu selalu 0 karena
  **tidak ada satu pun kode yang menulisnya**. Sekarang terisi.
- **XSS tersimpan diperbaiki** di halaman Log Admin: nama pelaku/target/detail
  dirender mentah, sehingga pelanggan bernama `<img onerror=...>` bisa
  mengeksekusi skrip di browser superadmin. 13 field kini di-escape.
- Halaman Log Admin dirombak: 4 kartu ringkas, grafik 14 hari, pill kategori
  dibangun dari data (bukan hardcode), pencarian di-debounce 300ms — dulu tiap
  ketikan menembak 8 request.

### 📊 Laporan — 5 bug data diperbaiki

- **Kartu "Pendapatan Bulan Ini" sebenarnya menjumlahkan TAGIHAN**, bukan uang
  masuk (tanpa filter status, invoice belum bayar ikut terhitung). Kini dipisah:
  Tagihan · Uang Masuk · Piutang.
- **Bug cartesian di laporan per-paket**: dua `LEFT JOIN` membuat nilai invoice
  dikali jumlah pelanggan — 3 pelanggan bisa membuat Rp200.000 tampil sebagai
  Rp600.000. Ditulis ulang dengan subquery.
- **Bug cartesian yang sama di Export Excel** — dan Excel inilah yang dipakai
  untuk pembukuan.
- Invoice `cancelled` ikut terhitung sebagai pendapatan.
- Persentase LUNAS memakai pembagi yang salah (jumlah pelanggan, padahal
  pembilangnya jumlah invoice) — paket voucher selalu 0%.
- Halaman dirombak: kartu "Tingkat Penagihan", grafik tren 6 bulan, dan tabel
  per-paket dengan bar kontribusi.

### 🔌 OLT — Port Manager & Template ONU

- **Port Manager (baru).** Slot, kartu, PON port, sebaran ONU, kapasitas
  (128 ONU/PON), uplink dipisah. **Tanpa perintah SSH tambahan** — payload
  dashboard ternyata sudah membawa hasil `show card`, selama ini dibuang.
- **Bandwidth & status per PON** via SNMP IF-MIB (counter port fisik).
  Kalau counter tak terbaca, panel menulis "— tidak terbaca", **bukan
  "0.0 Mbps"** — angka nol palsu lebih berbahaya daripada tidak ada angka.
  Tersedia tombol **Cek SNMP** yang melaporkan apa adanya OID mana yang menjawab.
- **Grafik trafik real-time per PON** (perbarui tiap 3 detik).
- **Matikan/hidupkan PON.** ⚠️ Ini memutus SELURUH pelanggan di PON tersebut.
  Pengaman berlapis: admin-only · dry-run dulu (perintah + jumlah ONU terdampak
  ditampilkan) · wajib mengetik nama PON persis · tercatat di audit log.
- **Fitur PON di atas hanya untuk OLT ZTE.** OLT EPON/non-ZTE memakai driver
  lain dengan ifIndex berbeda; memaksakan rumus ZTE di sana bisa menampilkan
  angka ngawur. Panel menolak terang-terangan dengan pesan jelas.
- **Editor Template ONU.** Tambah/edit/hapus/duplikat template registrasi per
  vendor (ZTE, Huawei, F670L, GM220S, …) langsung dari panel — tanpa mengedit
  JSON. Chip placeholder memperlihatkan mana yang diisi sistem
  (`{CARDPON}` `{ONT}` `{SN}` `{NAME}`) dan mana yang jadi kolom isian saat
  register. Admin-only · validasi server · backup otomatis · tulis atomik ·
  tercatat di audit log · template terakhir tidak bisa dihapus.

### ⚠️ Catatan untuk pengguna SNMP

Kalau bandwidth PON tidak muncul, jalankan **Cek SNMP** di Port Manager. Yang
sering jadi penyebab: community string belum diisi di Kelola OLT, view SNMP
salah huruf besar-kecil (`AllView` ≠ `allview`), atau UDP 161 diblokir.

---
## v1.13.0 — 13 Juli 2026

Rilis besar: keamanan hak akses, jejak audit, perbaikan data laporan, dan
manajemen port OLT.

**Ada migrasi database** (otomatis lewat `update.sh`): kolom `admin.permissions`.
Tidak ada dependensi baru.

### 🔐 Hak akses (RBAC)

- **Celah naik-hak ditutup.** Sebelumnya operator bisa mengirim `role:superadmin`
  saat membuat pengguna, mereset password superadmin, dan menonaktifkan
  superadmin terakhir sehingga panel terkunci total. Kini ada hierarki peran:
  pengguna hanya bisa mengelola peran di bawahnya.
- **Middleware RBAC terpusat** (`middleware/rbac.js`, 59 aturan). Punya 3 mode
  lewat setting `rbac_mode`:
  - `off` — mati
  - `audit` — **DEFAULT**: tidak memblokir apa pun, hanya mencatat "seandainya
    diblokir". Jalankan 1–2 hari, periksa Log Admin, baru pindah ke `enforce`.
  - `enforce` — memblokir sungguhan.

  Ganti mode cukup lewat SQL, tanpa restart:
  `UPDATE setting SET nilai='enforce' WHERE kunci='rbac_mode';`
- **Migrasi `admin.permissions`.** Kolom ini dibutuhkan `perm.js` tapi belum
  pernah ada di `schema.sql` — instalasi baru akan error "Unknown column".
  Kini ditambahkan ke schema dan di-`ALTER` otomatis saat update (idempoten).

### 📋 Jejak audit

- **Endpoint destruktif yang selama ini SENYAP kini tercatat**: hapus pelanggan,
  hapus voucher (satuan/massal/batch), hapus paket, putus sesi PPPoE,
  single-session on/off, dan konfirmasi/approve top-up reseller.
- Kartu kategori Hotspot / PPPoE / Reseller di Log Admin dulu selalu 0 karena
  **tidak ada satu pun kode yang menulisnya**. Sekarang terisi.
- **XSS tersimpan diperbaiki** di halaman Log Admin: nama pelaku/target/detail
  dirender mentah, sehingga pelanggan bernama `<img onerror=...>` bisa
  mengeksekusi skrip di browser superadmin. 13 field kini di-escape.
- Halaman Log Admin dirombak: 4 kartu ringkas, grafik 14 hari, pill kategori
  dibangun dari data (bukan hardcode), pencarian di-debounce 300ms — dulu tiap
  ketikan menembak 8 request.

### 📊 Laporan — 5 bug data diperbaiki

- **Kartu "Pendapatan Bulan Ini" sebenarnya menjumlahkan TAGIHAN**, bukan uang
  masuk (tanpa filter status, invoice belum bayar ikut terhitung). Kini dipisah:
  Tagihan · Uang Masuk · Piutang.
- **Bug cartesian di laporan per-paket**: dua `LEFT JOIN` membuat nilai invoice
  dikali jumlah pelanggan — 3 pelanggan bisa membuat Rp200.000 tampil sebagai
  Rp600.000. Ditulis ulang dengan subquery.
- **Bug cartesian yang sama di Export Excel** — dan Excel inilah yang dipakai
  untuk pembukuan.
- Invoice `cancelled` ikut terhitung sebagai pendapatan.
- Persentase LUNAS memakai pembagi yang salah (jumlah pelanggan, padahal
  pembilangnya jumlah invoice) — paket voucher selalu 0%.
- Halaman dirombak: kartu "Tingkat Penagihan", grafik tren 6 bulan, dan tabel
  per-paket dengan bar kontribusi.

### 🔌 OLT — Port Manager & Template ONU

- **Port Manager (baru).** Slot, kartu, PON port, sebaran ONU, kapasitas
  (128 ONU/PON), uplink dipisah. **Tanpa perintah SSH tambahan** — payload
  dashboard ternyata sudah membawa hasil `show card`, selama ini dibuang.
- **Bandwidth & status per PON** via SNMP IF-MIB (counter port fisik).
  Kalau counter tak terbaca, panel menulis "— tidak terbaca", **bukan
  "0.0 Mbps"** — angka nol palsu lebih berbahaya daripada tidak ada angka.
  Tersedia tombol **Cek SNMP** yang melaporkan apa adanya OID mana yang menjawab.
- **Grafik trafik real-time per PON** (perbarui tiap 3 detik).
- **Matikan/hidupkan PON.** ⚠️ Ini memutus SELURUH pelanggan di PON tersebut.
  Pengaman berlapis: admin-only · dry-run dulu (perintah + jumlah ONU terdampak
  ditampilkan) · wajib mengetik nama PON persis · tercatat di audit log.
- **Fitur PON di atas hanya untuk OLT ZTE.** OLT EPON/non-ZTE memakai driver
  lain dengan ifIndex berbeda; memaksakan rumus ZTE di sana bisa menampilkan
  angka ngawur. Panel menolak terang-terangan dengan pesan jelas.
- **Editor Template ONU.** Tambah/edit/hapus/duplikat template registrasi per
  vendor (ZTE, Huawei, F670L, GM220S, …) langsung dari panel — tanpa mengedit
  JSON. Chip placeholder memperlihatkan mana yang diisi sistem
  (`{CARDPON}` `{ONT}` `{SN}` `{NAME}`) dan mana yang jadi kolom isian saat
  register. Admin-only · validasi server · backup otomatis · tulis atomik ·
  tercatat di audit log · template terakhir tidak bisa dihapus.

### ⚠️ Catatan untuk pengguna SNMP

Kalau bandwidth PON tidak muncul, jalankan **Cek SNMP** di Port Manager. Yang
sering jadi penyebab: community string belum diisi di Kelola OLT, view SNMP
salah huruf besar-kecil (`AllView` ≠ `allview`), atau UDP 161 diblokir.

---

## v1.12.2 — 12 Juli 2026

Rilis perbaikan pengalaman pakai. Tidak ada perubahan perilaku yang mengejutkan,
tidak ada migrasi database, tidak ada dependensi baru.

### ✨ Fitur baru

- **Nomor HP pembeli voucher tampil di invoice.** Invoice voucher online dibuat
  tanpa akun pelanggan, sehingga selama ini semuanya tampil sebagai "Pembeli
  Voucher" tanpa identitas — mustahil tahu voucher itu milik siapa. Ternyata
  nomor HP-nya sudah tersimpan sejak awal di kolom `keterangan`; kini
  ditampilkan di **daftar invoice** (kolom baru "No. HP", bisa diklik untuk
  langsung chat WhatsApp) dan ikut tercetak di **invoice/PDF**.
  Berlaku juga untuk invoice voucher **lama**, tanpa migrasi apa pun.
- **Link Google Maps di notifikasi tiket gangguan.** Notif tiket ke Telegram kini
  menyertakan titik koordinat + link peta pelanggan — format sama dengan notif
  Pendaftaran Pelanggan Baru. Berlaku untuk tiket dari **panel admin**, **portal
  pelanggan**, maupun **bot WhatsApp**. Pelanggan tanpa koordinat tetap aman:
  notif dan tiketnya tetap terbuat, hanya tanpa baris peta.

### 🐛 Perbaikan

- **`/cekpelanggan` tidak lagi buntu.** Mengetik nama yang persis cocok (mis.
  `marzuki`) tapi ada juga nama lain yang mengandungnya (`marzukikl`) sebelumnya
  selalu dibalas "ketik lebih spesifik" — dan mengetik ulang kata yang sama tidak
  akan pernah menolong. Kini cocok persis (nama **atau** username, huruf besar/
  kecil bebas) langsung menampilkan detail. Daftar pilihan tetap muncul bila
  pencarian memang ambigu — bot tidak boleh menebak dan memberi teknisi data
  pelanggan yang salah. Berlaku di bot Telegram **dan** WhatsApp.
- **Notifikasi tiket tidak lagi terpotong di HP.** Panel notif (lebar 324px)
  digantung ke tombol lonceng yang di ponsel berada di tengah topbar, sehingga
  meluber keluar layar. Di layar kecil panel kini dibentangkan selebar layar.
  Menu profil ikut dijepit agar tidak meluber. Tampilan desktop tidak berubah.
- **Modal Aurora bisa di-scroll penuh di HP.** Setelah menumpuk jadi satu kolom,
  panel gradient menambah tinggi di atas area isian yang masih dipatok 90vh —
  totalnya melebihi tinggi modal, dan karena modal ber-`overflow:hidden` bagian
  bawah terpotong sampai **tombol Simpan tidak terjangkau**. Diperbaiki untuk
  ketujuh modal sekaligus: Tambah Pelanggan, Generate Voucher, Buat Invoice,
  Tambah Paket, Tambah Reseller, Buat Tiket, dan Tambah/Edit Pengeluaran.
  Tampilan desktop tidak berubah.

### ⚙️ Perubahan tampilan

- **Kolom "Jatuh Tempo" pada daftar invoice → "Tempo / Dibayar".** Invoice yang
  sudah lunas kini menonjolkan **tanggal bayar**, dengan jatuh tempo aslinya tetap
  ditampilkan kecil di bawahnya beserta keterangan telat/maju berapa hari.
  Sebelumnya invoice lunas tetap memajang jatuh tempo lama, sehingga terlihat
  seperti tanggal yang salah padahal masa aktif pelanggan sudah benar diperpanjang.
  Jatuh tempo asli **sengaja tidak dihilangkan** — itu satu-satunya jejak
  keterlambatan bayar, dan laporan tunggakan bergantung padanya.
- Tab **"Voucher"** pada halaman Invoice diganti menjadi **"Voucher Online"**.

### 📦 Catatan teknis

- Tidak ada migrasi database. Tidak ada dependensi baru (`npm install` tidak
  wajib).
- Interval pengecekan lisensi tetap 5 menit — tidak diubah.

## v1.12.1 — 12 Juli 2026

> ⚠️ **Rilis ini mengandung perbaikan KEAMANAN dan beberapa perubahan perilaku.**
> Baca bagian "Yang berubah setelah update" sebelum bertanya ke support.

### 🔒 Keamanan (penting — disarankan segera update)

- **Kredensial tidak lagi bocor lewat `GET /api/setting`.** Sebelumnya token & kunci
  rahasia dikirim **plaintext** ke siapa pun yang login — termasuk role `operator`
  dan `teknisi`. Yang terdampak: `wa_waha_token`, `wa_cmd_secret`, `tg_bot_token`,
  `tg_webhook_secret`, `acslite_api_key`, `genieacs_password`, `license_key`, dan
  seluruh kunci payment gateway per-provider (`pg_server_key_midtrans`,
  `pg_secret_key_xendit`, `pg_api_key_duitku`, `pg_private_key_tripay`, dll).
  Kini semuanya ditampilkan sebagai `••••••`. Deteksi berbasis pola, jadi kunci
  rahasia baru otomatis ikut terlindungi.
- **`wa_cmd_secret` tidak lagi terekspos lewat `/api/whatsapp/cmd-config`.** URL
  webhook bot WA memuat token itu di query string, dan endpointnya dulu hanya
  butuh login biasa. Sekarang URL lengkap hanya untuk admin/superadmin.
- **`github_token`, `license_key`, `license_server_url` hanya bisa diubah
  superadmin.**
- **Login admin kini dikunci setelah 8x gagal** (15 menit), dihitung per-akun DAN
  per-IP. Sebelumnya hanya ada rate-limit per-IP, sehingga brute-force dari banyak
  IP tak terbendung. Percobaan gagal kini tercatat di Log Aktivitas
  (`LOGIN_GAGAL`).
- **Portal pelanggan: `login-sandi` dikunci setelah 6x gagal** (15 menit) + limiter
  per-IP. Endpoint ini sebelumnya **tidak punya rate-limit sama sekali**, padahal
  ID pelanggan berurutan dan sandi default = nomor HP → rawan diambil alih.
- **Anti-clickjacking**: `Content-Security-Policy: frame-ancestors 'self'`.
- **CORS**: isi `FRONTEND_URL` di `backend/.env` untuk membatasi origin. Bila
  dikosongkan, perilaku lama (terbuka) dipertahankan agar instalasi lama tidak
  rusak — tapi muncul peringatan di log.

### ✨ Fitur baru

- **Perpanjang lisensi berbayar langsung dari panel.** Halaman Lisensi kini
  menampilkan pilihan durasi (1 Bulan / 3 Bulan / 6 Bulan / 1 Tahun) beserta
  harganya, dengan tombol **"Bayar & Perpanjang"** → halaman pembayaran terbuka
  → panel memantau statusnya sendiri → begitu lunas, tanggal expired langsung
  diperbarui.
  - Harga **tidak di-hardcode**: selalu ditarik dari license server, sumber yang
    sama dengan portal. Jadi harga di panel mustahil berbeda dari portal, dan
    perubahan harga tidak memerlukan update SimBill.
  - Mendukung provider yang aktif di license server (Duitku / DOKU / Midtrans).
  - Hanya admin/superadmin yang bisa membeli.
  - Tombol lama "Perpanjang Sekarang" (perpanjangan gratis pada window H-7)
    tetap ada dan tidak berubah.

  ⚠️ **Butuh license server versi terbaru.** Kalau license server belum
  diperbarui, panel hanya menyembunyikan kartu paket — tidak error, tapi fitur
  belum muncul.

- **Ubah Tanggal Expired Massal.** Pilih pelanggan lewat checkbox → tombol
  **"Ubah Expired"**. Tiga mode: Perpanjang (+hari), Kurangi (−hari), Tetapkan
  tanggal pasti.
  - Wajib **Pratinjau** dulu — server menghitung dampaknya tanpa menulis apa pun,
    lalu memperingatkan bila ada pelanggan yang akan jadi kadaluwarsa (cron
    auto-suspend berjalan tiap jam, jadi salah tanggal = pelanggan terisolir).
  - **Pelanggan VIP** (`tgl_expired` NULL) dilewati di mode Perpanjang/Kurangi
    agar status VIP-nya tidak tercabut diam-diam.
  - Maksimal 500 pelanggan sekali jalan. Admin+ saja. Tercatat di Log Aktivitas.
- **Kolom "Bergabung"** di tabel pelanggan (dari `created_at`).
- **Tanggal Bergabung bisa diedit** di modal Edit Pelanggan — berguna untuk
  pelanggan hasil migrasi/import yang `created_at`-nya = tanggal import. Admin+
  saja, tidak boleh masa depan, jam asli dipertahankan, dan tercatat di Log
  Aktivitas (`PELANGGAN_UBAH_TGL_BERGABUNG`).

### 🐛 Perbaikan

- Modal "Ubah Expired" sempat muncul di bawah tabel, bukan melayang di atasnya
  (salah posisi di DOM).

### ⚠️ Yang berubah setelah update — TIDAK RUSAK, ini disengaja

1. **Field API key WAHA (dan semua field rahasia) akan tampak KOSONG** dengan
   placeholder `•••••• tersimpan`. **Token Anda TIDAK hilang** — hanya tidak lagi
   dikirim ke browser. Menyimpan pengaturan tanpa mengisi ulang field itu **tidak
   akan menghapus** token yang tersimpan. Untuk menyalin API key WAHA, tombol
   "Salin API Key" tetap berfungsi (khusus admin).
2. **Role `operator`/`teknisi` tidak lagi bisa melihat token/secret** di halaman
   Pengaturan, dan tidak bisa memakai Ubah Expired Massal maupun mengubah Tanggal
   Bergabung.
3. Muncul peringatan di log bila `FRONTEND_URL` belum diisi. Ini **peringatan**,
   bukan error — sistem tetap berjalan normal.

### 📦 Catatan teknis

- Tidak ada migrasi database. Tidak ada dependensi baru (`npm install` tidak wajib).
- Aktivasi lisensi tetap berjalan normal (lewat `/api/license/activate`), tidak
  terpengaruh pembatasan superadmin.


## v1.12.1 — 12 Juli 2026

> ⚠️ **Rilis ini mengandung perbaikan KEAMANAN dan beberapa perubahan perilaku.**
> Baca bagian "Yang berubah setelah update" sebelum bertanya ke support.

### 🔒 Keamanan (penting — disarankan segera update)

- **Kredensial tidak lagi bocor lewat `GET /api/setting`.** Sebelumnya token & kunci
  rahasia dikirim **plaintext** ke siapa pun yang login — termasuk role `operator`
  dan `teknisi`. Yang terdampak: `wa_waha_token`, `wa_cmd_secret`, `tg_bot_token`,
  `tg_webhook_secret`, `acslite_api_key`, `genieacs_password`, `license_key`, dan
  seluruh kunci payment gateway per-provider (`pg_server_key_midtrans`,
  `pg_secret_key_xendit`, `pg_api_key_duitku`, `pg_private_key_tripay`, dll).
  Kini semuanya ditampilkan sebagai `••••••`. Deteksi berbasis pola, jadi kunci
  rahasia baru otomatis ikut terlindungi.
- **`wa_cmd_secret` tidak lagi terekspos lewat `/api/whatsapp/cmd-config`.** URL
  webhook bot WA memuat token itu di query string, dan endpointnya dulu hanya
  butuh login biasa. Sekarang URL lengkap hanya untuk admin/superadmin.
- **`github_token`, `license_key`, `license_server_url` hanya bisa diubah
  superadmin.**
- **Login admin kini dikunci setelah 8x gagal** (15 menit), dihitung per-akun DAN
  per-IP. Sebelumnya hanya ada rate-limit per-IP, sehingga brute-force dari banyak
  IP tak terbendung. Percobaan gagal kini tercatat di Log Aktivitas
  (`LOGIN_GAGAL`).
- **Portal pelanggan: `login-sandi` dikunci setelah 6x gagal** (15 menit) + limiter
  per-IP. Endpoint ini sebelumnya **tidak punya rate-limit sama sekali**, padahal
  ID pelanggan berurutan dan sandi default = nomor HP → rawan diambil alih.
- **Anti-clickjacking**: `Content-Security-Policy: frame-ancestors 'self'`.
- **CORS**: isi `FRONTEND_URL` di `backend/.env` untuk membatasi origin. Bila
  dikosongkan, perilaku lama (terbuka) dipertahankan agar instalasi lama tidak
  rusak — tapi muncul peringatan di log.

### ✨ Fitur baru

- **Perpanjang lisensi berbayar langsung dari panel.** Halaman Lisensi kini
  menampilkan pilihan durasi (1 Bulan / 3 Bulan / 6 Bulan / 1 Tahun) beserta
  harganya, dengan tombol **"Bayar & Perpanjang"** → halaman pembayaran terbuka
  → panel memantau statusnya sendiri → begitu lunas, tanggal expired langsung
  diperbarui.
  - Harga **tidak di-hardcode**: selalu ditarik dari license server, sumber yang
    sama dengan portal. Jadi harga di panel mustahil berbeda dari portal, dan
    perubahan harga tidak memerlukan update SimBill.
  - Mendukung provider yang aktif di license server (Duitku / DOKU / Midtrans).
  - Hanya admin/superadmin yang bisa membeli.
  - Tombol lama "Perpanjang Sekarang" (perpanjangan gratis pada window H-7)
    tetap ada dan tidak berubah.

  ⚠️ **Butuh license server versi terbaru.** Kalau license server belum
  diperbarui, panel hanya menyembunyikan kartu paket — tidak error, tapi fitur
  belum muncul.

- **Ubah Tanggal Expired Massal.** Pilih pelanggan lewat checkbox → tombol
  **"Ubah Expired"**. Tiga mode: Perpanjang (+hari), Kurangi (−hari), Tetapkan
  tanggal pasti.
  - Wajib **Pratinjau** dulu — server menghitung dampaknya tanpa menulis apa pun,
    lalu memperingatkan bila ada pelanggan yang akan jadi kadaluwarsa (cron
    auto-suspend berjalan tiap jam, jadi salah tanggal = pelanggan terisolir).
  - **Pelanggan VIP** (`tgl_expired` NULL) dilewati di mode Perpanjang/Kurangi
    agar status VIP-nya tidak tercabut diam-diam.
  - Maksimal 500 pelanggan sekali jalan. Admin+ saja. Tercatat di Log Aktivitas.
- **Kolom "Bergabung"** di tabel pelanggan (dari `created_at`).
- **Tanggal Bergabung bisa diedit** di modal Edit Pelanggan — berguna untuk
  pelanggan hasil migrasi/import yang `created_at`-nya = tanggal import. Admin+
  saja, tidak boleh masa depan, jam asli dipertahankan, dan tercatat di Log
  Aktivitas (`PELANGGAN_UBAH_TGL_BERGABUNG`).

### 🐛 Perbaikan

- Modal "Ubah Expired" sempat muncul di bawah tabel, bukan melayang di atasnya
  (salah posisi di DOM).

### ⚠️ Yang berubah setelah update — TIDAK RUSAK, ini disengaja

1. **Field API key WAHA (dan semua field rahasia) akan tampak KOSONG** dengan
   placeholder `•••••• tersimpan`. **Token Anda TIDAK hilang** — hanya tidak lagi
   dikirim ke browser. Menyimpan pengaturan tanpa mengisi ulang field itu **tidak
   akan menghapus** token yang tersimpan. Untuk menyalin API key WAHA, tombol
   "Salin API Key" tetap berfungsi (khusus admin).
2. **Role `operator`/`teknisi` tidak lagi bisa melihat token/secret** di halaman
   Pengaturan, dan tidak bisa memakai Ubah Expired Massal maupun mengubah Tanggal
   Bergabung.
3. Muncul peringatan di log bila `FRONTEND_URL` belum diisi. Ini **peringatan**,
   bukan error — sistem tetap berjalan normal.

### 📦 Catatan teknis

- Tidak ada migrasi database. Tidak ada dependensi baru (`npm install` tidak wajib).
- Aktivasi lisensi tetap berjalan normal (lewat `/api/license/activate`), tidak
  terpengaruh pembatasan superadmin.


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
