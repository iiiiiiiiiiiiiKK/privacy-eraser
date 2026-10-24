/**
 * Push the current git HEAD to GitHub through the REST API.
 *
 * Why this exists: on some networks `github.com:443` (the smart-HTTP git
 * transport used by `git push`) is unreachable while `api.github.com` stays
 * available. This script mirrors the committed tree with the Git Data API,
 * producing the same result as a push: one new commit on top of the remote head.
 *
 * Usage:
 *   GITHUB_TOKEN=... node scripts/sync-api.mjs [--dry-run]
 */
import { execFileSync } from 'node:child_process';

const OWNER = 'iiiiiiiiiiiiiKK';
const REPO = 'privacy-eraser';
const BRANCH = 'main';
const TOKEN = process.env.GITHUB_TOKEN;
const API = 'https://api.github.com';

if (!TOKEN) {
  console.error('GITHUB_TOKEN is required');
  process.exit(1);
}
const dryRun = process.argv.includes('--dry-run');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

async function api(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'privacy-eraser-sync',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

// 1. Remote state.
const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
const remoteHead = ref.object.sha;
const remoteCommit = await api(`/repos/${OWNER}/${REPO}/git/commits/${remoteHead}`);
const remoteTree = await api(`/repos/${OWNER}/${REPO}/git/trees/${remoteCommit.tree.sha}?recursive=1`);
const remote = new Map();
for (const entry of remoteTree.tree) {
  if (entry.type === 'blob') remote.set(entry.path, entry.sha);
}
console.log(`remote ${remoteHead.slice(0, 7)}: ${remote.size} blobs`);

// 2. Local committed blobs (index/HEAD == working tree, we commit before syncing).
const local = new Map();
for (const line of git('ls-tree', '-r', 'HEAD').split('\n').filter(Boolean)) {
  const [meta, path] = line.split('\t');
  const [mode, , sha] = meta.split(' ');
  local.set(path, { sha, mode });
}

const changed = [];
for (const [path, info] of local) {
  if (remote.get(path) !== info.sha) changed.push({ path, ...info });
}
const deleted = [...remote.keys()].filter((p) => !local.has(p));

console.log(`changed: ${changed.length}, deleted: ${deleted.length}`);
for (const item of changed.slice(0, 25)) console.log(`  M ${item.path}`);
for (const item of deleted.slice(0, 25)) console.log(`  D ${item}`);

if (changed.length === 0 && deleted.length === 0) {
  console.log('remote already matches HEAD');
  process.exit(0);
}
if (dryRun) process.exit(0);

// 3. Upload changed blobs and build the new tree.
const treeEntries = [];
for (const item of changed) {
  const content = execFileSync('git', ['cat-file', 'blob', item.sha], { maxBuffer: 64 * 1024 * 1024 });
  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
  });
  treeEntries.push({ path: item.path, mode: item.mode, type: 'blob', sha: blob.sha });
}
for (const path of deleted) {
  treeEntries.push({ path, mode: '100644', type: 'blob', sha: null });
}

const tree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ base_tree: remoteCommit.tree.sha, tree: treeEntries }),
});

// 4. Commit and fast-forward the branch.
const message = git('log', '-1', '--pretty=%B');
const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({ message, tree: tree.sha, parents: [remoteHead] }),
});
await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha, force: false }),
});

console.log(`pushed ${commit.sha.slice(0, 7)} -> ${OWNER}/${REPO}:${BRANCH}`);
