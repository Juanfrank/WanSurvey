import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { initObservability } from './observability.js';

const config = loadConfig();
initObservability(config);
const app = await createApp();
await app.listen(config.PORT);
