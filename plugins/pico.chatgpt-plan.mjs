import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const builtPlugin = join(appRoot, 'dist', 'server', 'plugins', 'chatgpt-plan.js');
const sourcePlugin = join(appRoot, 'src', 'plugins', 'chatgpt-plan.ts');
const production = process.env.NODE_ENV === 'production' || process.env.PICO_ENV === 'production';
const implementation = production && existsSync(builtPlugin) ? builtPlugin : sourcePlugin;
const pluginModule = await import(pathToFileURL(implementation).href);

export default pluginModule.createChatGptPlanPlugin();
