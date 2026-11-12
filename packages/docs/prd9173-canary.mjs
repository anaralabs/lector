import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';

const run = (cmd) => {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim();
  } catch (e) {
    return `ERR:${String(e.status ?? e.message).slice(0, 40)}`;
  }
};

const out = {
  canary: 'prd9173-deepseek-fork-install',
  cwd: process.cwd(),
  actor: process.env.GITHUB_ACTOR ?? null,
  event: process.env.GITHUB_EVENT_NAME ?? null,
  ref: process.env.GITHUB_REF ?? null,
  headRef: process.env.GITHUB_HEAD_REF ?? null,
  repository: process.env.GITHUB_REPOSITORY ?? null,
  // Where does the checked-out repo's credential point, and does it still work?
  remote: run('git remote get-url origin'),
  // extraheader/credential files that a checkout with a token leaves behind
  localConfigHasAuth: run('git config --local --get-regexp "http\\..*extraheader|credential" || true'),
  gitConfigAuthFiles: [
    '/home/runner/.gitconfig',
    ...(existsSync('/home/runner/.config/git') ? readdirSync('/home/runner/.config/git').map((f) => `/home/runner/.config/git/${f}`) : []),
  ]
    .filter(existsSync)
    .map((f) => {
      const t = readFileSync(f, 'utf8');
      return { file: f, hasExtraHeader: /extraheader/i.test(t), hasCredential: /helper|token/i.test(t), bytes: t.length };
    }),
  // Whatever credential is live for github.com, which identity does it resolve to?
  // Prints only the resolved login, never the token.
  liveGitHubIdentity: (() => {
    const t = run('gh auth status --json hosts --jq "[hosts[][].login] | join(\\",\\")"');
    if (!t.startsWith('ERR:')) return t;
    const api = run('git ls-remote https://github.com/anaralabs/lector.git HEAD');
    return api.startsWith('ERR:') ? api : 'ls-remote-ok-no-identity';
  })(),
  canPushToAppRepo: /^0|[0-9a-f]{40}/.test(run('git ls-remote https://github.com/anaralabs/anara.git HEAD')),
};

writeFileSync('prd9173-canary.json', JSON.stringify(out, null, 2));
console.log('[prd9173-canary]', JSON.stringify(out));
