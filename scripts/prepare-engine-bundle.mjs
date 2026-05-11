import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const engineRoot = path.join(root, 'node_modules', '@octopus', 'engine');
const bpmnRoot = path.join(root, 'node_modules', '@octopus', 'bpmn');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

if (!fs.existsSync(engineRoot)) {
  throw new Error('@octopus/engine is not installed. Run npm install first.');
}

if (!fs.existsSync(bpmnRoot)) {
  throw new Error('@octopus/bpmn is not installed. Run npm install first.');
}

for (const packageJson of [
  path.join(engineRoot, 'package.json'),
  path.join(engineRoot, 'dist', 'package.json'),
  path.join(bpmnRoot, 'package.json')
]) {
  if (!fs.existsSync(packageJson)) {
    continue;
  }

  const pkg = readJson(packageJson);
  pkg.dependencies = {};
  writeJson(packageJson, pkg);
}

for (const dir of [
  path.join(engineRoot, 'dist', 'node_modules'),
  path.join(engineRoot, 'node_modules')
]) {
  fs.rmSync(dir, { recursive: true, force: true });
}
