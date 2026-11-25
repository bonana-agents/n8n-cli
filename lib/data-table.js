import fs from 'fs';
import path from 'path';
import { runCli } from './run.js';
import { getSection } from './manifest.js';
import { slugifyName } from './util.js';

export { slugifyName };

export const DEFAULT_DATA_TABLES_DIR = 'n8n/data-tables';

function listRemoteTables(env) {
  const result = runCli(['data-table', 'list', '--json'], env);
  if (result.status !== 0) { process.stderr.write(result.stderr); return null; }
  try { return JSON.parse(result.stdout.toString()); } catch { return null; }
}

let projectNames = null;

function projectName(projectId, env) {
  if (!projectId) return 'unknown';
  if (!projectNames) {
    projectNames = new Map();
    const result = runCli(['project', 'list', '--json'], env);
    if (result.status === 0) {
      try { for (const p of JSON.parse(result.stdout.toString())) projectNames.set(p.id, p.name); } catch {}
    }
  }
  return projectNames.get(projectId) ?? projectId;
}

export function pullDataTable(tableId, env) {
  const getResult = runCli(['data-table', 'get', tableId, '--json'], env);
  if (getResult.status !== 0) { process.stderr.write(getResult.stderr); return null; }

  const rowsResult = runCli(['data-table', 'rows', tableId, '--json'], env);
  if (rowsResult.status !== 0) { process.stderr.write(rowsResult.stderr); return null; }

  let table, rows;
  try {
    table = JSON.parse(getResult.stdout.toString());
    rows  = JSON.parse(rowsResult.stdout.toString());
  } catch (e) {
    console.error(`Error parsing data table response: ${e.message}`);
    return null;
  }

  return {
    name:      table.name,
    columns:   table.columns,
    upsertKey: table.columns?.[0]?.name ?? null,
    rows:      rows.map(r => r.row ?? r),
  };
}

export function pullAllDataTables(targetDir, envName, manifest, env, { existing = false } = {}) {
  console.log('Fetching data table list...');
  const tables = listRemoteTables(env);
  if (!tables) { console.error('Error: could not fetch data tables'); process.exit(1); }

  fs.mkdirSync(targetDir, { recursive: true });

  const manifestSection = (manifest[envName] ??= {})['data-tables'] ??= {};
  const seenSlugs = new Map();
  let pulled = 0, skipped = 0;

  for (const t of tables) {
    let slug = slugifyName(t.name);
    if (seenSlugs.has(slug) && seenSlugs.get(slug) !== String(t.id)) slug = `${slug}_${t.id}`;
    seenSlugs.set(slug, String(t.id));

    const newFilename = `${slug}.json`;
    const existingFilename = Object.keys(manifestSection).find(f => String(manifestSection[f]) === String(t.id));

    if (existing && !existingFilename && !fs.existsSync(path.join(targetDir, newFilename))) {
      console.log(`Skipped  ${newFilename} (not local)`);
      skipped++;
      continue;
    }

    const data = pullDataTable(String(t.id), env);
    if (!data) { console.error(`Failed   ${t.name}`); continue; }

    if (existingFilename && existingFilename !== newFilename) {
      const oldPath = path.join(targetDir, existingFilename);
      if (fs.existsSync(oldPath)) fs.renameSync(oldPath, path.join(targetDir, newFilename));
      delete manifestSection[existingFilename];
      console.log(`Renamed  ${existingFilename} -> ${newFilename}`);
    }

    manifestSection[newFilename] = String(t.id);
    fs.writeFileSync(path.join(targetDir, newFilename), JSON.stringify(data, null, 2) + '\n');
    console.log(`Pulled   ${newFilename}`);
    pulled++;
  }

  const skippedPart = existing ? `, ${skipped} skipped` : '';
  console.log(`\n${pulled}/${tables.length} data table(s) pulled${skippedPart}`);
  return true;
}

export function pushDataTable(filepath, envName, manifest, env) {
  let file;
  try {
    file = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) {
    console.error(`Error reading ${filepath}: ${e.message}`);
    return false;
  }

  const filename = path.basename(filepath);
  const tableManifest = getSection(manifest, envName, 'data-tables');
  let tableId = tableManifest[filename];

  if (!tableId) {
    // Find by name or create. A name match can be a table of another project on
    // a shared instance, so only reuse it when it is the only table with that
    // name and has the same columns.
    const remote = listRemoteTables(env);
    const matches = remote?.filter(t => t.name === file.name) ?? [];

    if (matches.length > 1) {
      console.error(`Error: ${matches.length} remote tables are named "${file.name}" (ids: ${matches.map(t => t.id).join(', ')}).`);
      console.error(`  Add the right id to .n8n_cli/manifest.json under "${envName}" > "data-tables" > "${filename}" and push again.`);
      return false;
    }

    if (matches.length === 1) {
      const existing = matches[0];
      const columnNames = cols => (cols ?? []).map(c => c.name).sort().join(', ');
      if (columnNames(existing.columns) !== columnNames(file.columns)) {
        console.error(`Error: remote table "${file.name}" (id: ${existing.id}, project: ${projectName(existing.projectId, env)}) has different columns.`);
        console.error(`  remote: ${columnNames(existing.columns)}`);
        console.error(`  local:  ${columnNames(file.columns)}`);
        console.error('  No rows written. Rename the local table, or map it in .n8n_cli/manifest.json if it is the right one.');
        return false;
      }
      tableId = existing.id;
      tableManifest[filename] = tableId;
      console.log(`Found    ${filename} → id: ${tableId} (existing table in project: ${projectName(existing.projectId, env)})`);
    } else {
      const createResult = runCli([
        'data-table', 'create',
        `--name=${file.name}`,
        `--columns=${JSON.stringify(file.columns)}`,
        '--json',
      ], env);

      if (createResult.status !== 0) { process.stderr.write(createResult.stderr); return false; }

      try {
        const created = JSON.parse(createResult.stdout.toString());
        tableId = created.id;
        tableManifest[filename] = tableId;
        console.log(`Created  ${filename} → id: ${tableId}`);
      } catch {
        console.error(`Error parsing create response for ${filename}`);
        return false;
      }
    }
  }

  if (!file.rows?.length) {
    console.log(`  No rows to upsert for ${filename}`);
    return true;
  }

  const upsertKey = file.upsertKey ?? file.columns?.[0]?.name;
  let upserted = 0;

  for (const row of file.rows) {
    const filter = {
      type: 'and',
      filters: [{ columnName: upsertKey, condition: 'eq', value: row[upsertKey] }],
    };
    const payload = JSON.stringify({ filter, data: row });

    const result = runCli(['data-table', 'upsert-rows', String(tableId), '--stdin'], env, {
      input: payload,
    });

    if (result.status !== 0) {
      console.error(`  Failed to upsert row: ${JSON.stringify(row)}`);
    } else {
      upserted++;
    }
  }

  console.log(`  Upserted ${upserted}/${file.rows.length} row(s)`);
  return true;
}

export function pushAllDataTables(tablesDir, envName, manifest, env, { prune = false } = {}) {
  if (!fs.existsSync(tablesDir)) {
    console.error(`Error: directory not found: ${tablesDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(tablesDir).filter(f => f.endsWith('.json'));
  if (files.length === 0) { console.log(`No .json files found in ${tablesDir}`); process.exit(0); }

  console.log(`Pushing ${files.length} data table(s) to env: ${envName}\n`);
  let pushed = 0, deleted = 0, failed = 0;

  for (const filename of files) {
    const filepath = path.join(tablesDir, filename);
    if (pushDataTable(filepath, envName, manifest, env)) pushed++;
    else failed++;
  }

  if (prune) {
    const tableManifest = getSection(manifest, envName, 'data-tables');
    const localFiles = new Set(files);
    for (const [filename, tableId] of Object.entries(tableManifest)) {
      if (!localFiles.has(filename)) {
        const result = runCli(['data-table', 'delete', String(tableId)], env);
        if (result.status === 0) {
          delete tableManifest[filename];
          console.log(`Deleted  ${filename} (id: ${tableId})`);
          deleted++;
        } else {
          process.stderr.write(result.stderr);
          failed++;
        }
      }
    }
  }

  const deletedPart = prune ? `, ${deleted} deleted` : '';
  console.log(`\n${pushed} pushed${deletedPart}${failed > 0 ? `, ${failed} failed` : ''}`);
  return failed === 0;
}

export function diffDataTable(filepath, envName, manifest, env) {
  let local;
  try { local = JSON.parse(fs.readFileSync(filepath, 'utf8')); }
  catch (e) { console.error(`Error reading ${filepath}: ${e.message}`); return null; }

  const filename = path.basename(filepath);
  const tableManifest = getSection(manifest, envName, 'data-tables');
  let tableId = tableManifest[filename];

  if (!tableId) {
    const remote = listRemoteTables(env);
    const existing = remote?.find(t => t.name === local.name);
    if (!existing) return { notFound: true };
    tableId = existing.id;
  }

  const getResult  = runCli(['data-table', 'get',  String(tableId), '--json'], env);
  const rowsResult = runCli(['data-table', 'rows', String(tableId), '--json'], env);
  if (getResult.status !== 0)  { process.stderr.write(getResult.stderr);  return null; }
  if (rowsResult.status !== 0) { process.stderr.write(rowsResult.stderr); return null; }

  let remoteTable, remoteRows;
  try {
    remoteTable = JSON.parse(getResult.stdout.toString());
    remoteRows  = JSON.parse(rowsResult.stdout.toString()).map(r => r.row ?? r);
  } catch (e) { console.error(`Error parsing remote data table: ${e.message}`); return null; }

  const localCols  = new Map(local.columns.map(c => [c.name, c]));
  const remoteCols = new Map((remoteTable.columns ?? []).map(c => [c.name, c]));

  const addedCols   = local.columns.filter(c => !remoteCols.has(c.name));
  const removedCols = (remoteTable.columns ?? []).filter(c => !localCols.has(c.name));
  const changedCols = local.columns
    .filter(c => remoteCols.has(c.name) && remoteCols.get(c.name).type !== c.type)
    .map(c => ({ name: c.name, localType: c.type, remoteType: remoteCols.get(c.name).type }));

  const upsertKey = local.upsertKey ?? local.columns?.[0]?.name;
  const localRows = local.rows ?? [];
  let addedRows = [], removedRows = [], changedRows = [];

  if (upsertKey) {
    const remoteByKey = new Map(remoteRows.map(r => [String(r[upsertKey]), r]));
    const localByKey  = new Map(localRows.map(r => [String(r[upsertKey]), r]));
    addedRows   = localRows.filter(r => !remoteByKey.has(String(r[upsertKey])));
    removedRows = remoteRows.filter(r => !localByKey.has(String(r[upsertKey])));
    changedRows = localRows.filter(r => {
      const rem = remoteByKey.get(String(r[upsertKey]));
      return rem && JSON.stringify(r) !== JSON.stringify(rem);
    });
  }

  return { addedCols, removedCols, changedCols, addedRows, removedRows, changedRows };
}
