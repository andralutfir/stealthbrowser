# stealthbrowser

[English](README.md) · **Bahasa Indonesia**

Browser sekali pakai. Setiap kali dibuka: **profil baru, identitas baru, tanpa
meninggalkan jejak.**

Ini bukan browser yang dibangun dari nol — ini launcher yang menjalankan Chrome,
Brave, Edge, atau Chromium yang sudah ada di komputer kamu, tapi dengan profil
sementara dan identitas yang diacak lewat DevTools Protocol, lalu dihapus habis
begitu ditutup.

Tanpa dependency. Tanpa `npm install`. Cukup Node.js 18+.

Jalan di Windows, Linux, dan macOS.

---

## Mulai cepat

```bash
node src/index.js --check
```

```bash
node src/index.js https://duckduckgo.com
```

Cuma itu instalasinya. `--check` menampilkan satu baris per syarat dan memberi
tahu apa yang kurang.

### Dua cara menjalankannya

**Panel kontrol.** Satu perintah, tanpa executable yang harus di-build:

```bash
node src/index.js --app
```

Perintah itu menjalankan server lokal kecil lalu membukanya sebagai jendela
aplikasi — jendela browser tanpa tab dan tanpa address bar, memakai profil
sekali pakai sendiri. Semuanya Node dan HTML biasa, jadi jalan sama persis di
Windows, Linux, dan macOS. Panel ini membaca dan menulis `config.json` yang sama
dengan CLI, dan menampilkan output launcher langsung di jendelanya.

Ada dua tampilan, tombol pindahnya di pojok kanan atas:

| | |
|---|---|
| **Simple** | Satu halaman. Browser apa, mau buka halaman apa, berapa jendela, koneksi lewat mana, hemat data, dan dua preset identitas. Cukup untuk menjalankan sesi tanpa perlu baca apa pun. |
| **Advanced** | Sebelas bagian, satu per area config — semua opsi di `config.json` punya kontrolnya. |

Keduanya adalah jendela ke setelan yang sama di memori, jadi perubahan di satu
tampilan langsung terlihat di tampilan lainnya dan tidak ada yang bisa saling
menimpa.

Temanya mengikuti setelan terang/gelap sistem, dan tombol di pojok bisa
menguncinya ke salah satu. Pilihannya tersimpan sebagai `gui.theme` di config,
jadi tidak hilang setelah ditutup.

**Script.** Untuk buka cepat dan bikin shortcut:

| Windows | Linux / macOS | Fungsinya |
|---|---|---|
| `stealth-app.cmd` | `./stealth-app.sh` | Buka panel kontrol |
| `stealth.cmd` | `./stealth.sh` | Buka satu browser |
| `stealth-multi.cmd` | `./stealth-multi.sh` | Tanya mau berapa browser, lalu buka semuanya |
| `stealth-debug.cmd` | `./stealth-debug.sh` | Buka satu browser dan rekam sesinya ke `logs/` |

Dua-duanya sama-sama menjalankan `src/index.js`, jadi apa pun yang kamu atur di
satu tempat berlaku di tempat lain. Detail khusus Linux dan macOS ada di
**[docs/LINUX.md](docs/LINUX.md)** (bahasa Inggris).

Satu hal yang perlu diketahui: **panel menulis `config.json` sebagai JSON
polos**, jadi menyimpan lewat aplikasi menghapus komentar penjelasnya. Salinan
yang berkomentar selalu ada di `config.example.json`, dan `--init-config`
mengembalikannya. File sebelumnya disimpan sebagai `config.json.bak` setiap kali
menyimpan.

---

## Belum punya browser? Diambilkan

```bash
node src/index.js --list-browsers
node src/index.js --install-browser brave
node src/index.js --install-browser chrome Beta
```

Di komputer yang sama sekali tidak punya browser, peluncuran pertama akan
mengunduh satu sendiri. Di panel ada tombol **Get browser** untuk hal yang
sama.

| | |
|---|---|
| **chrome** | Chrome for Testing — build resmi Google yang berversi, empat channel |
| **chromium** | Snapshot resmi dari upstream, tanpa branding Google |
| **brave** | ZIP portable dari GitHub release resmi Brave (tidak untuk Linux — di sana Brave hanya menyediakan paket) |
| edge, vivaldi, opera | **Installer saja** — ketiganya akan menulis ke Program Files dan registry, jadi tools ini hanya melaporkannya, tidak menjalankan installer-nya untukmu |

Semua yang diunduh berbentuk arsip biasa: tidak ada yang diinstal, tidak butuh
hak administrator, tidak ada setting sistem yang disentuh. Setiap browser masuk
ke folder `browsers/` di sebelah proyek, dan menghapus folder itu membatalkannya
sepenuhnya. Sekitar 190–340 MB per browser.

Browser yang sudah terinstal selalu didahulukan daripada yang diunduh.

---

## Yang terjadi setiap kali dibuka

**Profilnya dibuang.** Setiap peluncuran punya `user-data-dir` sendiri di folder
temp dan dihapus saat keluar — cookie, cache, riwayat, localStorage, IndexedDB,
service worker, semuanya. Profil browser asli kamu tidak pernah disentuh. Kalau
prosesnya mati paksa, sisanya disapu pada peluncuran berikutnya.

**Identitasnya diacak, tapi tetap masuk akal.** Zona waktu, bahasa, dan
geolokasi selalu diambil dari satu paket lokasi yang sama — persona Jakarta tidak
akan pernah dapat koordinat Tokyo.

| Bagian | Caranya |
|---|---|
| User-Agent + Client Hints | `Emulation.setUserAgentOverride` — header HTTP-nya ikut benar, bukan cuma `navigator.userAgent` |
| Zona waktu | `Emulation.setTimezoneOverride` — `Intl` dan `getTimezoneOffset()` ikut |
| Bahasa | `setLocaleOverride` + `--accept-lang` |
| Geolokasi | Koordinat di sekitar kota yang cocok dengan zona waktunya |
| Layar & jendela | Resolusi, DPR, `outer/inner`, diambil dari resolusi yang memang umum |
| Hardware | `hardwareConcurrency`, `deviceMemory` |
| GPU | Vendor + renderer WebGL (string ANGLE asli) |
| Canvas / WebGL / Audio | Noise deterministik per sesi |

Versi mayor browser **tidak** dipalsukan — mengaku versi lain langsung ketahuan
lewat feature detection. Yang divariasikan hanya nomor build/patch-nya.

Noise canvas-nya deterministik dalam satu sesi: canvas yang sama menghasilkan
hash yang sama. Ini penting — nilai yang berubah setiap kali dipanggil justru
menjadi sinyal bahwa ada yang mengacaknya.

**Buktikan sendiri:**

```bash
node src/index.js https://abrahamjuliot.github.io/creepjs/
```

### Kapan spoofing justru salah alat

Sebagian situs memakai bot check — Cloudflare Turnstile, hCaptcha mode sulit —
dan yang dicari bot check itu persis apa yang dikerjakan tools ini: canvas dan
WebGL yang ditambal, sesi DevTools yang menempel, script yang disuntik ke setiap
dokumen, User-Agent yang tidak cocok dengan browser aslinya, zona waktu yang
tidak cocok dengan IP. Gejalanya: widget-nya tampil, lalu mandek di
*Verifying…* selamanya.

Untuk halaman seperti itu, jalankan tanpa semuanya:

```bash
node src/index.js --no-spoof --no-debug --url https://example.com/signup
```

Di panel: **Identity → Presets → No spoof**, dan **Full stealth** untuk
mengembalikan semuanya. Kamu tetap dapat profil sekali pakai, cookie jar kosong,
tanpa riwayat, semuanya dihapus saat ditutup, plus binding jaringan. Yang hilang
cuma bagian yang berbohong soal identitas browser — dan itu memang yang
dipermasalahkan bot check-nya.

---

## Apa saja yang bisa

Masing-masing berupa satu key di config, satu flag CLI, dan satu kontrol di
panel. Referensi lengkapnya di
**[docs/CONFIGURATION.md](docs/CONFIGURATION.md)** (bahasa Inggris).

**Tab status.** Tab pertama setiap sesi adalah halaman lokal berisi IP publik
saat ini, skor kualitasnya, identitas yang dipakai, dan — diukur langsung di
halaman itu — apa yang *sebenarnya* dilihat website, tiap barisnya ditandai
`match` atau `MISMATCH`. Override yang gagal langsung kelihatan. Ada tombol
Simple / Advanced yang sama seperti di panel, plus tombol terang/gelap sendiri
(`statusPage.theme`).

**Kualitas IP.** Alamatnya dinilai dari 100: terdeteksi proxy atau VPN dipotong
50, range datacenter 35, zona waktu browser yang tidak cocok dengan IP 15,
alamat CGNAT seluler 5. Tiap potongan ditampilkan beserta bobotnya, jadi angkanya
bisa diperiksa, bukan sekadar dipercaya.

**Pilih koneksinya.** Ikat sesi ke WiFi, LAN, adapter VPN, LAN kedua, atau IP
sumber tertentu. Dua adapter sejenis diberi nomor — `lan1`, `lan2` — jadi
pilihannya tidak pernah diserahkan pada keberuntungan.

**Proxy.** HTTP, HTTPS, dan SOCKS5, lengkap dengan autentikasi — termasuk SOCKS5
dengan username dan password, yang Chromium sendiri tidak bisa. Satu proxy per
instance, dipakai bergiliran.

**Beberapa browser sekaligus.** Tiga atau empat berdampingan, disusun jadi kolom
memanjang. Yang dibagi cuma layarnya: tiap instance punya identitas, profil, dan
cookie jar sendiri.

**Hemat bandwidth.** `balanced` membuang trafik yang memang tidak kamu lihat —
payload iklan, beacon analitik, video autoplay — tanpa ada yang rusak secara
kasat mata. `strict` juga membuang gambar dan web font. Frame captcha dan bot
check tidak pernah disentuh oleh keduanya.

**Rekaman sesi.** Dengan `--debug`, setiap klik, ketikan, submit form, navigasi,
dialog, unduhan, dan kegagalan jaringan ditulis ke `logs/` lengkap dengan waktu —
sebagai log yang mudah dibaca, sidecar `.jsonl`, dan timeline HTML yang bisa
dijelajahi. Kolom password tetap disensor.

**Macro.** Putar ulang rekaman: klik yang sama, teks yang sama di kolom yang
sama, submit yang sama, dengan urutan yang sama.

**Persona yang bisa diulang.** Beri seed, dan kamu dapat identitas yang persis
sama setiap kali — untuk debugging, atau untuk sesi yang memang ingin bisa
diulang.

---

## Bug yang sudah diketahui

Semua yang berhasil direproduksi, lengkap dengan yang sudah dipahami dan yang
belum, ada di satu halaman: **[docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md)**.

Ringkasnya: Brave bisa crash saat `Ctrl+T` kalau spoofing penuh sedang aktif; bot
check bisa menolak selesai (pakai **No spoof**); Brave tidak bisa diunduh
otomatis di Linux.

---

## Batasannya

Perlu dikatakan terus terang, karena anti-fingerprinting yang mengaku sempurna
itu selalu bohong.

- **Web Worker dan Service Worker tidak ditambal.** `Emulation.*` tetap berlaku
  di sana, tapi tambalan level JS seperti canvas dan WebGL hanya jalan di konteks
  halaman.
- **Daftar font tidak diacak.** Itu salah satu sinyal terkuat, dan tidak bisa
  diubah tanpa merusak tampilan halaman.
- **Karakteristik jaringan tidak disentuh.** Fingerprint TLS/JA3, urutan header
  HTTP/2, dan IP kamu tanpa proxy tidak berubah.
- **Persona acak itu sendiri adalah sinyal.** Tools ini dibuat untuk **pemisahan
  sesi** — supaya kunjungan hari ini tidak bisa dikaitkan dengan kemarin — bukan
  untuk menghilang. Untuk anonimitas, membaur dengan mayoritas (pendekatan Tor
  Browser) adalah strategi yang lebih kuat.
- **Kalau kamu login, kamu teridentifikasi.** Fingerprinting jadi tidak relevan
  begitu kamu memberi tahu situsnya siapa kamu.

Untuk anonimitas sungguhan menghadapi lawan yang serius, pakai Tor Browser.

---

## Cara kerjanya

```
node src/index.js
  ├─ deteksi browser dan versinya
  ├─ bangun persona dari seed acak
  ├─ buat profil sementara + Preferences privasi
  ├─ (opsional) jalankan proxy lokal yang diikat ke adapter pilihan
  ├─ jalankan Chromium dengan --no-startup-window + --remote-debugging-port
  ├─ sambungkan DevTools, aktifkan auto-attach
  ├─ untuk tiap target halaman:
  │     Emulation.setUserAgentOverride / TimezoneOverride / LocaleOverride
  │     Page.addScriptToEvaluateOnNewDocument  <- tambalan canvas/WebGL/screen
  ├─ buka tab di about:blank, tunggu spoofing siap, baru navigasi
  └─ saat keluar: tutup browser, hapus profil, tutup log
```

Dua hal yang memikul desain ini: `--no-startup-window`, supaya tidak ada halaman
yang bisa dimuat sebelum DevTools tersambung, dan pola *buka kosong dulu, baru
navigasi*, supaya halaman pertama tidak pernah balapan dengan penyiapan
spoofing.

### Susunan kode

| File | Tanggung jawabnya |
|---|---|
| `src/index.js` | CLI, manajer multi-instance |
| `src/session.js` | Satu sesi browser: profil, proses, CDP, logging |
| `src/config.js` | Default, parser JSON berkomentar, override dari CLI |
| `src/identity.js` | Pembangun persona |
| `src/personas.js` | Kumpulan data: lokasi, GPU, resolusi |
| `src/inject.js` | Tambalan fingerprint di level halaman |
| `src/statuspage.js` | Server halaman status lokal |
| `src/bandwidth.js` | Tingkat hemat data, daftar blokir, hitungan byte |
| `src/challenge.js` | Penyedia captcha / bot check, dikecualikan dari penghematan |
| `src/recorder.js` | Perekam sesi yang disuntik ke halaman |
| `src/report.js` | Timeline HTML yang ditulis di akhir sesi |
| `src/macro.js` | Pemuatan dan pemutaran ulang macro |
| `src/download.js` | Mengunduh dan membongkar browser |
| `src/browser.js` | Penemuan browser, penyusunan command line |
| `src/profile.js` | Profil sementara, preferensi privasi, penghapusan |
| `src/proxy.js` | Proxy lokal: binding interface, SOCKS5, auth upstream |
| `src/net.js` | Penemuan adapter dan resolusi alias |
| `src/layout.js` | Deteksi monitor dan penyusunan jendela |
| `src/logger.js` | Logger file + konsol |
| `src/cdp.js`, `src/ws.js` | Klien DevTools Protocol, WebSocket tulisan tangan |
| `src/app.js` | Server panel kontrol beserta API-nya |
| `app/` | Halaman panel: markup, logika klien, skema field, stylesheet |
| `src/statusview.js` | Markup status page, dipisah dari yang diukurnya |
| `tools/build-css.js` | Meng-compile `app/tailwind.css` dari class yang dipakai |

---

## Dokumentasi

| | |
|---|---|
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Semua opsi, dijelaskan satu per satu |
| [docs/LINUX.md](docs/LINUX.md) | Menjalankannya di Linux dan macOS |
| [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) | Bug yang diketahui dan cara mengakalinya |
| [config.example.json](config.example.json) | Referensi yang sama, langsung di dalam config |

Dokumen di folder `docs/` ditulis dalam bahasa Inggris.

### Tampilan

Panel dan status page ditata dengan Tailwind. `app/tailwind.css` ikut di-commit,
jadi menjalankan tools ini tetap tanpa npm dan tanpa build step, dan status page
tetap terbuka di dalam sesi sekali pakai tanpa script pihak ketiga dan tanpa
request keluar. Kalau ada nama class yang berubah, bangun ulang:

```bash
node tools/build-css.js
```

Perintah itu mengumpulkan semua class yang mungkin dihasilkan kedua halaman,
meng-compile-nya dengan compiler Tailwind sendiri di dalam browser yang sudah
dikenali tools ini, lalu menulis kembali hanya utility yang benar-benar dipakai
— saat ini sekitar 23 KB, sudah termasuk kedua tema.

Di sebelahnya ada `app/theme.css` yang ditulis tangan: scrollbar, warna seleksi,
gradasi di tepi panel log, dan aturan `prefers-reduced-motion` yang mematikan
semua animasi untuk orang yang memang meminta lebih sedikit gerakan ke
sistemnya.

---

## Lisensi

MIT. Copyright by Andra Lutfi Ridhotullah — lihat [LICENSE](LICENSE).

Pakai untuk privasimu sendiri dan untuk menguji apa yang memang boleh kamu uji.
Tools ini tidak dibuat untuk mengelabui bot detection, dan tidak akan
dikembangkan ke arah sana.
