// cli/lib/env.js
// Loads .env from the excal-coder root, regardless of cwd.
// MUST be imported first by every entry point.

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// cli/lib/env.js → ../../ = project root
const rootEnv = path.resolve(__dirname, '..', '..', '.env');

if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv });
} else {
  console.error(`⚠️  No .env found at ${rootEnv}`);
  console.error(`    Create it with: GROQ_API_KEY=gsk_...`);
  process.exit(1);
}

if (!process.env.GROQ_API_KEY) {
  console.error('⚠️  GROQ_API_KEY missing from .env');
  process.exit(1);
}