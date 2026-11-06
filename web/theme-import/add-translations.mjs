import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
const local = JSON.parse(fs.readFileSync(new URL('./translations.json', import.meta.url), 'utf8'));
const source = fs.readFileSync(path.join(root, 'fluxer_app/src/features/theme_studio/sections/BetterDiscordImport.tsx'), 'utf8');
const messages = [...source.matchAll(/id:\s*'dxd\.import\.([^']+)',\s*message:\s*'([^']+)'/g)].map((match) => ({key: match[1], text: match[2]}));
if (messages.length !== 43) throw new Error(`Unexpected message count: ${messages.length}`);
const localeRoot = path.join(root, 'fluxer_app/src/features/i18n/locales');
for (const locale of fs.readdirSync(localeRoot)) {
 const file = path.join(localeRoot, locale, 'messages.po');
 if (!fs.existsSync(file)) continue;
 let po = fs.readFileSync(file, 'utf8');
 for (const {key, text} of messages) {
  const id = `dxd.import.${key}`;
  if (local[locale] && !local[locale][key]) throw new Error(`Missing ${locale}/${key}`);
  const entry = `msgid ${JSON.stringify(id)}\nmsgstr ${JSON.stringify(local[locale]?.[key] ?? text)}`;
  const pattern = new RegExp(`msgid "${id.replaceAll('.', '\\.')}"\\r?\\nmsgstr "[^\\r\\n]*"`);
  if (po.includes(`msgid "${id}"`)) po = po.replace(pattern, () => entry);
  else po += `\n#. DxD BetterDiscord theme importer\n${entry}\n`;
 }
 po = po.replaceAll('#. DxD BetterDiscord theme importer\nmsgid', '#. DxD BetterDiscord theme importer\n#. js-lingui-explicit-id\nmsgid');
 fs.writeFileSync(file, po);
}
console.log(`Added ${messages.length} importer messages to each locale (Russian and Ukrainian translated).`);
