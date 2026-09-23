// Load optional project configuration without overriding exported variables.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
dotenv.config({ path: rootEnv, quiet: true });
