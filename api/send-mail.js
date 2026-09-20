// Dursunoğlu Emlak CRM — e-posta gönderimi (Vercel Serverless Function)
//
// Gerekli ortam değişkenleri (Vercel > Settings > Environment Variables):
//   RESEND_API_KEY  : Resend panelinden aldığınız anahtar (re_ ile başlar)
//   ADMIN_EMAIL     : Yeni üye bildirimlerinin gideceği adres
// İsteğe bağlı:
//   MAIL_FROM       : Gönderen adres. Alan adınızı Resend'de doğruladıysanız
//                     ör. "Dursunoğlu CRM <bildirim@dursunogluinsaat.com.tr>"
//                     Doğrulamadıysanız boş bırakın: onboarding@resend.dev kullanılır
//                     (bu durumda Resend yalnızca kendi hesap adresinize gönderir).
//   ALLOWED_ORIGINS : Virgülle ayrılmış izinli site adresleri
//                     (varsayılan: https://crm.dursunogluinsaat.com.tr)

const DEFAULT_ORIGINS = ['https://crm.dursunogluinsaat.com.tr'];

// Basit hız sınırı (sunucusuz ortamda "en iyi çaba" düzeyinde çalışır)
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const max = 20;
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  return list.length > max;
}

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .slice(0, 500);

const isEmail = (s) => typeof s === 'string' && /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(s) && s.length <= 254;

function layout(title, lines) {
  const body = lines.map((l) => `<p style="margin:6px 0">${l}</p>`).join('');
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1a1a1a;max-width:560px">
    <div style="background:#1A5276;color:#fff;padding:12px 16px;border-radius:8px 8px 0 0;font-weight:700">${esc(title)}</div>
    <div style="border:1px solid #D4E6F1;border-top:none;padding:14px 16px;border-radius:0 0 8px 8px">${body}
    <p style="margin-top:16px;color:#888;font-size:12px">Dursunoğlu Emlak CRM</p></div></div>`;
}

// Yalnızca sabit şablonlar: istemci serbest metin/HTML gönderemez.
function buildMail(type, d, adminEmail) {
  if (type === 'new_member') {
    return {
      to: adminEmail,
      subject: `Emlak CRM - Yeni Üye Onay Talebi: ${d.ad || ''} ${d.soyad || ''}`.trim(),
      html: layout('Yeni üyelik başvurusu', [
        `<b>Ad Soyad:</b> ${esc(d.ad)} ${esc(d.soyad)}`,
        `<b>Kullanıcı adı:</b> ${esc(d.username)}`,
        `<b>E-posta:</b> ${esc(d.email)}`,
        `<b>Rol:</b> ${d.role === 'admin' ? 'Yönetici' : 'Broker'}`,
        `<b>Kayıt tarihi:</b> ${esc(d.tarih)}`,
        'Sisteme giriş yaparak Üyeler panelinden bu başvuruyu onaylayabilirsiniz.',
      ]),
    };
  }
  if (type === 'member_approved') {
    if (!isEmail(d.email)) return null;
    return {
      to: d.email,
      subject: 'Emlak CRM - Hesabınız Onaylandı',
      html: layout('Hesabınız onaylandı', [
        `Merhaba ${esc(d.ad)} ${esc(d.soyad)},`,
        'Emlak CRM hesabınız onaylanmıştır. Artık sisteme giriş yapabilirsiniz.',
        `<b>Kullanıcı adı:</b> ${esc(d.username)}`,
      ]),
    };
  }
  if (type === 'appointment') {
    if (!isEmail(d.email)) return null;
    return {
      to: d.email,
      subject: `Randevu Hatırlatıcısı: ${d.musteri || ''} - ${d.konu || ''}`.slice(0, 200),
      html: layout('Randevu hatırlatıcısı', [
        'Merhaba, randevunuz yaklaşıyor:',
        `<b>Müşteri:</b> ${esc(d.musteri)}`,
        `<b>Tarih:</b> ${esc(d.tarih)}`,
        `<b>Saat:</b> ${esc(d.saat)}`,
        `<b>Konu:</b> ${esc(d.konu)}`,
        d.tel ? `<b>Telefon:</b> ${esc(d.tel)}` : '',
        d.not ? `<b>Not:</b> ${esc(d.not)}` : '',
      ].filter(Boolean)),
    };
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const allowed = (process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = req.headers.origin || '';
  const originOk = allowed.includes(origin) || /^https:\/\/[a-z0-9-]+-dursunoglu\.vercel\.app$/i.test(origin);
  if (!originOk) return res.status(403).json({ ok: false, error: 'forbidden_origin' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) return res.status(429).json({ ok: false, error: 'too_many_requests' });

  const apiKey = process.env.RESEND_API_KEY;
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!apiKey || !adminEmail) {
    return res.status(500).json({ ok: false, error: 'not_configured' });
  }

  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (e) { payload = null; }
  }
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ ok: false, error: 'bad_request' });
  }

  const mail = buildMail(payload.type, payload.data || {}, adminEmail);
  if (!mail) return res.status(400).json({ ok: false, error: 'invalid_type_or_recipient' });

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || 'Dursunoğlu CRM <onboarding@resend.dev>',
        to: [mail.to],
        subject: mail.subject,
        html: mail.html,
      }),
    });
    if (!r.ok) {
      const detail = await r.text();
      console.error('Resend error', r.status, detail.slice(0, 300));
      return res.status(502).json({ ok: false, error: 'provider_error', status: r.status });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('send-mail failure', e && e.message);
    return res.status(502).json({ ok: false, error: 'network_error' });
  }
};
