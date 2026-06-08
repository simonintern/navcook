import express from 'express';
import * as cheerio from 'cheerio';
import { readdir, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import Datastore from '@seald-io/nedb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECIPES_DIR = path.join(__dirname, 'recipes');
const DB_PATH = path.join(__dirname, 'data', 'recipes.db');

await mkdir(path.join(__dirname, 'data'), { recursive: true });

const db = new Datastore({ filename: DB_PATH, autoload: true });
db.ensureIndex({ fieldName: 'metadata.dateAdded' });

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
          dateAdded: new Date(0).toISOString(), // epoch so they sort to the bottom
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

app.get('/sw.js', async (req, res) => {
  const raw = await readFile(path.join(__dirname, 'public', 'sw.js'), 'utf8');
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-store');
  res.send(raw.replace('__BUILD__', BUILD));
});

app.use(express.static('public'));

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
    recipe.recipeInstructions = recipe.recipeInstructions.map(step => {
      if (step && typeof step === 'object' && step.name && step.text && step.name === step.text) {
        const { name, ...rest } = step;
        return rest;
      }
      return step;
    });
  }

  return recipe;
}

app.post('/api/import', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

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
    metadata: {
      dateAdded: new Date().toISOString(),
      sourceUrl: url,
    },
  });

  res.json({ id: doc._id });
});

app.post('/api/recipes', async (req, res) => {
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
  res.json(doc);
});

app.put('/api/recipe/:id', async (req, res) => {
  const { name, recipeIngredient, recipeInstructions } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const doc = await db.findOneAsync({ _id: req.params.id });
  if (!doc) return res.status(404).json({ error: 'Recipe not found' });

  const updatedRecipe = {
    ...doc.recipe,
    name,
    recipeIngredient: Array.isArray(recipeIngredient) ? recipeIngredient : [],
    recipeInstructions: Array.isArray(recipeInstructions) ? recipeInstructions : [],
  };

  await db.updateAsync({ _id: req.params.id }, { $set: { recipe: updatedRecipe } });
  res.json({ id: req.params.id });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NavCook running at http://localhost:${PORT}`));
