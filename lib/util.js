import fs from 'fs';
import path from 'path';

export function slugifyName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unnamed';
}


function toList(parsed) {
  return Array.isArray(parsed) ? parsed : [parsed];
}

function parseJsonFile(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); }
  catch (e) { console.error(`Error reading ${filepath}: ${e.message}`); process.exit(1); }
}

// Reads a list of items (tags, credentials) from a .json file or from a
// directory of .json files. Each file may hold a single object or an array,
// so a per-item file pulled with --dir can also be pushed on its own.
export function readJsonList(filepath) {
  if (filepath.endsWith('.json')) return toList(parseJsonFile(filepath));
  if (!fs.existsSync(filepath)) {
    console.error(`Error: directory not found: ${filepath}`);
    process.exit(1);
  }
  return fs.readdirSync(filepath)
    .filter(f => f.endsWith('.json'))
    .flatMap(f => toList(parseJsonFile(path.join(filepath, f))));
}

