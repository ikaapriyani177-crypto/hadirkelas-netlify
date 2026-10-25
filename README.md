# HadirKelas — Aplikasi Absensi QR untuk Sekolah

Aplikasi PWA absensi siswa yang berjalan di Netlify, menggunakan Google Apps Script sebagai backend dan Google Spreadsheet sebagai penyimpanan. Aplikasi dibuat dengan HTML/CSS/JavaScript tanpa langkah build frontend.

## Isi paket

- `public/` — antarmuka aplikasi, PWA manifest, service worker, ikon.
- `netlify/functions/api.mjs` — gerbang API sisi server tanpa layar PIN dan proxy ke Google Apps Script.
- `gas/Code.gs` — backend Google Apps Script.
- `template-google-spreadsheet.xlsx` — template penyimpanan backend dengan tab `Students`, `Attendance`, dan `Petunjuk`.
- `public/student-upload-template.csv` — template data siswa yang dapat dipilih melalui menu **Data siswa → Upload data siswa sekaligus**.
- `template-upload-data-siswa.xlsx` — template Excel untuk mengisi daftar siswa; simpan sebagai CSV UTF-8 sebelum diunggah ke aplikasi.
- `netlify.toml` — konfigurasi folder publik dan route `/api`.

## Fitur

- Aplikasi langsung terbuka tanpa memasukkan PIN.
- Dashboard jumlah siswa dan status kehadiran.
- Kelola siswa, NIS, kelas, aktif/nonaktif.
- Impor massal data siswa melalui CSV, validasi NIS ganda, serta update otomatis berdasarkan NIS yang sudah ada.
- QR unik per siswa, cetak satu kartu atau semua kartu.
- Buka sesi absensi; semua siswa aktif pada kelas tersebut dibuat berstatus `Alpa` sampai dipindai atau statusnya diedit.
- Pemindaian QR melalui kamera HP serta input manual.
- Cegah pemindaian hadir berulang untuk tanggal dan sesi yang sama.
- Rekap rentang tanggal, filter kelas, edit status/catatan, ekspor CSV, cetak.
- PWA yang bisa ditambahkan ke layar utama HP.

## A. Siapkan Google Spreadsheet

1. Unggah `template-google-spreadsheet.xlsx` ke Google Drive.
2. Buka file tersebut menggunakan Google Sheets dan simpan/konversikan sebagai Google Spreadsheet.
3. Pastikan tab bernama persis `Students` dan `Attendance`; jangan mengubah nama atau urutan header. Tab `Petunjuk` boleh tetap ada.
4. Dari spreadsheet, buka **Extensions / Ekstensi → Apps Script**.
5. Ganti isi `Code.gs` dengan semua isi file `gas/Code.gs` pada paket, kemudian simpan.
6. Di Project Settings / Setelan project, atur zona waktu ke **(GMT+07:00) Jakarta**.
7. Pada daftar fungsi, pilih `setupSheets` lalu klik **Run / Jalankan** satu kali. Berikan izin Google yang diminta. Fungsi itu menyimpan ID spreadsheet dan menyiapkan kedua tab.

## B. Buat rahasia backend

Aplikasi ini sengaja dibuat **tanpa PIN dan tanpa layar login**. Anda tetap harus membuat satu rahasia acak untuk melindungi sambungan server ke Google Apps Script. Contoh di terminal yang mendukung OpenSSL:

```sh
openssl rand -hex 32
```

Simpan nilai yang dihasilkan sebagai properti Apps Script `API_SHARED_SECRET` dan sebagai environment variable Netlify `GAS_SHARED_SECRET` dengan nilai yang sama persis.

Di Apps Script, buka **Project Settings → Script properties → Add script property**:

- Property: `API_SHARED_SECRET`
- Value: rahasia acak tersebut.

Jangan menaruh rahasia di `public/app.js`, spreadsheet, atau chat grup.

## C. Deploy backend Google Apps Script

1. Klik **Deploy → New deployment**.
2. Pilih jenis **Web app**.
3. **Execute as / Jalankan sebagai:** Me (akun pemilik script).
4. **Who has access / Siapa yang memiliki akses:** Anyone / Siapa saja. Endpoint ini perlu dapat dijangkau fungsi server Netlify; tiap permintaan tetap diperiksa terhadap `API_SHARED_SECRET` di server Apps Script.
5. Klik Deploy, selesaikan otorisasi, kemudian salin URL web app yang berakhir `/exec`.
6. Simpan URL itu untuk pengaturan Netlify di langkah berikutnya.

**Penting:** jangan menghapus pemeriksaan secret di `doPost`. Jika kode Apps Script diperbarui, perbarui deployment menggunakan **Deploy → Manage deployments → Edit → New version**.

## D. Deploy aplikasi dan fungsi API ke Netlify

Aplikasi memakai Netlify Function; karena itu **deploy seluruh proyek melalui Git atau Netlify CLI**, bukan hanya folder `public`. Cara termudah untuk pemeliharaan berkelanjutan:

1. Ekstrak folder proyek ini di komputer.
2. Masukkan seluruh isi folder proyek (termasuk `netlify/`, `netlify.toml`, dan `public/`) ke repositori Git privat.
3. Di Netlify pilih **Add new project / Import from Git** lalu pilih repositori tersebut.
4. Pastikan konfigurasi build mengambil `publish = "public"` dan `functions = "netlify/functions"` dari `netlify.toml`. Build command boleh kosong untuk versi ini.
5. Di pengaturan project Netlify, buka **Environment variables** dan tambahkan:

| Nama | Nilai |
|---|---|
| `GAS_WEB_APP_URL` | URL web app Apps Script yang berakhir `/exec` |
| `GAS_SHARED_SECRET` | Rahasia acak yang sama persis dengan `API_SHARED_SECRET` di Apps Script |

6. Simpan environment variables, kemudian lakukan deploy/redeploy.
7. Buka URL HTTPS Netlify. Aplikasi langsung membuka dashboard tanpa PIN; tambahkan siswa, lalu uji buka sesi absensi.

Alternatifnya, proyek bisa di-deploy lewat Netlify CLI dari folder akar proyek (`netlify.toml` harus tetap di akar). Environment variables tetap perlu disetel di project Netlify.

## E. Cara memakai aplikasi

1. Buka URL aplikasi; dashboard langsung terbuka tanpa PIN.
2. Buka **Data siswa** untuk menambah siswa secara manual, atau gunakan panel **Upload data siswa sekaligus** untuk mengimpor banyak siswa. Unduh template dari tautan **Unduh template CSV** atau isi `template-upload-data-siswa.xlsx`, lalu simpan lembar `Data Siswa` sebagai **CSV UTF-8**. File yang diunggah harus memiliki kolom `NIS`, `Nama`, dan `Kelas` pada baris pertama; pemisah koma maupun titik koma didukung.
3. Pilih file CSV pada panel upload. Aplikasi memvalidasi kolom wajib, baris kosong, batas panjang, dan NIS duplikat dalam file. Setelah jumlah siswa siap tampil, klik **Upload dan simpan siswa** dan konfirmasi impor.

**Perilaku impor:** NIS yang cocok dengan data yang sudah ada akan memperbarui nama/kelas dan mengaktifkan kembali siswa tersebut tanpa mengganti ID internalnya. NIS yang belum ada akan dibuat sebagai siswa baru. Data siswa lain yang tidak tercantum dalam file tidak dihapus. Maksimal 1.000 baris siswa per file.

4. Setelah data tersedia, setiap siswa mendapat ID internal unik. Klik **Cetak kartu QR** dan cetak/bagikan kartu yang benar kepada siswa.
5. Buka **Absensi QR Code**, pilih tanggal, kelas, dan sesi.
6. Tekan **Buka sesi absensi**. Siswa aktif di kelas tersebut akan muncul sebagai `Alpa` sampai statusnya diperbarui.
7. Tekan **Mulai pemindaian**, izinkan akses kamera, lalu arahkan kamera HP ke QR pada kartu siswa. Siswa yang valid akan berubah menjadi `Hadir` dengan waktu pemindaian.
8. Gunakan input manual untuk siswa yang kehilangan kartu atau untuk mengisi status `Izin`, `Sakit`, atau `Alpa` dengan catatan bila perlu.
9. Buka **Rekap absensi** untuk rentang tanggal, filter kelas, edit status/catatan, cetak, atau ekspor CSV.

## F. Instalasi ke HP

- **Android:** buka URL HTTPS Netlify lewat Chrome, buka menu ⋮, lalu pilih **Install app / Instal aplikasi** atau **Add to Home screen / Tambahkan ke layar utama**.
- **iPhone/iPad:** buka URL melalui Safari, tekan tombol Share, kemudian **Add to Home Screen**.
- Izinkan penggunaan kamera jika diminta. Kamera browser membutuhkan konteks aman HTTPS; URL Netlify menyediakan HTTPS.

## G. Batasan dan keamanan

- Data kehadiran **membutuhkan koneksi internet saat menyimpan**. Service worker menyimpan sebagian file antarmuka agar aplikasi lebih mudah dibuka, tetapi absensi offline tidak dimasukkan ke antrean dan jangan dianggap tersimpan sampai server memberi konfirmasi.
- QR Code berisi ID internal acak, bukan nama/NIS. Tetap jaga agar kartu tidak tertukar.
- **Peringatan mode tanpa PIN:** siapa pun yang mengetahui URL publik aplikasi dapat membaca dan mengubah data siswa/absensi melalui aplikasi. URL yang tidak dibagikan bukan pengganti autentikasi. Jangan gunakan mode ini untuk data siswa nyata yang sensitif di situs publik; gunakan perlindungan akses di depan aplikasi atau minta versi dengan autentikasi bila perlu.
- Rahasia `API_SHARED_SECRET` dan `GAS_SHARED_SECRET` harus selalu cocok. Jika menggantinya, perbarui nilainya di Apps Script dan Netlify.
- Aplikasi ini belum diuji dengan akun Google/Netlify milik sekolah Anda. Koneksi baru dapat diverifikasi setelah langkah konfigurasi dan deploy dilakukan dari akun tersebut. Aplikasi mode tanpa PIN tidak memerlukan environment variable `APP_PIN` maupun `SESSION_SECRET`.

## H. Pemeriksaan awal jika tidak berfungsi

- **Muncul pesan backend belum dikonfigurasi:** cek `GAS_WEB_APP_URL` dan `GAS_SHARED_SECRET`.
- **Koneksi backend ditolak:** nilai `API_SHARED_SECRET` di Script Properties Apps Script harus sama persis dengan `GAS_SHARED_SECRET` di Netlify.
- **Apps Script tidak mengembalikan JSON / HTTP error:** periksa bahwa URL berakhir `/exec`, deployment web app sudah aktif, dan akses deployment memungkinkan endpoint dipanggil.
- **Data tidak masuk ke sheet:** jalankan `setupSheets()` dari project Apps Script yang terikat pada spreadsheet yang benar dan periksa `SPREADSHEET_ID` di Script Properties.
- **Kamera tidak terbuka:** gunakan Chrome/Safari yang mendukung, pastikan URL HTTPS, izinkan kamera, tutup aplikasi lain yang memakai kamera, dan pastikan koneksi internet tersedia untuk memuat library pemindai.
- **Siswa tidak bisa dipindai:** pastikan kartu dicetak dari aplikasi terbaru, pilih kelas yang sesuai, serta buka sesi untuk tanggal/sesi yang benar.

## Uji sebelum digunakan sehari-hari

Gunakan beberapa siswa uji terlebih dahulu. Pastikan data siswa muncul setelah muat ulang, satu QR tercatat hadir sekali saja, QR kelas berbeda ditolak, status izin/sakit bisa diedit, laporan rentang tanggal benar, dan catatan terlihat di Google Spreadsheet. Hapus data uji sebelum dipakai sungguhan.
