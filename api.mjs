/**
 * HadirKelas API — mode tanpa PIN.
 * Catatan keamanan: endpoint aplikasi dapat dipakai siapa pun yang mengetahui URL situs.
 * Rahasia Google tetap disimpan hanya di environment variable Netlify dan Script Properties.
 */
const json = (statusCode, payload) => new Response(JSON.stringify(payload), {
  status: statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

export default async (request) => {
  if (request.method !== 'POST') return json(405, { ok: false, error: 'Metode tidak diizinkan.' });

  let body;
  try { body = await request.json(); }
  catch { return json(400, { ok: false, error: 'Format permintaan harus JSON.' }); }

  const action = String(body?.action || '');
  if (!action) return json(400, { ok: false, error: 'Aksi permintaan tidak disebutkan.' });

  const gasUrl = process.env.GAS_WEB_APP_URL || '';
  const sharedSecret = process.env.GAS_SHARED_SECRET || '';
  if (!gasUrl || !sharedSecret) {
    return json(503, { ok: false, error: 'Koneksi Google Spreadsheet belum dikonfigurasi. Isi GAS_WEB_APP_URL dan GAS_SHARED_SECRET pada Netlify.' });
  }
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec(?:\?.*)?$/.test(gasUrl)) {
    return json(500, { ok: false, error: 'GAS_WEB_APP_URL harus berupa URL deployment Apps Script yang berakhiran /exec.' });
  }

  // Jangan meneruskan rahasia yang dikirim browser; selalu gunakan nilai server-side.
  const forwarded = { ...body, secret: sharedSecret };
  delete forwarded.token;
  delete forwarded.pin;
  try {
    const upstream = await fetch(gasUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(forwarded),
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
    const raw = await upstream.text();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return json(502, { ok: false, error: 'Google Apps Script tidak mengembalikan JSON. Periksa deployment web app dan izin aksesnya.' }); }
    if (!upstream.ok) return json(502, { ok: false, error: `Google Apps Script mengembalikan HTTP ${upstream.status}.` });
    return json(parsed.ok === false ? 400 : 200, parsed);
  } catch (error) {
    return json(502, { ok: false, error: `Tidak dapat menghubungi Google Apps Script: ${error?.message || 'koneksi gagal'}.` });
  }
};
