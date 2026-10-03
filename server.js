const express = require("express"), compression = require("compression"), path = require("path");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
app.set("trust proxy", 1);
app.use(compression());
app.use(express.json({ limit: "600kb" }));

const SECRET = process.env.JWT_SECRET;
const ADMIN = (process.env.ADMIN_EMAIL || "").toLowerCase();
const gclient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 20 });
let books, users, cache = { at: 0, data: "[]" };
const s = (v, m) => String(v || "").trim().slice(0, m);

// Simple rate limit per IP + route (resets every hour)
const hits = new Map();
setInterval(() => hits.clear(), 36e5).unref();
const limit = max => (req, res, next) => {
  const k = req.ip + req.path, n = (hits.get(k) || 0) + 1;
  hits.set(k, n);
  n > max ? res.status(429).json({ error: "Too many tries. Please try later." }) : next();
};

const token = u => jwt.sign({ id: String(u._id), email: u.email }, SECRET, { expiresIn: "30d" });
const session = u => ({ token: token(u), email: u.email, admin: u.email === ADMIN });
const auth = (req, res, next) => {
  try {
    const u = jwt.verify((req.headers.authorization || "").slice(7), SECRET);
    req.user = { id: u.id, email: u.email, admin: u.email === ADMIN };
    next();
  } catch (e) { res.status(401).json({ error: "Please log in." }); }
};

const pub = (b, priv) => ({
  id: String(b._id), t: b.t, a: b.a, c: b.c, city: b.city, pin: b.pin, mode: b.mode, p: b.p, w: b.w,
  img: b.hasImg ? `/api/books/${b._id}/img?v=${b.updatedAt.getTime()}` : "",
  ...(priv ? { name: b.name, address: b.address, owner: b.ownerEmail } : {})
});

async function refreshCache() {
  const list = await books.find({}, { projection: { img: 0 } }).sort({ createdAt: -1 }).limit(200).toArray();
  cache = { at: Date.now(), data: JSON.stringify(list.map(b => pub(b))) };
}

function parse(b) {
  const t = s(b.t, 120), name = s(b.name, 60), pin = s(b.pin, 6), address = s(b.address, 300);
  const phone = s(b.phone, 15).replace(/\D/g, "").slice(-10);
  const err = !t ? "Enter the book title." : !name ? "Enter your name."
    : !/^[6-9]\d{9}$/.test(phone) ? "Enter a valid 10-digit phone number."
    : !/^\d{6}$/.test(pin) ? "Enter a valid 6-digit PIN code."
    : address.length < 10 ? "Enter your full address." : "";
  const mode = b.mode === "free" ? "free" : "sale";
  let img = null;
  if (typeof b.img === "string" && b.img.startsWith("data:image/jpeg;base64,")) {
    const buf = Buffer.from(b.img.split(",")[1], "base64");
    if (buf.length <= 400000) img = buf;
  }
  return { err, img, doc: { t, a: s(b.a, 80), c: s(b.c, 20), city: s(b.city, 60) || "-", pin, mode,
    p: mode === "free" ? 0 : Math.max(0, Number(b.p) || 0), w: "91" + phone, name, address } };
}

// ---- Google sign-in (the only way to log in) ----
app.get("/api/config", (req, res) => res.json({ clientId: process.env.GOOGLE_CLIENT_ID || "" }));

app.post("/api/google", limit(40), async (req, res) => {
  try {
    const t = await gclient.verifyIdToken({ idToken: String(req.body.credential || ""), audience: process.env.GOOGLE_CLIENT_ID });
    const p = t.getPayload();
    if (!p.email || !p.email_verified) return res.status(400).json({ error: "Your Google email is not verified." });
    const email = p.email.toLowerCase();
    const u = await users.findOneAndUpdate({ email },
      { $set: { name: p.name || "", lastLogin: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true, returnDocument: "after" });
    res.json(session(u));
  } catch (e) { res.status(400).json({ error: "Google sign-in failed. Please try again." }); }
});

// ---- Books ----
app.get("/api/books", async (req, res) => {
  try {
    if (Date.now() - cache.at > 10000) await refreshCache();
    res.set("Cache-Control", "public, max-age=10").type("json").send(cache.data);
  } catch (e) { res.status(500).json({ error: "Could not load books" }); }
});

app.get("/api/books/:id/img", async (req, res) => {
  try {
    const b = await books.findOne({ _id: new ObjectId(req.params.id) }, { projection: { img: 1 } });
    if (!b || !b.img) return res.sendStatus(404);
    res.set("Cache-Control", "public, max-age=86400").type("jpeg").send(b.img.buffer);
  } catch (e) { res.sendStatus(404); }
});

// Logged-in user's own posts (admin gets ALL posts), with private details
app.get("/api/mine", auth, async (req, res) => {
  const list = await books.find(req.user.admin ? {} : { userId: req.user.id }, { projection: { img: 0 } })
    .sort({ createdAt: -1 }).limit(500).toArray();
  res.json(list.map(b => pub(b, true)));
});

app.post("/api/books", auth, limit(20), async (req, res) => {
  try {
    const { err, doc, img } = parse(req.body);
    if (err) return res.status(400).json({ error: err });
    const now = new Date();
    await books.insertOne({ ...doc, userId: req.user.id, ownerEmail: req.user.email, hasImg: !!img, ...(img ? { img } : {}), createdAt: now, updatedAt: now });
    cache.at = 0;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Could not save book" }); }
});

async function ownBook(req, res) {
  try {
    const b = await books.findOne({ _id: new ObjectId(req.params.id) }, { projection: { img: 0 } });
    if (!b) { res.status(404).json({ error: "Book not found." }); return null; }
    if (!req.user.admin && b.userId !== req.user.id) { res.status(403).json({ error: "This is not your post." }); return null; }
    return b;
  } catch (e) { res.status(404).json({ error: "Book not found." }); return null; }
}

app.put("/api/books/:id", auth, async (req, res) => {
  try {
    const b = await ownBook(req, res); if (!b) return;
    const { err, doc, img } = parse(req.body);
    if (err) return res.status(400).json({ error: err });
    const set = { ...doc, updatedAt: new Date() }, op = { $set: set };
    if (img) { set.img = img; set.hasImg = true; }
    else if (req.body.removeImg) { set.hasImg = false; op.$unset = { img: "" }; }
    await books.updateOne({ _id: b._id }, op);
    cache.at = 0;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Could not update book" }); }
});

app.delete("/api/books/:id", auth, async (req, res) => {
  try {
    const b = await ownBook(req, res); if (!b) return;
    await books.deleteOne({ _id: b._id });
    cache.at = 0;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Could not delete book" }); }
});

app.get("/", (req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.sendFile(path.join(__dirname, "index.html"));
});

if (!SECRET || !process.env.MONGODB_URI || !process.env.GOOGLE_CLIENT_ID) { console.error("Missing JWT_SECRET, MONGODB_URI or GOOGLE_CLIENT_ID"); process.exit(1); }
client.connect().then(async () => {
  const db = client.db("passthebook");
  books = db.collection("books"); users = db.collection("users");
  await users.createIndex({ email: 1 }, { unique: true });
  await books.createIndex({ createdAt: -1 });
  await refreshCache();
  app.listen(process.env.PORT || 3000, () => console.log("Server running"));
}).catch(err => { console.error("MongoDB connection failed", err.message); process.exit(1); });
