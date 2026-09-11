const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf-8');
const js = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf-8');

const ids = [...js.matchAll(/getElementById\(['"]([\w-]+)['"]\)/g)].map((m) => m[1]);
const missing = [...new Set(ids)].filter((id) => !html.includes('id="' + id + '"'));
console.log('ids referenced:', new Set(ids).size);
console.log('missing ids:', missing.length ? missing : 'none');

const template = html.match(/<template id="accountCardTemplate">[\s\S]*?<\/template>/)[0];
const cls = [...js.matchAll(/querySelector\(['"]\.([\w-]+)['"]\)/g)].map((m) => m[1]);
const missingCls = [...new Set(cls)].filter(
  (c) => c !== 'account-block' && !template.includes('class="' + c + '"')
);
console.log('card classes missing from template:', missingCls.length ? missingCls : 'none');
