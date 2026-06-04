# Recipe Queue

## Concept
A recipe app that imports recipes from URLs, queues them for specific days, and provides a step-by-step cooking mode with AI assistance.

## Core Features

### 1. Recipe Import
- Paste a recipe URL
- Scraper extracts content and converts to standard JSON format
- Stores in local database

### 2. Recipe Queue
- Queue recipes for specific days ("make this tomorrow", "this for Wednesday")
- "Never-ending queue" you can keep adding to
- View what's planned for the week

### 3. Active Cooking Mode
- Step-by-step view like Google Maps directions
- **Active step highlighted** (different color, pops out)
- Big "Next" button to advance
- Scroll to see upcoming steps if wanted
- Keep screen on while cooking

### 4. AI Assistant
- Ask questions during any step ("confused about this", "what does this mean?")
- AI can help troubleshoot or explain
- Add notes to steps if you modify the recipe

### 5. Notes
- Per-recipe notes section
- Record modifications ("used less salt", "added garlic")
- Voice-friendly (tell AI what to note)

## Tech Stack
- PWA (Progressive Web App)
- Recipe scraper (could use a library or custom)
- Local storage / database (SQLite?)
- AI integration for the assistant feature
- Keep screen awake API

## Status
- Idea stage

## Tags
#idea #recipe #cooking #pwa #queue #ai

---

## Updated Plan (2026-02-24)

### Architecture
1. **Recipe Scraper Library** (separate repo)
   - Exposes endpoint that accepts URL, returns JSON recipe
   - Users can run locally or self-host
   - Designed to be extensible

2. **Backend API**
   - MongoDB document store
   - Collections:
     - `recipes` - imported recipes
     - `recipe_events` - planned/completed meals with timestamps

3. **Frontend**
   - React application
   - Pages:
     - All recipes (list/grid view)
     - Calendar (planned meals)
     - Cooking mode (step-by-step with current step tracking)

### Data Models

#### Recipe (MongoDB)
```json
{
  "_id": "ObjectId",
  "url": "string",
  "title": "string",
  "description": "string",
  "ingredients": ["string"],
  "steps": [
    {
      "order": "number",
      "instruction": "string",
      "notes": "string (optional)"
    }
  ],
  "prepTime": "number (minutes)",
  "cookTime": "number (minutes)",
  "servings": "number",
  "source": "string",
  "importedAt": "datetime",
  "notes": "string (user modifications)"
}
```

#### Recipe Event (MongoDB)
```json
{
  "_id": "ObjectId",
  "recipeId": "ObjectId (ref to recipe)",
  "plannedDate": "datetime",
  "completedAt": "datetime (null until completed)",
  "completed": "boolean",
  "userNotes": "string"
}
```

### Future Ideas (to implement later)
- AI assistant for cooking questions
- Voice commands
- Grocery list generation from planned meals
- Shopping list integration
- Recipe sharing
- Meal planning suggestions based on preferences
- Nutritional information
- Import from more sources (manual entry, API integrations)
