import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = path.join(root, 'plugin-store/catalog.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const errors = [];

const sha256Pattern = /^[a-f0-9]{64}$/;
const seenPluginIds = new Set();

if (catalog.schemaVersion !== 1) {
  errors.push('schemaVersion must be 1.');
}

if (!Array.isArray(catalog.plugins)) {
  errors.push('plugins must be an array.');
}

for (const plugin of catalog.plugins || []) {
  if (!plugin.pluginId) errors.push('pluginId is required.');
  if (seenPluginIds.has(plugin.pluginId)) {
    errors.push(`Duplicate pluginId: ${plugin.pluginId}`);
  }
  seenPluginIds.add(plugin.pluginId);

  if (plugin.publisher?.kind === 'official' && plugin.publisher.repositoryOwner !== 'vanloctech') {
    errors.push(`${plugin.pluginId}: official plugins must use repositoryOwner "vanloctech".`);
  }

  const repoUrl = new URL(plugin.repository);
  const repoParts = repoUrl.pathname.split('/').filter(Boolean);
  if (repoUrl.protocol !== 'https:' || repoUrl.hostname !== 'github.com' || repoParts.length < 2) {
    errors.push(`${plugin.pluginId}: repository must be a GitHub HTTPS URL.`);
  }
  if (plugin.publisher?.repositoryOwner && repoParts[0] !== plugin.publisher.repositoryOwner) {
    errors.push(`${plugin.pluginId}: repositoryOwner must match repository owner.`);
  }

  const seenVersions = new Set();
  for (const version of plugin.versions || []) {
    if (seenVersions.has(version.version)) {
      errors.push(`${plugin.pluginId}: duplicate version ${version.version}.`);
    }
    seenVersions.add(version.version);

    if (!sha256Pattern.test(version.sha256 || '')) {
      errors.push(`${plugin.pluginId}@${version.version}: sha256 must be 64 lowercase hex chars.`);
    }
    if (!sha256Pattern.test(version.signerFingerprint || '')) {
      errors.push(
        `${plugin.pluginId}@${version.version}: signerFingerprint must be 64 lowercase hex chars.`,
      );
    }

    const packageUrl = new URL(version.packageUrl);
    const parts = packageUrl.pathname.split('/').filter(Boolean);
    const expectedPrefix = [repoParts[0], repoParts[1], 'releases', 'download', version.releaseTag];
    if (
      packageUrl.protocol !== 'https:' ||
      packageUrl.hostname !== 'github.com' ||
      expectedPrefix.some((part, index) => parts[index] !== part)
    ) {
      errors.push(
        `${plugin.pluginId}@${version.version}: packageUrl must be a GitHub release asset.`,
      );
    }
    if (parts.includes('latest')) {
      errors.push(`${plugin.pluginId}@${version.version}: packageUrl must not use latest.`);
    }
    if (!version.packageUrl.endsWith(`/${version.assetName}`)) {
      errors.push(`${plugin.pluginId}@${version.version}: assetName must match packageUrl.`);
    }
    if (!version.assetName.endsWith('.ywp')) {
      errors.push(`${plugin.pluginId}@${version.version}: assetName must end with .ywp.`);
    }
  }

  if (!seenVersions.has(plugin.latestVersion)) {
    errors.push(`${plugin.pluginId}: latestVersion must exist in versions.`);
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`Plugin store catalog OK (${catalog.plugins.length} plugins).`);
