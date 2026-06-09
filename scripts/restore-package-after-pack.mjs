import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const packageJsonPath = path.join(root, 'package.json');
const legacyBackupPath = path.join(root, '.package.json.prepack-backup');
const backupRoot = path.join(root, '.package.prepack-backup');
const backupFilesRoot = path.join(backupRoot, 'files');
const removedDirsRoot = path.join(backupRoot, 'removed');
const removedDirsManifestPath = path.join(backupRoot, 'removed-dirs.json');
const createdDirsManifestPath = path.join(backupRoot, 'created-dirs.json');

function restoreFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const source = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      restoreFiles(source);
      continue;
    }
    const target = path.join(root, path.relative(backupFilesRoot, source));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

function restoreRemovedDirs(dir) {
  if (!fs.existsSync(removedDirsManifestPath)) return;
  const entries = JSON.parse(fs.readFileSync(removedDirsManifestPath, 'utf8'));
  if (!Array.isArray(entries)) return;
  for (const relative of entries) {
    if (typeof relative !== 'string' || !relative) continue;
    const source = path.join(dir, relative);
    if (!fs.existsSync(source)) continue;
    const target = path.join(root, relative);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  }
}

function removeCreatedDirs() {
  if (!fs.existsSync(createdDirsManifestPath)) return;
  const entries = JSON.parse(fs.readFileSync(createdDirsManifestPath, 'utf8'));
  if (!Array.isArray(entries)) return;
  for (const relative of entries) {
    if (typeof relative !== 'string' || !relative) continue;
    fs.rmSync(path.join(root, relative), { recursive: true, force: true });
  }
}

restoreFiles(backupFilesRoot);
restoreRemovedDirs(removedDirsRoot);
removeCreatedDirs();
if (fs.existsSync(legacyBackupPath)) {
  fs.copyFileSync(legacyBackupPath, packageJsonPath);
  fs.rmSync(legacyBackupPath, { force: true });
}
if (fs.existsSync(backupRoot)) {
  fs.rmSync(backupRoot, { recursive: true, force: true });
}
