import fs from 'fs';
import path from 'path';

// Workflow files reference other workflows (Execute Workflow and Workflow Tool
// nodes, settings.errorWorkflow) and data tables (Data Table nodes) by the ID
// they have on the instance the file was pulled from. The manifest records the
// ID of every file per environment, so an ID that belongs to a file in another
// environment can be translated to the ID of the same file in the target.

function sectionOf(manifest, envName, section) {
  return manifest[envName]?.[section] ?? {};
}

function buildSectionMap(manifest, section, targetEnv) {
  const target = sectionOf(manifest, targetEnv, section);
  const map = {};
  for (const [envName, sections] of Object.entries(manifest)) {
    if (envName === targetEnv) continue;
    for (const [file, id] of Object.entries(sections?.[section] ?? {})) {
      if (target[file] != null) map[String(id)] = String(target[file]);
    }
  }
  return { map, targetIds: new Set(Object.values(target).map(String)) };
}

export function buildIdMaps(manifest, targetEnv) {
  return {
    workflows: buildSectionMap(manifest, 'workflows', targetEnv),
    dataTables: buildSectionMap(manifest, 'data-tables', targetEnv),
  };
}

function isLiteralId(value) {
  return typeof value === 'string' && value !== '' && !value.startsWith('=');
}

function translate(id, { map, targetIds }, label, warn) {
  if (!isLiteralId(id)) return id;
  if (map[id]) return map[id];
  if (!targetIds.has(id) && warn) {
    console.warn(`  Warning: no target id for ${label} "${id}". Push it to this environment first.`);
  }
  return id;
}

function remapLocator(params, key, idMap, label, warn) {
  const ref = params?.[key];
  if (ref && typeof ref === 'object' && ref.__rl) {
    if (ref.mode === 'name') return;
    const newId = translate(ref.value, idMap, label, warn);
    if (newId !== ref.value) {
      ref.value = newId;
      if (ref.cachedResultUrl) ref.cachedResultUrl = ref.cachedResultUrl.replace(/[^/]+$/, newId);
    }
  } else if (typeof ref === 'string') {
    params[key] = translate(ref, idMap, label, warn);
  }
}

// Returns a copy of the workflow with sub-workflow, error workflow and data
// table references translated to the target environment.
export function applyIdMapping(workflow, maps, { warn = true } = {}) {
  const result = JSON.parse(JSON.stringify(workflow));
  for (const node of result.nodes ?? []) {
    remapLocator(node.parameters, 'workflowId', maps.workflows, `workflow (node "${node.name}")`, warn);
    remapLocator(node.parameters, 'dataTableId', maps.dataTables, `data table (node "${node.name}")`, warn);
  }
  if (result.settings?.errorWorkflow) {
    result.settings.errorWorkflow = translate(result.settings.errorWorkflow, maps.workflows, 'error workflow', warn);
  }
  return result;
}

function referencedWorkflowIds(workflow) {
  const ids = [];
  for (const node of workflow.nodes ?? []) {
    const ref = node.parameters?.workflowId;
    const id = ref && typeof ref === 'object' ? ref.value : ref;
    if (isLiteralId(id)) ids.push(id);
  }
  if (isLiteralId(workflow.settings?.errorWorkflow)) ids.push(workflow.settings.errorWorkflow);
  return ids;
}

// Orders filenames so that sub-workflows and error workflows come before the
// workflows that reference them, using the IDs recorded in the manifest for
// any environment. Unknown references and cycles keep their position.
export function orderByWorkflowDependencies(dir, filenames, manifest) {
  const fileById = new Map();
  for (const sections of Object.values(manifest)) {
    for (const [file, id] of Object.entries(sections?.workflows ?? {})) fileById.set(String(id), file);
  }

  const refs = new Map();
  for (const filename of filenames) {
    try { refs.set(filename, referencedWorkflowIds(JSON.parse(fs.readFileSync(path.join(dir, filename), 'utf8')))); }
    catch { refs.set(filename, []); }
  }

  const ordered = [];
  const visited = new Set();
  const visit = filename => {
    if (visited.has(filename)) return;
    visited.add(filename);
    for (const id of refs.get(filename) ?? []) {
      const dep = fileById.get(id);
      if (dep && refs.has(dep)) visit(dep);
    }
    ordered.push(filename);
  };
  filenames.forEach(visit);
  return ordered;
}
