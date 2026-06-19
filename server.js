const express = require('express');
const path = require('path');
const sqlite3 = require('better-sqlite3');
const fs = require('fs');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ===== SQLite Setup =====
const dbDir = path.join(__dirname, 'data');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new sqlite3(path.join(dbDir, 'app.db'));
db.pragma('journal_mode = WAL');

// ===== Schema (tek işletme) =====
db.exec(`
  CREATE TABLE IF NOT EXISTS barbers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    photo TEXT DEFAULT '',
    description TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    duration INTEGER NOT NULL DEFAULT 30,
    price INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barber_id INTEGER,
    service_id INTEGER NOT NULL,
    customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    duration INTEGER NOT NULL DEFAULT 30,
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (barber_id) REFERENCES barbers(id) ON DELETE SET NULL,
    FOREIGN KEY (service_id) REFERENCES services(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS barber_off_days (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barber_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    start_time TEXT DEFAULT '',
    end_time TEXT DEFAULT '',
    reason TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (barber_id) REFERENCES barbers(id) ON DELETE CASCADE
  );
`);

// ===== Seed default data =====
const barberCount = db.prepare('SELECT COUNT(*) as c FROM barbers').get().c;
if (barberCount === 0) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('work_start', '09:00');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('work_end', '19:00');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('break_start', '13:00');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('break_end', '14:00');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('slot_interval', '30');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('work_days', '1,2,3,4,5,6');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('admin_password', 'admin123');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('business_name', 'Berber Ahmet');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('business_title', 'Berber Ahmet');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('business_description', 'Profesyonel erkek kuaförü');

  db.prepare('INSERT INTO services (name, duration, price) VALUES (?, ?, ?)').run('Saç Kesimi', 30, 200);
  db.prepare('INSERT INTO services (name, duration, price) VALUES (?, ?, ?)').run('Sakal Kesimi', 20, 100);
  db.prepare('INSERT INTO services (name, duration, price) VALUES (?, ?, ?)').run('Saç + Sakal', 40, 250);
  db.prepare('INSERT INTO services (name, duration, price) VALUES (?, ?, ?)').run('Yıkama + Kesim', 45, 300);

  db.prepare('INSERT INTO barbers (name, description) VALUES (?, ?)').run('Ahmet Usta', 'Usta berber, 15 yıllık tecrübe');
  db.prepare('INSERT INTO barbers (name, description) VALUES (?, ?)').run('Mehmet Usta', 'Klasik ve modern kesim');
  db.prepare('INSERT INTO barbers (name, description) VALUES (?, ?)').run('Ali Usta', 'Sakal ve özel stil');
}

// ===== Helpers =====
function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  rows.forEach(r => s[r.key] = r.value);
  return s;
}

function parseTime(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function formatTime(m) {
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function getWorkDaysSet(s) {
  return new Set((s.work_days || '1,2,3,4,5,6').split(',').map(Number));
}

function generateSlots(barberId, date) {
  const s = getSettings();
  const weekDay = new Date(date + 'T12:00:00').getDay();
  const workDays = getWorkDaysSet(s);
  if (!workDays.has(weekDay)) return [];

  const startMin = parseTime(s.work_start || '09:00');
  const endMin = parseTime(s.work_end || '19:00');
  const breakStart = s.break_start ? parseTime(s.break_start) : null;
  const breakEnd = s.break_end ? parseTime(s.break_end) : null;
  const interval = parseInt(s.slot_interval || '30');

  // Check off days for this barber on this date
  const offDays = db.prepare(
    `SELECT start_time, end_time FROM barber_off_days WHERE barber_id = ? AND date = ?`
  ).all(barberId, date);

  // Full day off
  const fullDayOff = offDays.some(o => !o.start_time && !o.end_time);
  if (fullDayOff) return [];

  const taken = db.prepare(
    `SELECT time, duration FROM appointments WHERE barber_id = ? AND date = ? AND status != 'canceled'`
  ).all(barberId, date);

  const slots = [];
  for (let m = startMin; m + interval <= endMin; m += interval) {
    if (breakStart !== null && breakEnd !== null) {
      if ((m >= breakStart && m < breakEnd) || (m + interval > breakStart && m + interval <= breakEnd)) continue;
    }
    // Check partial off hours
    let isOff = false;
    for (const o of offDays) {
      if (o.start_time && o.end_time) {
        const offStart = parseTime(o.start_time);
        const offEnd = parseTime(o.end_time);
        if (m >= offStart && m < offEnd) { isOff = true; break; }
      }
    }
    if (isOff) continue;
    const slotStart = m;
    const slotEnd = m + interval;
    let isTaken = false;
    for (const t of taken) {
      const tStart = parseTime(t.time);
      const tEnd = tStart + t.duration;
      if (slotStart < tEnd && slotEnd > tStart) { isTaken = true; break; }
    }
    if (!isTaken) slots.push(formatTime(m));
  }
  return slots;
}

// ===== API Routes =====

// Settings
app.get('/api/settings', (req, res) => {
  res.json(getSettings());
});

app.put('/api/settings', (req, res) => {
  const allowed = ['work_start', 'work_end', 'break_start', 'break_end', 'slot_interval', 'work_days',
    'business_name', 'business_title', 'business_description'];
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      upsert.run(key, String(req.body[key]));
    }
  }
  res.json({ ok: true });
});

// Admin auth
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const s = getSettings();
  if (password === s.admin_password) {
    return res.json({ token: 'admin-token' });
  }
  res.status(401).json({ error: 'Hatalı şifre' });
});

app.post('/api/admin/change-password', (req, res) => {
  const { current_password, new_password } = req.body;
  const s = getSettings();
  if (current_password !== s.admin_password) return res.status(401).json({ error: 'Mevcut şifre hatalı' });
  if (!new_password || new_password.length < 3) return res.status(400).json({ error: 'Yeni şifre çok kısa' });
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(new_password, 'admin_password');
  res.json({ ok: true });
});

// Barbers
app.get('/api/barbers', (req, res) => {
  const barbers = db.prepare('SELECT * FROM barbers WHERE is_active = 1 ORDER BY name').all();
  res.json(barbers);
});

app.get('/api/barbers/all', (req, res) => {
  const barbers = db.prepare('SELECT * FROM barbers ORDER BY name').all();
  res.json(barbers);
});

app.post('/api/barbers', (req, res) => {
  const { name, photo, description } = req.body;
  if (!name) return res.status(400).json({ error: 'İsim gerekli' });
  const r = db.prepare('INSERT INTO barbers (name, photo, description) VALUES (?, ?, ?)').run(name, photo || '', description || '');
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/barbers/:id', (req, res) => {
  const { name, photo, description, is_active } = req.body;
  const old = db.prepare('SELECT * FROM barbers WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: 'Usta bulunamadı' });
  db.prepare('UPDATE barbers SET name=?, photo=?, description=?, is_active=? WHERE id=?').run(
    name !== undefined ? name : old.name,
    photo !== undefined ? photo : old.photo,
    description !== undefined ? description : old.description,
    is_active !== undefined ? (is_active ? 1 : 0) : old.is_active,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/barbers/:id', (req, res) => {
  db.prepare('DELETE FROM barbers WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Services
app.get('/api/services', (req, res) => {
  const services = db.prepare('SELECT * FROM services WHERE is_active = 1 ORDER BY name').all();
  res.json(services);
});

app.get('/api/services/all', (req, res) => {
  const services = db.prepare('SELECT * FROM services ORDER BY name').all();
  res.json(services);
});

app.post('/api/services', (req, res) => {
  const { name, duration, price } = req.body;
  if (!name) return res.status(400).json({ error: 'İsim gerekli' });
  const r = db.prepare('INSERT INTO services (name, duration, price) VALUES (?, ?, ?)').run(name, duration || 30, price || 0);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/services/:id', (req, res) => {
  const { name, duration, price, is_active } = req.body;
  const existing = db.prepare('SELECT * FROM services WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Hizmet bulunamadı' });
  db.prepare('UPDATE services SET name=?, duration=?, price=?, is_active=? WHERE id=?').run(
    name !== undefined ? name : existing.name,
    duration !== undefined ? duration : existing.duration,
    price !== undefined ? price : existing.price,
    is_active !== undefined ? is_active : existing.is_active,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/services/:id', (req, res) => {
  db.prepare('DELETE FROM services WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Slots
app.get('/api/slots/:barberId/:date', (req, res) => {
  const slots = generateSlots(parseInt(req.params.barberId), req.params.date);
  res.json({ slots, date: req.params.date, barber_id: parseInt(req.params.barberId) });
});

// Appointments
app.post('/api/appointments', (req, res) => {
  const { barber_id, service_id, customer_name, customer_phone, date, time, note } = req.body;
  if (!barber_id || !service_id || !customer_name || !customer_phone || !date || !time) {
    return res.status(400).json({ error: 'Tüm alanlar gerekli' });
  }

  const service = db.prepare('SELECT duration FROM services WHERE id = ?').get(service_id);
  if (!service) return res.status(400).json({ error: 'Geçersiz hizmet' });

  const slotStart = parseTime(time);
  const slotEnd = slotStart + service.duration;
  const taken = db.prepare(
    `SELECT time, duration FROM appointments WHERE barber_id = ? AND date = ? AND status != 'canceled'`
  ).all(barber_id, date);
  for (const t of taken) {
    const tStart = parseTime(t.time);
    const tEnd = tStart + t.duration;
    if (slotStart < tEnd && slotEnd > tStart) {
      return res.status(409).json({ error: 'Bu saat zaten dolu' });
    }
  }

  const r = db.prepare(
    'INSERT INTO appointments (barber_id, service_id, customer_name, customer_phone, date, time, duration, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(barber_id, service_id, customer_name, customer_phone, date, time, service.duration, note || '');

  res.json({ id: r.lastInsertRowid, status: 'pending' });
});

// Appointment lookup by phone
app.get('/api/appointments/phone/:phone', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, b.name as barber_name, s.name as service_name, s.price as service_price
    FROM appointments a
    JOIN barbers b ON a.barber_id = b.id
    JOIN services s ON a.service_id = s.id
    WHERE a.customer_phone = ?
    ORDER BY a.date DESC, a.time DESC
  `).all(req.params.phone);
  res.json({ appointments: rows });
});

// Alias for frontend by-phone calls
app.get('/api/appointments/by-phone/:phone', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, b.name as barber_name, s.name as service_name, s.price as service_price
    FROM appointments a
    JOIN barbers b ON a.barber_id = b.id
    JOIN services s ON a.service_id = s.id
    WHERE a.customer_phone = ?
    ORDER BY a.date DESC, a.time DESC
  `).all(req.params.phone);
  res.json({ appointments: rows });
});

// Admin: appointments list
app.get('/api/appointments/admin', (req, res) => {
  const { date, status, barber_id } = req.query;
  let sql = `SELECT a.*, b.name as barber_name, s.name as service_name, s.price as service_price
             FROM appointments a
             JOIN barbers b ON a.barber_id = b.id
             JOIN services s ON a.service_id = s.id
             WHERE 1=1`;
  const params = [];
  if (date) { sql += ' AND a.date = ?'; params.push(date); }
  if (status) { sql += ' AND a.status = ?'; params.push(status); }
  if (barber_id) { sql += ' AND a.barber_id = ?'; params.push(parseInt(barber_id)); }
  sql += ' ORDER BY a.date DESC, a.time ASC';
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// Müşteri: ustadan randevuları sorgula
app.get('/api/appointments/by-barber/:barberId', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, b.name as barber_name, s.name as service_name, s.price as service_price
    FROM appointments a
    JOIN barbers b ON a.barber_id = b.id
    JOIN services s ON a.service_id = s.id
    WHERE a.barber_id = ?
    ORDER BY a.date DESC, a.time ASC
  `).all(parseInt(req.params.barberId));
  res.json({ appointments: rows });
});

// Update appointment status
app.put('/api/appointments/:id/status', (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

// Delete appointment
app.delete('/api/appointments/:id', (req, res) => {
  db.prepare('DELETE FROM appointments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ===== Barber Off Days =====
// List off days for a barber
app.get('/api/barbers/:barberId/off-days', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM barber_off_days WHERE barber_id = ? ORDER BY date DESC, start_time ASC'
  ).all(parseInt(req.params.barberId));
  res.json(rows);
});

// Add off day
app.post('/api/barbers/:barberId/off-days', (req, res) => {
  const { date, start_time, end_time, reason } = req.body;
  if (!date) return res.status(400).json({ error: 'Tarih gerekli' });
  db.prepare(
    'INSERT INTO barber_off_days (barber_id, date, start_time, end_time, reason) VALUES (?, ?, ?, ?, ?)'
  ).run(parseInt(req.params.barberId), date, start_time || '', end_time || '', reason || '');
  res.json({ ok: true });
});

// Delete off day
app.delete('/api/off-days/:id', (req, res) => {
  db.prepare('DELETE FROM barber_off_days WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Stats
app.get('/api/stats', (req, res) => {
  const s = getSettings();
  const today = new Date().toISOString().split('T')[0];
  const totalAppointments = db.prepare('SELECT COUNT(*) as c FROM appointments').get().c;
  const todayAppointments = db.prepare('SELECT COUNT(*) as c FROM appointments WHERE date = ?').get(today).c;
  const pendingCount = db.prepare('SELECT COUNT(*) as c FROM appointments WHERE status = ?').get('pending').c;
  const activeBarbers = db.prepare('SELECT COUNT(*) as c FROM barbers WHERE is_active = 1').get().c;
  const activeServices = db.prepare('SELECT COUNT(*) as c FROM services WHERE is_active = 1').get().c;
  res.json({
    business_name: s.business_name,
    totalAppointments,
    todayAppointments,
    pendingCount,
    activeBarbers,
    activeServices
  });
});

// ===== Static Files =====
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback for /admin
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ===== Start =====
app.listen(PORT, () => {
  console.log(`✅ Berber Randevu Sistemi çalışıyor → http://localhost:${PORT}`);
  console.log(`📅 Müşteri sayfası: http://localhost:${PORT}/`);
  console.log(`🔧 Admin paneli: http://localhost:${PORT}/admin`);
});
