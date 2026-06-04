import express from 'express';
import * as cheerio from 'cheerio';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECIPES_DIR = path.join(__dirname, 'recipes');
const app = express();

app.use(express.json());
app.use(express.static('public'));
app.use('/recipes', express.static(RECIPES_DIR));

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

  const title = typeof recipe.name === 'string' ? recipe.name : 'recipe';
  const filename = `${slugify(title)}-${urlHash(url)}.json`;

  if (!existsSync(RECIPES_DIR)) await mkdir(RECIPES_DIR, { recursive: true });
  await writeFile(path.join(RECIPES_DIR, filename), JSON.stringify(recipe, null, 2));

  res.json({ filename, recipeUrl: `/recipes/${filename}` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NavCook running at http://localhost:${PORT}`));
