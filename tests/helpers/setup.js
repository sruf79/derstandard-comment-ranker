import { afterEach } from 'vitest';
import { createEnv } from './env.js';

// Convenience for tests that only need content.js internals with an empty page.
let current = [];
export async function loadContent(opts) {
  const env = await createEnv(opts);
  current.push(env);
  const c = env.load('content.js');
  await env.flush(); // let loadState() finish so it does not overwrite test state
  return { env, c };
}

export function track(env) {
  current.push(env);
  return env;
}

afterEach(() => {
  for (const env of current) env.close();
  current = [];
});
