#!/usr/bin/env node
/**
 * update-data.js
 *
 * Searches for recent web content about AI water consumption using Brave Search,
 * sends it to an OpenRouter LLM, and writes updated figures back to data.json.
 *
 * Environment variables:
 *   OPENROUTER_API_KEY  (required)
 *   OPENROUTER_MODEL    (optional, defaults to a free model)
 *   BRAVE_API_KEY       (required)
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH  = join(__dirname, '..', 'data.json');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL   = process.env.OPENROUTER_MODEL || 'qwen/qwen3.6-plus-preview:free';
const BRAVE_API_KEY      = process.env.BRAVE_API_KEY;

if (!OPENROUTER_API_KEY) {
  console.error('ERROR: OPENROUTER_API_KEY is not set.');
  process.exit(1);
}

if (!BRAVE_API_KEY) {
  console.error('ERROR: BRAVE_API_KEY is not set.');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function searchBrave(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const params = new URLSearchParams({
      q: query,
      count: '5',
      freshness: 'py', // past year
    });

    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      signal: controller.signal,
      headers: {
        'X-Subscription-Token': BRAVE_API_KEY,
        'Accept': 'application/json',
      },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Format search results into readable text
    const results = data.results || [];
    if (!Array.isArray(results)) {
      throw new Error(`Expected results array, got ${typeof results}`);
    }

    const formatted = results
      .slice(0, 5)
      .map(r => `Title: ${r.title || ''}\nURL: ${r.url || ''}\nSnippet: ${r.description || ''}`)
      .join('\n---\n');

    return formatted.slice(0, 3000); // cap per search
  } catch (err) {
    console.warn(`  ⚠ Could not search "${query}": ${err.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenRouter(prompt) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com',
      'X-Title': 'AI Water Tracker',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1, // low temp for factual extraction
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function extractJson(text) {
  // Pull the first JSON object from the response
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in model response');
  return JSON.parse(match[0]);
}

function sanityCheck(updated, current) {
  const checks = [
    ['annualLitersEstimate', 1e11, 5e12],  // 100B – 5T
    ['hyperscaleDataCenters', 500, 10000],
    ['litersPerQuery', 0.0001, 5],
  ];
  for (const [field, min, max] of checks) {
    const val = updated[field];
    if (typeof val !== 'number' || val < min || val > max) {
      throw new Error(`Sanity check failed for ${field}: got ${val}`);
    }
  }
  // Arrays must survive
  if (!Array.isArray(updated.companies) || updated.companies.length < 3) {
    throw new Error('companies array invalid');
  }
  if (!Array.isArray(updated.timeline) || updated.timeline.length < 5) {
    throw new Error('timeline array invalid');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Model: ${OPENROUTER_MODEL}`);

  const current = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  console.log(`Current data dated: ${current.lastUpdated}`);

  // Search for recent content in parallel
  console.log('Searching for recent content…');
  const [search1, search2] = await Promise.all([
    searchBrave('AI data center water consumption statistics 2025 2026'),
    searchBrave('Microsoft Google Amazon Meta water usage sustainability report 2025'),
  ]);

  const context = [search1, search2]
    .filter(Boolean)
    .map((t, i) => `--- Search ${i + 1} ---\n${t}`)
    .join('\n\n');

  if (!context.trim()) {
    console.warn('No search results — relying on model knowledge only.');
  }

  const today = new Date().toISOString().split('T')[0];

  const prompt = `You are a precise data extraction assistant updating a JSON dataset about AI data center water consumption.

TODAY'S DATE: ${today}

CURRENT DATA (last updated ${current.lastUpdated}):
${JSON.stringify(current, null, 2)}

WEB CONTENT FETCHED TODAY:
${context || '(no web content available — use your training knowledge)'}

TASK:
Review the web content and update the JSON where you find credible, more recent figures. Rules:
1. Only increase values if supported by the fetched content or well-known published reports.
2. Do NOT decrease values unless a credible correction is explicitly stated in the content.
3. Keep all colors in the companies array unchanged.
4. Set "lastUpdated" to "${today}".
5. Update "sources" array if new sources are found; keep existing ones.
6. Return ONLY a valid JSON object with the exact same structure — no explanation, no markdown fences, just the raw JSON.`;

  console.log('Calling OpenRouter…');
  let raw;
  try {
    raw = await callOpenRouter(prompt);
  } catch (err) {
    console.error('OpenRouter call failed:', err.message);
    process.exit(1);
  }

  let updated;
  try {
    updated = extractJson(raw);
  } catch (err) {
    console.error('Failed to parse model response:', err.message);
    console.error('Raw response:', raw.slice(0, 500));
    process.exit(1);
  }

  try {
    sanityCheck(updated, current);
  } catch (err) {
    console.error('Sanity check failed:', err.message);
    console.error('Keeping existing data.json unchanged.');
    process.exit(1);
  }

  writeFileSync(DATA_PATH, JSON.stringify(updated, null, 2));
  console.log(`✓ data.json updated (lastUpdated: ${updated.lastUpdated})`);

  // Log a diff summary
  const fields = ['annualLitersEstimate', 'hyperscaleDataCenters', 'pipelineDataCenters', 'litersPerQuery'];
  for (const f of fields) {
    if (updated[f] !== current[f]) {
      console.log(`  ${f}: ${current[f]} → ${updated[f]}`);
    }
  }
}

main();
