(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const niceDate = (value) => {
    if (!value) return '—';
    const [y,m,d] = String(value).slice(0,10).split('-').map(Number);
    if (!y || !m || !d) return String(value);
    return new Date(y,m-1,d).toLocaleDateString('id-ID',{day:'numeric',month:'short',year:'numeric'});
  };
  const statusLabel = (status) => ({hadir:'Hadir',izin:'Izin',sakit:'Sakit',alpa:'Alpa'}[String(status||'').toLowerCase()] || status || 'Belum ada');
  const statusClass = (status) => ({hadir:'status-hadir',izin:'status-izin',sakit:'status-sakit',alpa:'status-alpa'}[String(status||'').toLowerCase()] || 'status-unknown');
  const toStatusKey = (status) => String(status || '').toLowerCase();
  let activeView = 'dashboard';
  let data = { students: [], attendance: [], classes: [] };
  let reportRows = [];
  let scanner = null;
  let scannerRunning = false;
  let scanBusy = false;
  let lastScanText = '';
  let lastScanAt = 0;
  let toastTimer = null;
  let editingStudent = null;

  async function api(action, payload = {}) {
    const response = await fetch('/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload })
    });
    let result;
    try { result = await response.json(); } catch (_) { throw new Error('Respons server tidak dapat dibaca. Periksa deployment Netlify.'); }
    if (!response.ok || result.ok === false) throw new Error(result.error || `Permintaan gagal (${response.status}).`);
    return result.data;
  }

  function showToast(message, kind = 'normal') {
    const el = $('toast'); el.textContent = message; el.className = `toast show ${kind}`;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.className = 'toast', 3200);
  }
  function globalMessage(message, show = true) {
    const box = $('globalMessage'); box.textContent = message; box.hidden = !show;
    const badge = document.querySelector('.cloud-status');
    if (badge) badge.innerHTML = `<i style="background:${show ? '#d97772' : '#35a77c'}"></i> ${show ? 'Belum terhubung' : 'Terhubung ke Spreadsheet'}`;
  }
  function showApplication() {
    const loginScreen = $('loginScreen'); if (loginScreen) loginScreen.hidden = true;
    $('application').hidden = false;
    $('todayLabel').textContent = new Date().toLocaleDateString('id-ID',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
    showView(activeView);
  }
  function showView(view) {
    activeView = view;
    const names = { dashboard:'Dashboard', attendance:'Absensi QR Code', students:'Data siswa', reports:'Rekap absensi' };
    $('pageHeading').textContent = names[view] || 'Dashboard';
    document.querySelectorAll('.page-view').forEach((el) => { el.hidden = el.id !== `${view}Page`; });
    document.querySelectorAll('[data-view]').forEach((el) => el.classList.toggle('active', el.dataset.view === view));
    if (view === 'attendance') renderAttendance();
    if (view === 'students') renderStudents();
    if (view === 'dashboard') renderDashboard();
  }
  async function loadState() {
    try {
      const date = $('attendanceDate').value || todayISO();
      const result = await api('getState', { date });
      data.students = Array.isArray(result.students) ? result.students : [];
      data.attendance = Array.isArray(result.attendance) ? result.attendance : [];
      data.classes = Array.isArray(result.classes) ? result.classes : [];
      globalMessage('', false); fillClassSelectors(); fillManualStudents();
      renderDashboard(); renderAttendance(); renderStudents();
      return true;
    } catch (err) {
      globalMessage(`Belum dapat terhubung ke backend: ${err.message}. Periksa URL Apps Script dan konfigurasi Netlify di panduan.`, true);
      showToast(err.message || 'Gagal memuat data.');
      throw err;
    }
  }
  function fillClassSelectors() {
    const classes = [...new Set([...data.classes, ...data.students.map(s => s.className)].filter(Boolean).map(String))].sort((a,b)=>a.localeCompare(b,'id'));
    const configs = [
      ['attendanceClass','Pilih kelas'], ['reportClass','Semua kelas'], ['studentClassFilter','Semua kelas']
    ];
    configs.forEach(([id, placeholder]) => {
      const el = $(id), previous = el.value;
      el.innerHTML = `<option value="">${placeholder}</option>` + classes.map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
      if (classes.includes(previous)) el.value = previous;
    });
  }
  function fillManualStudents() {
    const select = $('manualStudent'), previous = select.value;
    const active = data.students.filter(s => s.active !== false && String(s.active) !== 'false').sort((a,b)=>String(a.name).localeCompare(String(b.name),'id'));
    select.innerHTML = '<option value="">Pilih siswa</option>' + active.map(s=>`<option value="${escapeHtml(s.studentId)}">${escapeHtml(s.name)} — ${escapeHtml(s.className)}</option>`).join('');
    if (active.some(s=>s.studentId===previous)) select.value=previous;
  }
  function rowsTable(rows, columns, emptyText) {
    if (!rows || !rows.length) return `<table class="data-table"><tbody><tr><td class="table-empty" colspan="${columns.length}">${escapeHtml(emptyText)}</td></tr></tbody></table>`;
    return `<table class="data-table"><thead><tr>${columns.map(c=>`<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${columns.map(c=>`<td>${c.render ? c.render(row) : escapeHtml(row[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
  function tableAttendanceRecords(records, editing = false) {
    const rows = records.map(r => ({...r, name: r.name || studentName(r.studentId), className: r.className || studentClass(r.studentId)}));
    return rowsTable(rows,[
      {label:'Siswa',key:'name',render:r=>`<span class="student-name">${escapeHtml(r.name)}</span>`},
      {label:'Kelas',key:'className'},
      {label:'Waktu',key:'time',render:r=>escapeHtml(r.time || '—')},
      {label:'Status',key:'status',render:r=>editing ? `<button class="select-status ${statusClass(r.status)}" data-edit-record="${escapeHtml(r.recordId)}" title="Edit status">${escapeHtml(statusLabel(r.status))} ✎</button>` : `<span class="badge-status ${statusClass(r.status)}">${escapeHtml(statusLabel(r.status))}</span>`},
      {label:'Catatan',key:'notes',render:r=>escapeHtml(r.notes || '—')}
    ], 'Belum ada catatan absensi untuk pilihan ini.');
  }
  function getSelectedAttendance() {
    const date = $('attendanceDate').value || todayISO(), className = $('attendanceClass').value, session = $('attendanceSession').value;
    return data.attendance.filter(r => r.date === date && (!className || r.className === className) && (!session || r.session === session));
  }
  function renderDashboard() {
    const activeStudents = data.students.filter(s => s.active !== false && String(s.active) !== 'false');
    const records = data.attendance;
    const counts = { hadir:0, izin:0, sakit:0, alpa:0 };
    records.forEach(r=>{const key=toStatusKey(r.status);if(key in counts)counts[key]++;});
    $('statStudents').textContent = activeStudents.length;
    $('statPresent').textContent = counts.hadir;
    $('statExcused').textContent = counts.izin + counts.sakit;
    $('statAbsent').textContent = counts.alpa;
    const total = Math.max(records.length,1);
    const groups = [
      ['Hadir',counts.hadir,''],['Izin + sakit',counts.izin+counts.sakit,'amber'],['Alpa',counts.alpa,'red']
    ];
    $('attendanceSummary').innerHTML = records.length ? `<div class="summary-bars">${groups.map(([label,count,color])=>`<div><div class="summary-bar-head"><span>${label}</span><b>${count}</b></div><div class="summary-track"><div class="summary-fill ${color}" style="width:${Math.min(100,count/total*100)}%"></div></div></div>`).join('')}<p class="muted small" style="margin-top:14px">Total ${records.length} catatan pada tanggal ${escapeHtml(niceDate($('attendanceDate').value||todayISO()))} (gabungan kelas/sesi).</p></div>` : '<div class="empty-state">Belum ada sesi absensi hari ini. Buka sesi agar status siswa mulai tercatat.</div>';
    const recent = records.slice().sort((a,b)=>String(b.updatedAt||b.time||'').localeCompare(String(a.updatedAt||a.time||''))).slice(0,6);
    $('recentAttendance').innerHTML = tableAttendanceRecords(recent,false);
  }
  function renderAttendance() {
    if (!$('attendanceDate').value) $('attendanceDate').value = todayISO();
    const rows = getSelectedAttendance();
    const className = $('attendanceClass').value, session = $('attendanceSession').value;
    const opened = rows.length > 0;
    $('sessionBadge').className = `pill ${opened ? 'pill-green':'pill-neutral'}`;
    $('sessionBadge').textContent = opened ? '● Sesi sudah dibuka' : 'Sesi belum dibuka';
    $('attendanceCount').textContent = `${rows.length} catatan`;
    $('attendanceTableTitle').textContent = `Kehadiran ${className ? 'kelas '+className : 'semua kelas'} · ${session}`;
    $('attendanceTable').innerHTML = tableAttendanceRecords(rows,true);
    $('startScannerButton').disabled = !className || !rows.length;
    $('manualAttendanceForm').querySelector('button[type="submit"]').disabled = !className || !rows.length;
  }
  function renderStudents() {
    const query = $('studentSearch').value.trim().toLocaleLowerCase('id');
    const cls = $('studentClassFilter').value;
    const active = data.students.filter(s => s.active !== false && String(s.active) !== 'false');
    const rows = active.filter(s => (!cls || s.className===cls) && (!query || [s.name,s.studentNumber,s.className].some(v=>String(v||'').toLocaleLowerCase('id').includes(query)))).sort((a,b)=>String(a.className).localeCompare(String(b.className),'id') || String(a.name).localeCompare(String(b.name),'id'));
    $('studentTotal').textContent = active.length;
    $('studentsTable').innerHTML = rowsTable(rows,[
      {label:'Nama siswa',key:'name',render:s=>`<div class="student-name">${escapeHtml(s.name)}</div><div class="student-id-chip">NIS ${escapeHtml(s.studentNumber||'—')}</div>`},
      {label:'Kelas',key:'className'},
      {label:'QR ID',key:'studentId',render:s=>`<span class="student-id-chip">${escapeHtml(String(s.studentId||'').slice(0,8))}…</span>`},
      {label:'Aksi',key:'studentId',render:s=>`<div class="table-actions"><button class="mini-action" data-edit-student="${escapeHtml(s.studentId)}">Edit</button><button class="mini-action" data-card-student="${escapeHtml(s.studentId)}">Kartu QR</button><button class="mini-action danger" data-delete-student="${escapeHtml(s.studentId)}">Nonaktifkan</button></div>`}
    ],'Belum ada data siswa. Tambahkan siswa melalui formulir di sebelah kiri.');
  }
  function studentName(id) { const s = data.students.find(s=>s.studentId===id); return s ? s.name : 'Siswa tidak ditemukan'; }
  function studentClass(id) { const s = data.students.find(s=>s.studentId===id); return s ? s.className : '—'; }
  async function openSession() {
    const date=$('attendanceDate').value, className=$('attendanceClass').value, session=$('attendanceSession').value;
    if(!date || !className){showToast('Pilih tanggal dan kelas terlebih dahulu.');return;}
    try {
      const result=await api('openSession',{date,className,session});
      await loadState();
      showToast(`Sesi siap. ${result.inserted || 0} siswa disiapkan; ${result.existing || 0} data sebelumnya dipertahankan.`);
    } catch(err){showToast(err.message);}
  }
  function setScanNotice(message, kind='') { const el=$('scanNotice'); el.textContent=message; el.className=`scan-notice ${kind}`.trim(); }
  async function startScanner() {
    if (scannerRunning) return;
    if (!window.Html5Qrcode) { setScanNotice('Library pemindai belum termuat. Periksa koneksi internet lalu muat ulang aplikasi.','error'); return; }
    if (!$('attendanceClass').value) { setScanNotice('Pilih kelas terlebih dahulu.','error'); return; }
    if (!getSelectedAttendance().length) { setScanNotice('Buka sesi absensi terlebih dahulu sebelum memindai siswa.','error'); return; }
    $('startScannerButton').disabled=true;
    try {
      scanner=new Html5Qrcode('reader');
      await scanner.start({facingMode:'environment'},{fps:10,qrbox:{width:230,height:230},aspectRatio:1.0},onQrScanned,()=>{});
      scannerRunning=true;$('stopScannerButton').disabled=false;$('startScannerButton').textContent='Pemindaian aktif';
      setScanNotice('Kamera aktif. Posisikan QR Code siswa di dalam bingkai.');
    } catch(err) {
      scanner=null; scannerRunning=false; $('startScannerButton').disabled=false;
      setScanNotice(`Kamera tidak dapat dibuka: ${err.message || err}. Periksa izin kamera dan pastikan aplikasi dibuka melalui HTTPS.`,'error');
    }
  }
  async function onQrScanned(decodedText) {
    const now=Date.now();
    if(scanBusy || (decodedText===lastScanText && now-lastScanAt<2500)) return;
    scanBusy=true;lastScanText=decodedText;lastScanAt=now;
    try {
      const result=await api('markAttendance',{qrCode:decodedText,date:$('attendanceDate').value,className:$('attendanceClass').value,session:$('attendanceSession').value});
      if(result.duplicate) setScanNotice(`${result.name || 'Siswa'} sudah tercatat hadir pada sesi ini.`,'error');
      else setScanNotice(`Berhasil! ${result.name || 'Siswa'} tercatat hadir pada ${result.time || 'saat ini'}.`,'success');
      await loadState();
    } catch(err) { setScanNotice(err.message || 'QR Code gagal diproses.','error'); }
    finally { scanBusy=false; }
  }
  async function stopScanner() {
    if(scanner && scannerRunning) {
      try { await scanner.stop(); } catch(_) {}
      try { await scanner.clear(); } catch(_) {}
    }
    scanner=null;scannerRunning=false;scanBusy=false;
    const reader=$('reader'); if(reader) reader.innerHTML='<div class="reader-placeholder"><div class="camera-symbol">▣</div><b>Kamera belum aktif</b><p>Tekan tombol di bawah untuk mulai memindai kartu siswa.</p></div>';
    const start=$('startScannerButton'), stop=$('stopScannerButton');
    if(start){start.disabled=!$('attendanceClass').value || !getSelectedAttendance().length;start.textContent='▣ Mulai pemindaian';}
    if(stop)stop.disabled=true;
  }
  async function manualAttendance(event) {
    event.preventDefault();
    const className=$('attendanceClass').value, studentId=$('manualStudent').value;
    if(!className){showToast('Pilih kelas dan buka sesi absensi terlebih dahulu.');return;}
    const student=data.students.find(s=>s.studentId===studentId);
    if(!student){showToast('Pilih siswa terlebih dahulu.');return;}
    try {
      const result=await api('setAttendanceForStudent',{date:$('attendanceDate').value,className,session:$('attendanceSession').value,studentId,status:$('manualStatus').value,notes:$('manualNotes').value.trim()});
      $('manualNotes').value='';await loadState();
      showToast(result.updated ? 'Status absensi diperbarui.' : 'Absensi manual berhasil disimpan.');
    } catch(err){showToast(err.message);}
  }
  function clearStudentForm() {
    editingStudent=null;$('studentForm').reset();$('studentId').value='';$('studentFormTitle').textContent='Tambah siswa';$('saveStudentButton').textContent='Simpan siswa';$('cancelStudentEdit').hidden=true;
  }
  async function saveStudent(event) {
    event.preventDefault();
    const payload={studentId:$('studentId').value||undefined,studentNumber:$('studentNumber').value.trim(),name:$('studentName').value.trim(),className:$('studentClass').value.trim()};
    if(!payload.studentNumber||!payload.name||!payload.className){showToast('Lengkapi semua data siswa.');return;}
    try {
      const result=await api('saveStudent',payload);await loadState();clearStudentForm();showToast(result.updated?'Data siswa berhasil diperbarui.':'Siswa berhasil ditambahkan.');
    } catch(err){showToast(err.message);}
  }
  function parseDelimited(text, delimiter) {
    const rows=[]; let row=[], field='', quoted=false;
    for(let i=0;i<text.length;i++){
      const ch=text[i];
      if(quoted){
        if(ch==='"' && text[i+1]==='"'){field+='"';i++;}
        else if(ch==='"') quoted=false;
        else field+=ch;
      } else if(ch==='"' && field.length===0) quoted=true;
      else if(ch===delimiter){row.push(field);field='';}
      else if(ch==='\n'){row.push(field.replace(/\r$/,''));rows.push(row);row=[];field='';}
      else field+=ch;
    }
    row.push(field.replace(/\r$/,''));
    if(row.some(v=>String(v).trim()!=='')) rows.push(row);
    return rows;
  }
  function parseStudentCsv(text) {
    const cleanText=String(text||'').replace(/^\uFEFF/,'');
    const firstLine=(cleanText.split(/\r?\n/).find(line=>line.trim())||'');
    const delimiters=[';',',','\t'];
    const delimiter=delimiters.map(d=>({d,count:(firstLine.match(new RegExp(d==='\t'?'\\t':d===';'?';':',','g'))||[]).length})).sort((a,b)=>b.count-a.count)[0].d;
    const rows=parseDelimited(cleanText,delimiter).filter(r=>r.some(v=>String(v).trim()!==''));
    if(rows.length<2) throw new Error('File harus berisi baris judul dan minimal satu data siswa.');
    const headers=rows[0].map(v=>String(v||'').trim().toLocaleLowerCase('id').replace(/[._-]/g,' ').replace(/\s+/g,' '));
    const findHeader=(names)=>headers.findIndex(h=>names.includes(h));
    const nisIndex=findHeader(['nis','nisn','nomor induk','nis / nomor induk','nomor induk siswa','student number']);
    const nameIndex=findHeader(['nama','nama lengkap','nama siswa','name']);
    const classIndex=findHeader(['kelas','rombel','class','class name']);
    if(nisIndex<0||nameIndex<0||classIndex<0) throw new Error('Judul kolom belum sesuai. Gunakan NIS;Nama;Kelas atau NIS,Nama,Kelas.');
    const students=[]; const seen=new Set(); const errors=[];
    rows.slice(1).forEach((r,index)=>{
      if(!r.some(v=>String(v).trim())) return;
      const line=index+2;
      const studentNumber=String(r[nisIndex]??'').trim();
      const name=String(r[nameIndex]??'').trim();
      const className=String(r[classIndex]??'').trim();
      if(!studentNumber||!name||!className){errors.push(`Baris ${line}: NIS, nama, dan kelas wajib diisi.`);return;}
      if(studentNumber.length>40||name.length>100||className.length>40){errors.push(`Baris ${line}: ada data yang melebihi batas panjang kolom.`);return;}
      const key=studentNumber.toLocaleLowerCase('id');
      if(seen.has(key)){errors.push(`Baris ${line}: NIS ${studentNumber} muncul lebih dari sekali di file.`);return;}
      seen.add(key);students.push({studentNumber,name,className});
    });
    if(errors.length) throw new Error(errors.slice(0,6).join(' ') + (errors.length>6?` Dan ${errors.length-6} kesalahan lainnya.`:''));
    if(!students.length) throw new Error('Tidak ada baris siswa yang dapat diimpor.');
    if(students.length>1000) throw new Error('Maksimal 1.000 siswa dalam satu file. Pecah file menjadi beberapa bagian.');
    return students;
  }
  let pendingStudentImport=[];
  async function chooseStudentCsv() {
    const file=$('studentCsvFile').files?.[0]; pendingStudentImport=[];
    const preview=$('studentImportPreview'), button=$('importStudentsButton');
    button.disabled=true;
    if(!file){preview.textContent='Belum ada file dipilih.';return;}
    if(file.size>2*1024*1024){preview.textContent='File terlalu besar. Batas ukuran 2 MB.';showToast('Ukuran file maksimal 2 MB.');return;}
    if(!/\.csv$/i.test(file.name)){preview.textContent='Pilih file dengan format .csv.';return;}
    try{
      pendingStudentImport=parseStudentCsv(await file.text());
      const existing=new Map(data.students.map(s=>[String(s.studentNumber).toLocaleLowerCase('id'),s]));
      const updateCount=pendingStudentImport.filter(s=>existing.has(s.studentNumber.toLocaleLowerCase('id'))).length;
      preview.innerHTML=`<b>${pendingStudentImport.length} siswa siap diimpor</b><span>${pendingStudentImport.length-updateCount} siswa baru · ${updateCount} akan diperbarui berdasarkan NIS</span>`;
      button.disabled=false;
    }catch(err){preview.textContent=err.message||'File CSV tidak dapat dibaca.';}
  }
  async function importStudents(event) {
    event.preventDefault();
    if(!pendingStudentImport.length){showToast('Pilih file CSV yang valid terlebih dahulu.');return;}
    const newCount=pendingStudentImport.filter(s=>!data.students.some(x=>String(x.studentNumber).toLocaleLowerCase('id')===s.studentNumber.toLocaleLowerCase('id'))).length;
    const updateCount=pendingStudentImport.length-newCount;
    if(!confirm(`Impor ${pendingStudentImport.length} siswa?\n${newCount} data baru dan ${updateCount} data akan diperbarui berdasarkan NIS. Data siswa lain yang tidak ada di file tidak akan dihapus.`))return;
    const button=$('importStudentsButton');button.disabled=true;button.textContent='Mengunggah…';
    try{
      const result=await api('importStudents',{students:pendingStudentImport});
      await loadState();
      $('studentImportForm').reset();pendingStudentImport=[];$('studentImportPreview').textContent='Belum ada file dipilih.';
      showToast(`Impor berhasil: ${result.created||0} siswa baru, ${result.updated||0} data diperbarui.`,'success');
    }catch(err){showToast(err.message||'Impor gagal.');}
    finally{button.disabled=!pendingStudentImport.length;button.textContent='↑ Upload dan simpan siswa';}
  }
  async function editStudent(id) {
    const s=data.students.find(s=>s.studentId===id);if(!s)return;
    editingStudent=s;$('studentId').value=s.studentId;$('studentNumber').value=s.studentNumber||'';$('studentName').value=s.name||'';$('studentClass').value=s.className||'';
    $('studentFormTitle').textContent='Edit data siswa';$('saveStudentButton').textContent='Simpan perubahan';$('cancelStudentEdit').hidden=false;
    $('studentNumber').focus();window.scrollTo({top:0,behavior:'smooth'});
  }
  async function deleteStudent(id) {
    const s=data.students.find(s=>s.studentId===id);if(!s)return;
    if(!confirm(`Nonaktifkan data ${s.name}? Catatan absensi lama tetap disimpan.`))return;
    try{await api('deleteStudent',{studentId:id});await loadState();showToast('Siswa dinonaktifkan; riwayat absensi tetap tersimpan.');}catch(err){showToast(err.message);}
  }
  function openCardPrint(selected = null) {
    const students=data.students.filter(s=>(s.active!==false && String(s.active)!=='false') && (!selected||s.studentId===selected)).sort((a,b)=>String(a.className).localeCompare(String(b.className),'id')||String(a.name).localeCompare(String(b.name),'id'));
    if(!students.length){showToast('Belum ada siswa aktif untuk dicetak.');return;}
    const popup=window.open('', '_blank');
    if(!popup){showToast('Izinkan pop-up untuk mencetak kartu QR.');return;}
    const cards=students.map((s,i)=>`<article class="card"><div class="school">KARTU ABSENSI SISWA</div><div class="card-main"><div><h2>${escapeHtml(s.name)}</h2><p>Kelas <b>${escapeHtml(s.className)}</b></p><p>NIS ${escapeHtml(s.studentNumber||'—')}</p></div><div class="qr" id="qr${i}"></div></div><p class="hint">Pindai QR Code ini saat absensi. Jangan menukar kartu dengan teman.</p></article>`).join('');
    popup.document.write(`<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Kartu QR Siswa</title><style>body{font-family:Arial,sans-serif;margin:18px;color:#263d34}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.card{border:1px solid #b8d3c6;border-radius:12px;padding:15px;break-inside:avoid}.school{font-size:10px;letter-spacing:1.5px;font-weight:bold;color:#287b60;border-bottom:1px solid #dfebe4;padding-bottom:8px}.card-main{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0}.card h2{font-size:17px;margin:0 0 9px;overflow-wrap:anywhere}.card p{font-size:11px;margin:4px 0;color:#6d7c73}.qr{width:95px;height:95px;flex-shrink:0}.qr img{width:95px;height:95px}.hint{border-top:1px dashed #d6e2db;padding-top:8px!important;font-size:9px!important}@media print{body{margin:8mm}.grid{gap:8px}.card{border:1px solid #999}}</style></head><body><h1 style="font-size:19px">Kartu QR Absensi Siswa</h1><p style="font-size:11px;color:#708078">Cetak dan bagikan satu kartu kepada setiap siswa.</p><div class="grid">${cards}</div><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script><script>window.onload=()=>{${students.map((s,i)=>`new QRCode(document.getElementById('qr${i}'),{text:${JSON.stringify('SISWA:'+s.studentId)},width:95,height:95,colorDark:'#153d31',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M});`).join('')}setTimeout(()=>window.print(),700)};<\/script></body></html>`);
    popup.document.close();
  }
  async function loadReport() {
    const startDate=$('reportStart').value||todayISO(), endDate=$('reportEnd').value||todayISO(), className=$('reportClass').value;
    if(startDate>endDate){showToast('Tanggal awal harus sama dengan atau sebelum tanggal akhir.');return;}
    try {
      const result=await api('getReport',{startDate,endDate,className});reportRows=Array.isArray(result.records)?result.records:[];
      const counts={hadir:0,izin:0,sakit:0,alpa:0};reportRows.forEach(r=>{const k=toStatusKey(r.status);if(k in counts)counts[k]++;});
      $('reportRecords').textContent=reportRows.length;$('reportPresent').textContent=counts.hadir;$('reportExcused').textContent=counts.izin+counts.sakit;$('reportAbsent').textContent=counts.alpa;
      $('reportTable').innerHTML=rowsTable(reportRows.slice().sort((a,b)=>String(b.date).localeCompare(String(a.date))||String(a.name).localeCompare(String(b.name),'id')),[
        {label:'Tanggal',key:'date',render:r=>escapeHtml(niceDate(r.date))},{label:'Siswa',key:'name',render:r=>`<span class="student-name">${escapeHtml(r.name)}</span>`},{label:'Kelas',key:'className'},{label:'Sesi',key:'session'},{label:'Waktu',key:'time',render:r=>escapeHtml(r.time||'—')},{label:'Status',key:'status',render:r=>`<button class="select-status ${statusClass(r.status)}" data-edit-record="${escapeHtml(r.recordId)}">${escapeHtml(statusLabel(r.status))} ✎</button>`},{label:'Catatan',key:'notes',render:r=>escapeHtml(r.notes||'—')}
      ],'Tidak ada data pada rentang tanggal yang dipilih.');
    }catch(err){showToast(err.message);}
  }
  function editAttendance(recordId) {
    const record=[...data.attendance,...reportRows].find(r=>r.recordId===recordId);if(!record)return;
    $('editRecordId').value=recordId;$('editAttendanceStatus').value=statusLabel(record.status);$('editAttendanceNotes').value=record.notes||'';$('editAttendanceModal').hidden=false;
  }
  function closeAttendanceEdit(){$('editAttendanceModal').hidden=true;}
  async function saveAttendanceEdit(event) {
    event.preventDefault();
    try {
      await api('updateAttendance',{recordId:$('editRecordId').value,status:$('editAttendanceStatus').value,notes:$('editAttendanceNotes').value.trim()});
      closeAttendanceEdit();await loadState();if(activeView==='reports')await loadReport();showToast('Status kehadiran berhasil diperbarui.');
    }catch(err){showToast(err.message);}
  }
  function downloadReportCsv() {
    if(!reportRows.length){showToast('Muat rekap terlebih dahulu sebelum ekspor.');return;}
    const headers=['Tanggal','Sesi','ID Siswa','Nama','Kelas','Status','Waktu','Catatan'];
    const quote=(v)=>`"${String(v??'').replace(/"/g,'""')}"`;
    const csv='\ufeff'+[headers,...reportRows.map(r=>[r.date,r.session,r.studentId,r.name,r.className,statusLabel(r.status),r.time,r.notes])].map(row=>row.map(quote).join(';')).join('\r\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`rekap-absensi-${$('reportStart').value||todayISO()}-${$('reportEnd').value||todayISO()}.csv`;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
  }
  function printActivePage(id) {
    document.querySelectorAll('.page-view').forEach(el=>el.classList.toggle('print-target',el.id===id));
    window.print();setTimeout(()=>document.querySelectorAll('.page-view').forEach(el=>el.classList.remove('print-target')),500);
  }
  function initDefaults() {
    const today=todayISO();$('attendanceDate').value=today;$('reportStart').value=today;$('reportEnd').value=today;
    $('attendanceDate').addEventListener('change',async()=>{try{await loadState();}catch(_){}});
    $('attendanceClass').addEventListener('change',()=>{renderAttendance();setScanNotice('Kelas berubah. Pastikan sesi absensi untuk kelas ini sudah dibuka.');});
    $('attendanceSession').addEventListener('change',renderAttendance);
    $('studentSearch').addEventListener('input',renderStudents);$('studentClassFilter').addEventListener('change',renderStudents);
    document.querySelectorAll('[data-view]').forEach(el=>el.addEventListener('click',()=>showView(el.dataset.view)));
    document.querySelectorAll('[data-goto]').forEach(el=>el.addEventListener('click',()=>showView(el.dataset.goto)));
    $('refreshButton').addEventListener('click',async()=>{try{await loadState();showToast('Data berhasil diperbarui.');}catch(_){}});
    $('openSessionButton').addEventListener('click',openSession);$('startScannerButton').addEventListener('click',startScanner);$('stopScannerButton').addEventListener('click',stopScanner);
    $('manualAttendanceForm').addEventListener('submit',manualAttendance);$('studentForm').addEventListener('submit',saveStudent);$('cancelStudentEdit').addEventListener('click',clearStudentForm);
    $('studentCsvFile').addEventListener('change',chooseStudentCsv);$('studentImportForm').addEventListener('submit',importStudents);
    $('studentsTable').addEventListener('click',e=>{const edit=e.target.closest('[data-edit-student]'),card=e.target.closest('[data-card-student]'),del=e.target.closest('[data-delete-student]');if(edit)editStudent(edit.dataset.editStudent);if(card)openCardPrint(card.dataset.cardStudent);if(del)deleteStudent(del.dataset.deleteStudent);});
    $('printCardsButton').addEventListener('click',()=>openCardPrint());$('attendanceTable').addEventListener('click',e=>{const btn=e.target.closest('[data-edit-record]');if(btn)editAttendance(btn.dataset.editRecord);});
    $('reportTable').addEventListener('click',e=>{const btn=e.target.closest('[data-edit-record]');if(btn)editAttendance(btn.dataset.editRecord);});
    $('loadReportButton').addEventListener('click',loadReport);$('exportReportButton').addEventListener('click',downloadReportCsv);$('printReportButton').addEventListener('click',()=>printActivePage('reportsPage'));$('printAttendanceButton').addEventListener('click',()=>printActivePage('attendancePage'));
    $('editAttendanceForm').addEventListener('submit',saveAttendanceEdit);$('closeAttendanceModal').addEventListener('click',closeAttendanceEdit);$('cancelAttendanceEdit').addEventListener('click',closeAttendanceEdit);$('editAttendanceModal').addEventListener('click',e=>{if(e.target===$('editAttendanceModal'))closeAttendanceEdit();});
  }
  initDefaults();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('/service-worker.js').catch(()=>{});
  showApplication();
  loadState().catch(()=>{});
})();
