const path = require('path');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const tsxPath = path.resolve(__dirname, '../node_modules/.bin/tsx');
const indexPath = path.resolve(__dirname, '../src/index.tsx');

spawnSync(tsxPath, [indexPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env
});