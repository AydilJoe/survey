// Regenerates the Malaysia sample on duitful.app/tax-rules/ from
// app/tax-data.js: tax-rules/malaysia.json and the copy shown on the page.
// Run after a Budget update: node scripts/build-tax-sample.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url).pathname;
const src = readFileSync(root + 'app/tax-data.js', 'utf8');
const data = JSON.parse(src.slice(src.lastIndexOf('const TAX_DATA = ') + 17).trim().replace(/;$/, ''));
delete data.$schema;
const { country, tax_authority, ...rest } = data;
const sample = {
  country, country_code: 'MYS', currency: 'MYR', tax_authority,
  terms: { authority: 'LHDN', year: 'YA', withholding: 'PCB', pension: 'EPF', filing: 'e-Filing', rebate: 'rebate' },
  ...rest,
};
const json = JSON.stringify(sample, null, 1);
writeFileSync(root + 'tax-rules/malaysia.json', json + '\n');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const page = readFileSync(root + 'tax-rules/index.html', 'utf8');
writeFileSync(root + 'tax-rules/index.html', page.replace(/(<pre id="sample">)[\s\S]*?(<\/pre>)/, (_, a, b) => a + esc(json) + b));
console.log('tax-rules/malaysia.json and the page sample rebuilt');
