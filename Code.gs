/**
 * HadirKelas — Google Apps Script backend
 * 1. Buat spreadsheet kosong, lalu Extensions > Apps Script.
 * 2. Tempel file ini, simpan, jalankan setupSheets() satu kali.
 * 3. Di Project Settings > Script properties, tambahkan API_SHARED_SECRET.
 * 4. Deploy > New deployment > Web app; Execute as: Me; Who has access: Anyone.
 *    URL /exec dipakai oleh Netlify Function. Secret diverifikasi di sini.
 */
const STUDENTS_SHEET = 'Students';
const ATTENDANCE_SHEET = 'Attendance';
const STUDENT_HEADERS = ['studentId', 'studentNumber', 'name', 'className', 'active', 'createdAt', 'updatedAt'];
const ATTENDANCE_HEADERS = ['recordId', 'date', 'session', 'studentId', 'name', 'className', 'status', 'time', 'notes', 'scannedAt', 'updatedAt'];
const ALLOWED_STATUSES = ['hadir', 'izin', 'sakit', 'alpa'];

function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Buat spreadsheet terlebih dahulu, lalu buka Extensions > Apps Script dari spreadsheet tersebut.');
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  ensureSheet_(ss, STUDENTS_SHEET, STUDENT_HEADERS);
  ensureSheet_(ss, ATTENDANCE_SHEET, ATTENDANCE_HEADERS);
  SpreadsheetApp.flush();
  return 'Selesai: SPREADSHEET_ID disimpan dan sheet Students serta Attendance sudah siap.';
}

function doGet() {
  return json_({ ok: true, data: { service: 'HadirKelas API', message: 'Backend berjalan. Permintaan data harus dikirim melalui POST dengan autentikasi server.' } });
}

function doPost(e) {
  try {
    const request = JSON.parse(e && e.postData && e.postData.contents || '{}');
    const expectedSecret = PropertiesService.getScriptProperties().getProperty('API_SHARED_SECRET') || '';
    if (!expectedSecret || !constantTimeEqual_(String(request.secret || ''), expectedSecret)) {
      return json_({ ok: false, error: 'Permintaan backend tidak terautentikasi.' });
    }
    const ssId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (!ssId) return json_({ ok: false, error: 'Spreadsheet belum disiapkan. Jalankan setupSheets() dari editor Apps Script.' });
    const ss = SpreadsheetApp.openById(ssId);
    ensureSheet_(ss, STUDENTS_SHEET, STUDENT_HEADERS);
    ensureSheet_(ss, ATTENDANCE_SHEET, ATTENDANCE_HEADERS);
    const action = String(request.action || '');
    let result;
    switch (action) {
      case 'getState': result = getState_(ss, request); break;
      case 'saveStudent': result = saveStudent_(ss, request); break;
      case 'importStudents': result = importStudents_(ss, request); break;
      case 'deleteStudent': result = deleteStudent_(ss, request); break;
      case 'openSession': result = openSession_(ss, request); break;
      case 'markAttendance': result = markAttendance_(ss, request); break;
      case 'setAttendanceForStudent': result = setAttendanceForStudent_(ss, request); break;
      case 'updateAttendance': result = updateAttendance_(ss, request); break;
      case 'getReport': result = getReport_(ss, request); break;
      default: throw new Error('Aksi tidak dikenal: ' + action);
    }
    return json_({ ok: true, data: result });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function getState_(ss, request) {
  const date = validDate_(request.date || today_());
  const students = readRows_(ss.getSheetByName(STUDENTS_SHEET), STUDENT_HEADERS).map(r => ({
    studentId: String(r.studentId || ''), studentNumber: String(r.studentNumber || ''),
    name: String(r.name || ''), className: String(r.className || ''), active: bool_(r.active),
    createdAt: String(r.createdAt || ''), updatedAt: String(r.updatedAt || '')
  }));
  const allAttendance = readAttendance_(ss);
  const attendance = allAttendance.filter(r => r.date === date).map(r => r.record);
  const classes = unique_(students.filter(s => s.active).map(s => s.className)).sort();
  return { date: date, students: students, attendance: attendance, classes: classes };
}

function saveStudent_(ss, req) {
  const id = String(req.studentId || '').trim();
  const number = clean_(req.studentNumber, 40, 'NIS/nomor induk');
  const name = clean_(req.name, 100, 'Nama siswa');
  const className = clean_(req.className, 40, 'Kelas');
  const sheet = ss.getSheetByName(STUDENTS_SHEET);
  const rows = readRowsWithIndex_(sheet, STUDENT_HEADERS);
  const existingNumber = rows.find(x => String(x.record.studentNumber) === number && String(x.record.studentId) !== id);
  if (existingNumber) throw new Error('NIS/nomor induk sudah digunakan siswa lain.');
  const now = new Date().toISOString();
  if (id) {
    const found = rows.find(x => String(x.record.studentId) === id);
    if (!found) throw new Error('Data siswa yang akan diedit tidak ditemukan.');
    const value = [id, number, name, className, bool_(found.record.active), found.record.createdAt || now, now];
    sheet.getRange(found.rowNumber, 1, 1, STUDENT_HEADERS.length).setValues([value]);
    return { updated: true, studentId: id };
  }
  const studentId = Utilities.getUuid();
  sheet.appendRow([studentId, number, name, className, true, now, now]);
  return { updated: false, studentId: studentId };
}

function importStudents_(ss, req) {
  const incoming = req.students;
  if (!Array.isArray(incoming) || incoming.length < 1) throw new Error('File tidak berisi data siswa untuk diimpor.');
  if (incoming.length > 1000) throw new Error('Maksimal 1.000 siswa dalam satu kali impor.');
  const normalized = [];
  const seen = {};
  incoming.forEach(function(item, index) {
    const row = index + 2;
    const studentNumber = clean_(item && item.studentNumber, 40, 'NIS pada baris ' + row);
    const name = clean_(item && item.name, 100, 'Nama pada baris ' + row);
    const className = clean_(item && item.className, 40, 'Kelas pada baris ' + row);
    const key = studentNumber.toLocaleLowerCase();
    if (seen[key]) throw new Error('NIS ' + studentNumber + ' muncul lebih dari sekali pada file.');
    seen[key] = true;
    normalized.push({studentNumber: studentNumber, name: name, className: className});
  });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = ss.getSheetByName(STUDENTS_SHEET);
    const existingRows = readRowsWithIndex_(sheet, STUDENT_HEADERS);
    const byNumber = {};
    existingRows.forEach(function(entry) {
      const key = String(entry.record.studentNumber || '').trim().toLocaleLowerCase();
      if (key && !byNumber[key]) byNumber[key] = entry;
    });
    const now = new Date().toISOString();
    const newRows = [];
    let updated = 0;
    normalized.forEach(function(student) {
      const key = student.studentNumber.toLocaleLowerCase();
      const found = byNumber[key];
      if (found) {
        const r = found.record;
        sheet.getRange(found.rowNumber, 1, 1, STUDENT_HEADERS.length).setValues([[
          String(r.studentId || Utilities.getUuid()), student.studentNumber, student.name, student.className, true, r.createdAt || now, now
        ]]);
        updated++;
      } else {
        newRows.push([Utilities.getUuid(), student.studentNumber, student.name, student.className, true, now, now]);
      }
    });
    if (newRows.length) sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, STUDENT_HEADERS.length).setValues(newRows);
    SpreadsheetApp.flush();
    return {created: newRows.length, updated: updated, totalImported: normalized.length};
  } finally { lock.releaseLock(); }
}

function deleteStudent_(ss, req) {
  const id = String(req.studentId || '').trim();
  if (!id) throw new Error('ID siswa wajib diisi.');
  const sheet = ss.getSheetByName(STUDENTS_SHEET);
  const found = readRowsWithIndex_(sheet, STUDENT_HEADERS).find(x => String(x.record.studentId) === id);
  if (!found) throw new Error('Data siswa tidak ditemukan.');
  const r = found.record;
  sheet.getRange(found.rowNumber, 1, 1, STUDENT_HEADERS.length).setValues([[r.studentId, r.studentNumber, r.name, r.className, false, r.createdAt, new Date().toISOString()]]);
  return { studentId: id, active: false };
}

function openSession_(ss, req) {
  const date = validDate_(req.date || today_());
  const className = clean_(req.className, 40, 'Kelas');
  const session = clean_(req.session || 'Pagi', 40, 'Sesi');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const students = readRows_(ss.getSheetByName(STUDENTS_SHEET), STUDENT_HEADERS)
      .filter(r => bool_(r.active) && String(r.className) === className);
    if (!students.length) throw new Error('Belum ada siswa aktif pada kelas ' + className + '. Tambahkan data siswa terlebih dahulu.');
    const existing = readAttendance_(ss).filter(x => x.record.date === date && x.record.session === session && x.record.className === className);
    const existingKeys = new Set(existing.map(x => x.record.studentId));
    const missing = students.filter(s => !existingKeys.has(String(s.studentId)));
    const now = new Date().toISOString();
    const values = missing.map(s => [Utilities.getUuid(), date, session, String(s.studentId), String(s.name), className, 'alpa', '', '', '', now]);
    if (values.length) {
      const sheet = ss.getSheetByName(ATTENDANCE_SHEET);
      sheet.getRange(sheet.getLastRow() + 1, 1, values.length, ATTENDANCE_HEADERS.length).setValues(values);
    }
    SpreadsheetApp.flush();
    return { inserted: values.length, existing: existing.length, total: students.length, date: date, className: className, session: session };
  } finally { lock.releaseLock(); }
}

function markAttendance_(ss, req) {
  const qrCode = String(req.qrCode || '').trim();
  const studentId = String(req.studentId || (qrCode.indexOf('SISWA:') === 0 ? qrCode.slice(6) : '')).trim();
  if (!studentId) throw new Error('QR Code tidak dikenali. Gunakan kartu QR dari aplikasi ini.');
  const date = validDate_(req.date || today_());
  const session = clean_(req.session || 'Pagi', 40, 'Sesi');
  const className = clean_(req.className, 40, 'Kelas');
  const student = readRows_(ss.getSheetByName(STUDENTS_SHEET), STUDENT_HEADERS).find(r => String(r.studentId) === studentId && bool_(r.active));
  if (!student) throw new Error('Siswa tidak ditemukan atau sudah tidak aktif. Periksa kartu QR.');
  if (String(student.className) !== className) throw new Error('Kartu ini milik kelas ' + student.className + ', bukan kelas ' + className + '.');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sheet = ss.getSheetByName(ATTENDANCE_SHEET);
    const matches = readRowsWithIndex_(sheet, ATTENDANCE_HEADERS).filter(x => x.record.date === date && x.record.session === session && x.record.studentId === studentId && x.record.className === className);
    const now = new Date();
    const time = Utilities.formatDate(now, Session.getScriptTimeZone(), 'HH:mm:ss');
    const iso = now.toISOString();
    if (matches.length) {
      const found = matches[0];
      if (String(found.record.scannedAt || '')) return { duplicate: true, name: student.name, time: found.record.time || '' };
      const r = found.record;
      const value = [r.recordId, date, session, studentId, student.name, className, 'hadir', time, r.notes || '', iso, iso];
      sheet.getRange(found.rowNumber, 1, 1, ATTENDANCE_HEADERS.length).setValues([value]);
    } else {
      sheet.appendRow([Utilities.getUuid(), date, session, studentId, student.name, className, 'hadir', time, '', iso, iso]);
    }
    SpreadsheetApp.flush();
    return { duplicate: false, name: student.name, time: time, studentId: studentId };
  } finally { lock.releaseLock(); }
}

function setAttendanceForStudent_(ss, req) {
  const studentId = String(req.studentId || '').trim();
  const date = validDate_(req.date || today_());
  const session = clean_(req.session || 'Pagi', 40, 'Sesi');
  const className = clean_(req.className, 40, 'Kelas');
  const status = normalizeStatus_(req.status);
  const notes = optionalText_(req.notes, 250);
  const student = readRows_(ss.getSheetByName(STUDENTS_SHEET), STUDENT_HEADERS).find(r => String(r.studentId) === studentId && bool_(r.active));
  if (!student || String(student.className) !== className) throw new Error('Siswa tidak ditemukan pada kelas yang dipilih.');
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const sheet = ss.getSheetByName(ATTENDANCE_SHEET);
    const found = readRowsWithIndex_(sheet, ATTENDANCE_HEADERS).find(x => x.record.date === date && x.record.session === session && x.record.studentId === studentId && x.record.className === className);
    const now = new Date(); const iso = now.toISOString();
    const time = status === 'hadir' ? Utilities.formatDate(now, Session.getScriptTimeZone(), 'HH:mm:ss') : '';
    if (found) {
      const r = found.record;
      const scannedAt = r.scannedAt || (status === 'hadir' ? 'MANUAL:' + iso : '');
      const value = [r.recordId, date, session, studentId, student.name, className, status, time || (status === 'hadir' ? r.time : ''), notes, scannedAt, iso];
      sheet.getRange(found.rowNumber, 1, 1, ATTENDANCE_HEADERS.length).setValues([value]);
      return { updated: true, recordId: r.recordId, status: status };
    }
    const recordId = Utilities.getUuid();
    sheet.appendRow([recordId, date, session, studentId, student.name, className, status, time, notes, status === 'hadir' ? 'MANUAL:' + iso : '', iso]);
    return { updated: false, recordId: recordId, status: status };
  } finally { lock.releaseLock(); }
}

function updateAttendance_(ss, req) {
  const recordId = String(req.recordId || '').trim();
  if (!recordId) throw new Error('ID catatan absensi wajib diisi.');
  const status = normalizeStatus_(req.status);
  const notes = optionalText_(req.notes, 250);
  const sheet = ss.getSheetByName(ATTENDANCE_SHEET);
  const found = readRowsWithIndex_(sheet, ATTENDANCE_HEADERS).find(x => x.record.recordId === recordId);
  if (!found) throw new Error('Catatan absensi tidak ditemukan.');
  const r = found.record; const now = new Date().toISOString();
  const time = status === 'hadir' ? (r.time || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'HH:mm:ss')) : '';
  const scannedAt = status === 'hadir' ? (r.scannedAt || 'MANUAL:' + now) : r.scannedAt;
  sheet.getRange(found.rowNumber, 1, 1, ATTENDANCE_HEADERS.length).setValues([[r.recordId, r.date, r.session, r.studentId, r.name, r.className, status, time, notes, scannedAt, now]]);
  return { recordId: recordId, status: status };
}

function getReport_(ss, req) {
  const startDate = validDate_(req.startDate || today_());
  const endDate = validDate_(req.endDate || today_());
  if (startDate > endDate) throw new Error('Tanggal awal harus sama dengan atau sebelum tanggal akhir.');
  const className = String(req.className || '').trim();
  const records = readAttendance_(ss).map(x => x.record).filter(r => r.date >= startDate && r.date <= endDate && (!className || r.className === className));
  records.sort((a,b) => b.date.localeCompare(a.date) || a.className.localeCompare(b.className) || a.name.localeCompare(b.name));
  return { startDate: startDate, endDate: endDate, records: records };
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.getRange(1,1,1,headers.length).setValues([headers]);
  else {
    const actual = sheet.getRange(1,1,1,Math.max(sheet.getLastColumn(), headers.length)).getValues()[0].slice(0,headers.length).map(String);
    if (actual.join('|') !== headers.join('|')) throw new Error('Header sheet ' + name + ' tidak sesuai template. Jangan mengubah nama atau urutan kolom.');
  }
  sheet.setFrozenRows(1);
  sheet.getRange(1,1,1,headers.length).setBackground('#176b5b').setFontColor('#ffffff').setFontWeight('bold').setWrap(true);
  sheet.setRowHeight(1, 30);
  headers.forEach((h,i)=>sheet.setColumnWidth(i+1, Math.min(210, Math.max(100, h.length*11))));
  return sheet;
}
function readRows_(sheet, headers) { return readRowsWithIndex_(sheet, headers).map(x=>x.record); }
function readRowsWithIndex_(sheet, headers) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const vals = sheet.getRange(2,1,sheet.getLastRow()-1,headers.length).getValues();
  return vals.map((row,index)=>{
    const record={}; headers.forEach((h,i)=>record[h]=row[i]);
    if (record.date !== undefined) record.date = dateString_(record.date);
    if (record.time instanceof Date) record.time = Utilities.formatDate(record.time, Session.getScriptTimeZone(), 'HH:mm:ss');
    if (record.status !== undefined) record.status = String(record.status || '').toLowerCase();
    return {record:record,rowNumber:index+2};
  });
}
function readAttendance_(ss) {
  return readRowsWithIndex_(ss.getSheetByName(ATTENDANCE_SHEET), ATTENDANCE_HEADERS).map(x=>{
    const r=x.record;
    r.recordId=String(r.recordId||'');r.date=dateString_(r.date);r.session=String(r.session||'');r.studentId=String(r.studentId||'');r.name=String(r.name||'');r.className=String(r.className||'');r.status=String(r.status||'').toLowerCase();r.time=r.time?String(r.time):'';r.notes=String(r.notes||'');r.scannedAt=String(r.scannedAt||'');r.updatedAt=String(r.updatedAt||'');
    return {record:r,rowNumber:x.rowNumber};
  });
}
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function today_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
function dateString_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const s=String(value||'').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
  return s;
}
function validDate_(value) { const s=String(value||''); if(!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Format tanggal harus YYYY-MM-DD.'); const d=new Date(s+'T00:00:00Z'); if(isNaN(d.getTime())||d.toISOString().slice(0,10)!==s) throw new Error('Tanggal tidak valid.'); return s; }
function clean_(value,max,label) { const s=String(value==null?'':value).trim(); if(!s) throw new Error(label+' wajib diisi.'); if(s.length>max) throw new Error(label+' terlalu panjang.'); return s; }
function optionalText_(value,max) { const s=String(value==null?'':value).trim(); if(s.length>max) throw new Error('Catatan terlalu panjang.'); return s; }
function normalizeStatus_(status) { const s=String(status||'').trim().toLowerCase(); if(ALLOWED_STATUSES.indexOf(s)<0) throw new Error('Status harus Hadir, Izin, Sakit, atau Alpa.'); return s; }
function bool_(value) { return value===true || String(value).toLowerCase()==='true' || String(value)==='1'; }
function unique_(values) { return Array.from(new Set(values.map(v=>String(v||'').trim()).filter(Boolean))); }
function constantTimeEqual_(a,b) { if(a.length!==b.length) return false; let diff=0; for(let i=0;i<a.length;i++) diff|=a.charCodeAt(i)^b.charCodeAt(i); return diff===0; }
