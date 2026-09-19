const crypto = require('node:crypto');
const { MongoClient } = require('mongodb');

const WORKSPACE_ID = 'main-workspace';
const MEMBER_COLLECTION = 'crm_members';
const STATE_COLLECTION = 'crm_state';
const ALLOWED_STATE_FIELDS = [
  'portfolios', 'appointments', 'customers', 'contracts', 'advisors',
  'talepkayitlari', 'notifications', 'usefulLinks', 'sysSettings',
  'systemLogo', 'valuations', 'comparables'
];

let cachedClient;
let cachedDb;

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CRM-Token');
}

function safeMember(member) {
  if (!member) return null;
  const { pass, passwordHash, salt, ...safe } = member;
  return safe;
}

function normalize(value) {
  return String(value || '').trim().toLocaleLowerCase('tr-TR');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return {
    salt,
    passwordHash: crypto.scryptSync(String(password), salt, 64).toString('hex')
  };
}

function verifyPassword(password, member) {
  if (!member?.passwordHash || !member?.salt) return false;
  const candidate = crypto.scryptSync(String(password), member.salt, 64);
  const expected = Buffer.from(member.passwordHash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function issueToken(member) {
  return crypto.createHmac('sha256', process.env.CRM_SESSION_SECRET || process.env.MONGODB_URI || 'crm-development-secret')
    .update(`${member._id}:${member.usernameLower}:${member.passwordHash}`)
    .digest('hex');
}

function tokenMatches(member, token) {
  return Boolean(token && member && token === issueToken(member));
}

async function getDb() {
  if (!process.env.MONGODB_URI) {
    const error = new Error('MONGODB_URI is not configured');
    error.code = 'CONFIGURATION_ERROR';
    throw error;
  }
  if (cachedDb) return cachedDb;
  cachedClient = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
    family: 4,
    tls: true
  });
  await cachedClient.connect();
  cachedDb = cachedClient.db(process.env.MONGODB_DB || undefined);
  await Promise.all([
    cachedDb.collection(MEMBER_COLLECTION).createIndex({ usernameLower: 1 }, { unique: true }),
    cachedDb.collection(MEMBER_COLLECTION).createIndex({ emailLower: 1 }, { unique: true })
  ]);
  return cachedDb;
}

function connectionError(res, error) {
  console.error('[crm] MongoDB connection failure:', error?.code || error?.name || 'unknown');
  return json(res, 503, { error: 'CRM bulut bağlantısı kurulamadı. Vercel MONGODB_URI ve Atlas erişimini kontrol edin.' });
}

async function requireMember(db, req) {
  const token = req.headers['x-crm-token'];
  if (!token) return null;
  const members = db.collection(MEMBER_COLLECTION);
  const all = await members.find({}).toArray();
  return all.find(member => tokenMatches(member, token)) || null;
}

function cleanState(body) {
  const source = body && typeof body === 'object' ? body : {};
  return Object.fromEntries(ALLOWED_STATE_FIELDS
    .filter(field => Object.prototype.hasOwnProperty.call(source, field))
    .map(field => [field, source[field]]));
}

async function ensureIndexesAndAdmin(db) {
  const members = db.collection(MEMBER_COLLECTION);
  const existing = await members.findOne({ usernameLower: 'admin' });
  if (existing) return;
  const password = process.env.CRM_ADMIN_PASSWORD;
  const email = process.env.CRM_ADMIN_EMAIL || 'admin@example.com';
  if (!password) return;
  const { salt, passwordHash } = hashPassword(password);
  await members.insertOne({
    _id: 'member-admin',
    id: 1,
    ad: process.env.CRM_ADMIN_FIRST_NAME || 'Yönetici',
    soyad: process.env.CRM_ADMIN_LAST_NAME || 'Admin',
    username: 'admin',
    usernameLower: 'admin',
    email,
    emailLower: normalize(email),
    tel: '',
    role: 'admin',
    emailVerified: true,
    approved: true,
    permissions: { canViewPortfolio: true, canViewAppointments: true, canViewCustomers: true, canViewAllCustomers: true },
    tarih: new Date().toLocaleDateString('tr-TR'),
    salt,
    passwordHash,
    createdAt: new Date()
  });
}

async function handleAuth(req, res, db) {
  const body = req.body || {};
  const members = db.collection(MEMBER_COLLECTION);

  if (body.action === 'login') {
    const identifier = normalize(body.username);
    const member = await members.findOne({ $or: [{ usernameLower: identifier }, { emailLower: identifier }] });
    if (!member || !verifyPassword(body.password, member)) return json(res, 401, { error: 'Kullanıcı adı/e-posta veya şifre hatalı.' });
    if (!member.emailVerified) return json(res, 403, { error: 'E-posta adresiniz henüz doğrulanmamış.' });
    if (!member.approved) return json(res, 403, { error: 'Hesabınız henüz yönetici onayı bekliyor.' });
    return json(res, 200, { member: safeMember(member), token: issueToken(member) });
  }

  if (body.action === 'register') {
    const incoming = body.member || {};
    const usernameLower = normalize(incoming.username);
    const emailLower = normalize(incoming.email);
    if (!incoming.ad || !incoming.soyad || !usernameLower || !emailLower || !incoming.pass) return json(res, 400, { error: 'Zorunlu üye alanları eksik.' });
    if (String(incoming.pass).length < 6) return json(res, 400, { error: 'Şifre en az 6 karakter olmalı.' });
    const duplicate = await members.findOne({ $or: [{ usernameLower }, { emailLower }] });
    if (duplicate) return json(res, 409, { error: 'Bu kullanıcı adı veya e-posta zaten kayıtlı.' });
    const { salt, passwordHash } = hashPassword(incoming.pass);
    const member = {
      _id: `member-${crypto.randomUUID()}`,
      id: Date.now(),
      ad: String(incoming.ad).trim(), soyad: String(incoming.soyad).trim(),
      username: String(incoming.username).trim(), usernameLower,
      email: String(incoming.email).trim(), emailLower,
      tel: String(incoming.tel || '').trim(), role: incoming.role === 'admin' ? 'agent' : (incoming.role || 'agent'),
      emailVerified: Boolean(incoming.emailVerified), approved: false,
      permissions: incoming.permissions || { canViewPortfolio: false, canViewAppointments: true, canViewCustomers: true, canViewAllCustomers: false },
      tarih: incoming.tarih || new Date().toLocaleDateString('tr-TR'), salt, passwordHash, createdAt: new Date()
    };
    try { await members.insertOne(member); } catch (error) {
      if (error.code === 11000) return json(res, 409, { error: 'Bu kullanıcı adı veya e-posta zaten kayıtlı.' });
      throw error;
    }
    return json(res, 201, { member: safeMember(member) });
  }

  if (body.action === 'migrate') {
    if (process.env.CRM_MIGRATION_TOKEN && body.migrationToken !== process.env.CRM_MIGRATION_TOKEN) return json(res, 403, { error: 'Migration yetkisi geçersiz.' });
    const incoming = Array.isArray(body.members) ? body.members : [];
    let migrated = 0;
    for (const item of incoming) {
      const usernameLower = normalize(item.username);
      const emailLower = normalize(item.email);
      if (!usernameLower || !emailLower || !item.pass) continue;
      const exists = await members.findOne({ $or: [{ usernameLower }, { emailLower }] });
      if (exists) continue;
      const { salt, passwordHash } = hashPassword(item.pass);
      const { pass, password, ...publicFields } = item;
      await members.insertOne({ ...publicFields, _id: `member-${crypto.randomUUID()}`, usernameLower, emailLower, salt, passwordHash });
      migrated += 1;
    }
    return json(res, 200, { migrated });
  }

  return json(res, 400, { error: 'Geçersiz auth action.' });
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const db = await getDb();
    await ensureIndexesAndAdmin(db);
    const resource = req.query?.resource;
    const members = db.collection(MEMBER_COLLECTION);

    if (resource === 'health' && req.method === 'GET') {
      return json(res, 200, { ok: true, service: 'crm', database: 'connected' });
    }

    if (resource === 'me' && req.method === 'GET') {
      const requester = await requireMember(db, req);
      if (!requester) return json(res, 401, { error: 'CRM oturumu geçersiz veya eksik.' });
      return json(res, 200, { member: safeMember(requester) });
    }

    if (resource === 'auth' && req.method === 'POST') return handleAuth(req, res, db);
    if (resource === 'members' && req.method === 'GET') {
      const requester = await requireMember(db, req);
      if (!requester || requester.role !== 'admin') return json(res, 401, { error: 'Üye listesi için yönetici yetkisi gerekir.' });
      return json(res, 200, (await members.find({}).toArray()).map(safeMember));
    }
    if (resource === 'members' && req.method === 'PUT') {
      const requester = await requireMember(db, req);
      if (!requester || requester.role !== 'admin') return json(res, 401, { error: 'Üye düzenleme için yönetici yetkisi gerekir.' });
      const incoming = Array.isArray(req.body?.members) ? req.body.members : [];
      for (const item of incoming) {
        if (!item.id) continue;
        const update = { ad: item.ad, soyad: item.soyad, tel: item.tel, role: item.role, approved: Boolean(item.approved), emailVerified: Boolean(item.emailVerified), permissions: item.permissions || {} };
        if (item.pass) Object.assign(update, hashPassword(item.pass));
        await members.updateOne({ id: item.id }, { $set: update });
      }
      return json(res, 200, { ok: true });
    }

    const requester = await requireMember(db, req);
    if (!requester) return json(res, 401, { error: 'CRM oturumu geçersiz veya eksik.' });
    const stateCollection = db.collection(STATE_COLLECTION);
    if (req.method === 'GET') {
      const state = await stateCollection.findOne({ _id: WORKSPACE_ID });
      return json(res, 200, state ? Object.fromEntries(ALLOWED_STATE_FIELDS.filter(field => field in state).map(field => [field, state[field]])) : {});
    }
    if (req.method === 'PUT') {
      const update = cleanState(req.body);
      await stateCollection.updateOne({ _id: WORKSPACE_ID }, { $set: { ...update, updatedAt: new Date(), updatedBy: requester.id } }, { upsert: true });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    return connectionError(res, error);
  }
};
