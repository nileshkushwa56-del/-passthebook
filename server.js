const express = require("express");
const compression = require("compression");
const path = require("path");
const { MongoClient } = require("mongodb");

const app = express();
app.set("trust proxy", 1);
app.use(compression());
app.use(express.json({ limit: "20kb" }));

const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 20 });
let col;

// --- Cache: the book list is read from MongoDB at most once every 10 seconds ---
let cache = { at: 0, data: "[]" };
async function refreshCache() {
  const books = await col.find({}, { projection: { address: 0, name: 0 } })
    .sort({ createdAt: -1 }).limit(200).toArray();
  cache = {
    at: Date.now(),
    data: JSON.stringify(books.map(b => ({ id: b._id.toString(), t: b.t, a: b.a, c: b.c, city: b.city, pin: b.pin, mode: b.mode, p: b.p, w: b.w })))
  };
}

// --- Simple rate limit for posting: 5 posts per hour per IP ---
const hits = new Map();
setInterval(() => hits.clear(), 60 * 60 * 1000).unref();

app.get("/api/books", async (req, res) => {
  try {
    if (Date.now() - cache.at > 10000) await refreshCache();
    res.set("Cache-Control", "public, max-age=10").type("json").send(cache.data);
  } catch (e) { res.status(500).json({ error: "Could not load books" }); }
});

app.post("/api/books", async (req, res) => {
  try {
    const n = (hits.get(req.ip) || 0) + 1;
    hits.set(req.ip, n);
    if (n > 5) return res.status(429).json({ error: "Too many posts. Please try again later." });

    const s = (v, m) => String(v || "").trim().slice(0, m);
    const t = s(req.body.t, 120);
    const phone = s(req.body.phone, 15).replace(/\D/g, "").slice(-10);
    const pin = s(req.body.pin, 6);
    const address = s(req.body.address, 300);
    const name = s(req.body.name, 60);
    if (!t) return res.status(400).json({ error: "Enter the book title." });
    if (!name) return res.status(400).json({ error: "Enter your name." });
    if (!/^[6-9]\d{9}$/.test(phone)) return res.status(400).json({ error: "Enter a valid 10-digit phone number." });
    if (!/^\d{6}$/.test(pin)) return res.status(400).json({ error: "Enter a valid 6-digit PIN code." });
    if (address.length < 10) return res.status(400).json({ error: "Enter your full address." });

    const mode = req.body.mode === "free" ? "free" : "sale";
    await col.insertOne({
      t, a: s(req.body.a, 80), c: s(req.body.c, 20), city: s(req.body.city, 60) || "-", pin,
      mode, p: mode === "free" ? 0 : Math.max(0, Number(req.body.p) || 0),
      w: "91" + phone, name, address, createdAt: new Date()
    });
    cache.at = 0;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Could not save book" }); }
});

app.get("/", (req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.sendFile(path.join(__dirname, "index.html"));
});

client.connect().then(async () => {
  col = client.db("passthebook").collection("books");
  await col.createIndex({ createdAt: -1 });
  await refreshCache();
  app.listen(process.env.PORT || 3000, () => console.log("Server running"));
}).catch(err => { console.error("MongoDB connection failed", err.message); process.exit(1); });
