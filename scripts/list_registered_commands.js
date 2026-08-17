// scripts/list_registered_commands.js
// Fetches the bot's registered GLOBAL application commands and lists /spades subcommands.
import 'dotenv/config';
import { REST, Routes } from 'discord.js';

const token = process.env.DISCORD_TOKEN;
if (!token) { console.error('No DISCORD_TOKEN'); process.exit(1); }

const rest = new REST({ version: '10' }).setToken(token);
try {
  const app = await rest.get('/applications/@me');
  console.log('application id:', app.id);
  const cmds = await rest.get(Routes.applicationCommands(app.id));
  const spades = cmds.find(c => c.name === 'spades');
  if (!spades) { console.log('No /spades command registered.'); process.exit(0); }
  const subs = (spades.options || []).map(o => o.name);
  console.log('registered /spades subcommands:', subs.join(', '));
  console.log('has announce?', subs.includes('announce'));
  console.log('has autodelete?', subs.includes('autodelete'));
} catch (e) {
  console.error('fetch failed:', e.message);
  process.exit(1);
}
