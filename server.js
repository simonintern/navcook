import express from 'express';
import * as cheerio from 'cheerio';
import { readdir, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import Datastore from '@seald-io/nedb';
import session from 'express-session';
import { Resend } from 'resend';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECIPES_DIR = path.join(__dirname, 'recipes');
const DB_PATH = path.join(__dirname, 'data', 'recipes.db');
const USERS_DB_PATH = path.join(__dirname, 'data', 'users.db');
const CODES_DB_PATH = path.join(__dirname, 'data', 'codes.db');

await mkdir(path.join(__dirname, 'data'), { recursive: true });

const db = new Datastore({ filename: DB_PATH, autoload: true });
db.ensureIndex({ fieldName: 'metadata.dateAdded' });

const usersDb = new Datastore({ filename: USERS_DB_PATH, autoload: true });
usersDb.ensureIndex({ fieldName: 'email', unique: true });
usersDb.ensureIndex({ fieldName: 'username', unique: true });

const codesDb = new Datastore({ filename: CODES_DB_PATH, autoload: true });

const SESSIONS_DB_PATH = path.join(__dirname, 'data', 'sessions.db');
const sessionsDb = new Datastore({ filename: SESSIONS_DB_PATH, autoload: true });

// Minimal express-session compatible store backed by NeDB
class NedbSessionStore extends session.Store {
  async get(sid, cb) {
    try {
      const doc = await sessionsDb.findOneAsync({ _id: sid });
      if (!doc || doc.expiresAt < Date.now()) return cb(null, null);
      cb(null, doc.session);
    } catch (e) { cb(e); }
  }
  async set(sid, sessionData, cb) {
    try {
      const expiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000;
      await sessionsDb.updateAsync({ _id: sid }, { $set: { _id: sid, session: sessionData, expiresAt } }, { upsert: true });
      cb(null);
    } catch (e) { cb(e); }
  }
  async destroy(sid, cb) {
    try { await sessionsDb.removeAsync({ _id: sid }); cb(null); } catch (e) { cb(e); }
  }
}

let _resend = null;
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

// Migrate existing flat JSON files into the DB on first run
async function migrate() {
  if (!existsSync(RECIPES_DIR)) return;
  const files = (await readdir(RECIPES_DIR)).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const alreadyImported = await db.findOneAsync({ 'metadata.migratedFrom': file });
    if (alreadyImported) continue;
    try {
      const raw = await readFile(path.join(RECIPES_DIR, file), 'utf8');
      const recipe = JSON.parse(raw);
      await db.insertAsync({
        recipe,
        metadata: {
          dateAdded: new Date(0).toISOString(),
          sourceUrl: recipe.sourceUrl || null,
          migratedFrom: file,
        },
      });
      console.log(`Migrated ${file}`);
    } catch (err) {
      console.warn(`Failed to migrate ${file}: ${err.message}`);
    }
  }
}

await migrate();

const BUILD = Date.now().toString(36);

const app = express();
app.use(express.json());
app.use(session({
  store: new NedbSessionStore(),
  secret: process.env.SESSION_SECRET || 'navcook-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 60 * 60 * 1000 },
}));

app.get('/sw.js', async (req, res) => {
  const raw = await readFile(path.join(__dirname, 'public', 'sw.js'), 'utf8');
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-store');
  res.send(raw.replace('__BUILD__', BUILD));
});

app.use(express.static('public'));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Login required' });
  next();
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function urlHash(url) {
  return createHash('sha1').update(url).digest('hex').slice(0, 8);
}

function extractRecipe(html, sourceUrl) {
  const $ = cheerio.load(html);
  let recipe = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    if (recipe) return;
    try {
      const data = JSON.parse($(el).text());
      const candidates = Array.isArray(data) ? data : [data['@graph'] ? data['@graph'] : data].flat();
      for (const item of candidates.flat()) {
        if (item?.['@type'] === 'Recipe' || (Array.isArray(item?.['@type']) && item['@type'].includes('Recipe'))) {
          recipe = item;
          break;
        }
      }
    } catch {
      // malformed JSON-LD block, skip
    }
  });

  if (!recipe) throw new Error('No Schema.org Recipe found on this page');

  recipe.sourceUrl = sourceUrl;

  delete recipe.aggregateRating;
  delete recipe.review;
  delete recipe.reviews;

  if (Array.isArray(recipe.recipeInstructions)) {
    const dedupeStepName = step => {
      if (step && typeof step === 'object' && step.name && step.text && step.name === step.text) {
        const { name, ...rest } = step;
        return rest;
      }
      return step;
    };
    recipe.recipeInstructions = recipe.recipeInstructions.map(step => {
      if (step && typeof step === 'object' && Array.isArray(step.itemListElement)) {
        return { ...step, itemListElement: step.itemListElement.map(dedupeStepName) };
      }
      return dedupeStepName(step);
    });
  }

  return recipe;
}

// ── Auth endpoints ────────────────────────────────────────────────────────────

app.post('/api/auth/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  await codesDb.updateAsync({ email }, { $set: { email, code, expiresAt } }, { upsert: true });
  console.log(`[auth] code for ${email}: ${code}`);

  const from = process.env.RESEND_FROM || 'NavCook <noreply@navcook.app>';
  console.log(`[auth] sending email via Resend — from: ${from}, to: ${email}`);

  try {
    const result = await getResend().emails.send({
      from,
      to: email,
      subject: `Your NavCook login code: ${code}`,
      text: `Your NavCook login code is ${code}.\n\nIt expires in 15 minutes. If you didn't request this, you can ignore it.`,
    });
    console.log(`[auth] Resend response:`, JSON.stringify(result));
  } catch (err) {
    console.error('[auth] Resend threw:', err);
    return res.status(502).json({ error: 'Failed to send email' });
  }

  const existingUser = await usersDb.findOneAsync({ email });
  res.json({ isNewUser: !existingUser });
});

app.post('/api/auth/verify-code', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code required' });

  const record = await codesDb.findOneAsync({ email });
  if (!record || record.code !== code) return res.status(401).json({ error: 'Invalid code' });
  if (new Date(record.expiresAt) < new Date()) return res.status(401).json({ error: 'Code expired' });

  const user = await usersDb.findOneAsync({ email });
  if (user) {
    req.session.userId = user._id;
    req.session.username = user.username;
    await codesDb.removeAsync({ email });
    return res.json({ username: user.username });
  }

  // New user — keep code alive so set-username can re-verify
  res.json({ needsUsername: true });
});

app.post('/api/auth/set-username', async (req, res) => {
  const { email, code, username } = req.body;
  if (!email || !code || !username) return res.status(400).json({ error: 'Email, code, and username required' });

  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–30 characters: letters, numbers, underscores only' });
  }

  const record = await codesDb.findOneAsync({ email });
  if (!record || record.code !== code) return res.status(401).json({ error: 'Invalid code' });
  if (new Date(record.expiresAt) < new Date()) return res.status(401).json({ error: 'Code expired' });

  const taken = await usersDb.findOneAsync({ username });
  if (taken) return res.status(409).json({ error: 'Username already taken' });

  const userCount = await usersDb.countAsync({});
  const newUser = await usersDb.insertAsync({ email, username, createdAt: new Date().toISOString() });

  if (userCount === 0) {
    await db.updateAsync({ ownerId: { $exists: false } }, { $set: { ownerId: newUser._id } }, { multi: true });
  }

  await codesDb.removeAsync({ email });
  req.session.userId = newUser._id;
  req.session.username = newUser.username;
  res.json({ username: newUser.username });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (req.session.userId) {
    res.json({ userId: req.session.userId, username: req.session.username });
  } else {
    res.json({ user: null });
  }
});

app.get('/api/auth/check-username', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'username required' });
  const taken = await usersDb.findOneAsync({ username });
  res.json({ available: !taken });
});

// ── Recipe endpoints ──────────────────────────────────────────────────────────

app.post('/api/import-json', requireAuth, async (req, res) => {
  const { json } = req.body;
  if (!json) return res.status(400).json({ error: 'json is required' });

  let recipe;
  try {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    const candidates = Array.isArray(parsed) ? parsed : [parsed['@graph'] ? parsed['@graph'] : parsed].flat();
    for (const item of candidates.flat()) {
      if (item?.['@type'] === 'Recipe' || (Array.isArray(item?.['@type']) && item['@type'].includes('Recipe'))) {
        recipe = item;
        break;
      }
    }
    if (!recipe) {
      // treat the whole object as a recipe if it has a name field
      if (parsed.name) {
        recipe = parsed;
      } else {
        return res.status(422).json({ error: 'No Recipe found in JSON. Make sure it has a name field or @type: Recipe.' });
      }
    }
  } catch (err) {
    return res.status(422).json({ error: `Invalid JSON: ${err.message}` });
  }

  delete recipe.aggregateRating;
  delete recipe.review;
  delete recipe.reviews;

  const doc = await db.insertAsync({
    recipe,
    ownerId: req.session.userId,
    metadata: { dateAdded: new Date().toISOString() },
  });

  res.json({ id: doc._id });
});

app.post('/api/import', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const existing = await db.findOneAsync({ 'metadata.sourceUrl': url });
  if (existing) return res.json({ id: existing._id, existing: true });

  let html;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NavCook/1.0)' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    html = await response.text();
  } catch (err) {
    return res.status(502).json({ error: `Failed to fetch URL: ${err.message}` });
  }

  let recipe;
  try {
    recipe = extractRecipe(html, url);
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }

  const doc = await db.insertAsync({
    recipe,
    ownerId: req.session.userId,
    metadata: {
      dateAdded: new Date().toISOString(),
      sourceUrl: url,
    },
  });

  res.json({ id: doc._id });
});

app.post('/api/recipes', requireAuth, async (req, res) => {
  const { name, recipeIngredient, recipeInstructions } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const recipe = {
    '@type': 'Recipe',
    name,
    recipeIngredient: Array.isArray(recipeIngredient) ? recipeIngredient : [],
    recipeInstructions: Array.isArray(recipeInstructions) ? recipeInstructions : [],
  };

  const doc = await db.insertAsync({
    recipe,
    ownerId: req.session.userId,
    metadata: { dateAdded: new Date().toISOString(), sourceUrl: null },
  });

  res.json({ id: doc._id });
});

app.get('/api/recipes', async (req, res) => {
  const docs = await db.findAsync({}).sort({ 'metadata.dateAdded': -1 });
  res.json(docs.map(d => ({
    id: d._id,
    name: d.recipe?.name || 'Untitled',
    dateAdded: d.metadata.dateAdded,
  })));
});

app.get('/api/recipe/:id', async (req, res) => {
  const doc = await db.findOneAsync({ _id: req.params.id });
  if (!doc) return res.status(404).json({ error: 'Recipe not found' });
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify({ ...doc, ownerId: doc.ownerId || null }, null, 2));
});

app.put('/api/recipe/:id', requireAuth, async (req, res) => {
  const { name, recipeIngredient, recipeInstructions } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const doc = await db.findOneAsync({ _id: req.params.id });
  if (!doc) return res.status(404).json({ error: 'Recipe not found' });
  if (doc.ownerId !== req.session.userId) return res.status(403).json({ error: 'Not your recipe' });

  const updatedRecipe = {
    ...doc.recipe,
    name,
    recipeIngredient: Array.isArray(recipeIngredient) ? recipeIngredient : [],
    recipeInstructions: Array.isArray(recipeInstructions) ? recipeInstructions : [],
  };

  await db.updateAsync({ _id: req.params.id }, { $set: { recipe: updatedRecipe } });
  res.json({ id: req.params.id });
});

app.delete('/api/recipe/:id', requireAuth, async (req, res) => {
  const doc = await db.findOneAsync({ _id: req.params.id });
  if (!doc) return res.status(404).json({ error: 'Recipe not found' });
  if (doc.ownerId !== req.session.userId) return res.status(403).json({ error: 'Not your recipe' });

  await db.removeAsync({ _id: req.params.id });
  res.json({ ok: true });
});

app.get('/api/profile', requireAuth, async (req, res) => {
  const docs = await db.findAsync({ ownerId: req.session.userId }).sort({ 'metadata.dateAdded': -1 });
  res.json(docs.map(d => ({
    id: d._id,
    name: d.recipe?.name || 'Untitled',
    dateAdded: d.metadata.dateAdded,
  })));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NavCook running at http://localhost:${PORT}`));
