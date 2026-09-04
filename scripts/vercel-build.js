const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const publicJs = path.join(root, 'public', 'js');

fs.mkdirSync(publicJs, { recursive: true });

for (const file of ['game-core.js', 'progression.js', 'cosmetics.js']) {
  fs.copyFileSync(
    path.join(root, 'shared', file),
    path.join(publicJs, file)
  );
}

const config = [
  `window.SERVER_URL=${JSON.stringify(process.env.SERVER_URL || '')};`,
  `window.SB_U=${JSON.stringify(process.env.SUPABASE_URL || '')};`,
  `window.SB_A=${JSON.stringify(process.env.SUPABASE_ANON || '')};`,
  `window.C_WA=${JSON.stringify(process.env.COMMUNITY_WA || '')};`,
  `window.C_DC=${JSON.stringify(process.env.COMMUNITY_DC || '')};`
].join('');

fs.writeFileSync(path.join(publicJs, 'config.js'), config);
