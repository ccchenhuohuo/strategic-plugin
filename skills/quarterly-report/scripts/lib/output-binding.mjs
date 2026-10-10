import { readNativeBinding } from './codex-binding.mjs';
import { readPortableBinding } from './portable-binding.mjs';
import { assertFrozenOutput, readRunBinding } from './run-binding.mjs';

// Receipt readers do not call this facade. Their former boundOutput exports
// delegate here so every CLI and direct API consumes the same identity gate.
export async function outputBinding(runDir, supplied, env = process.env) {
  const saved = await readRunBinding(runDir);
  if (saved.mode === 'unbound') return { mode: saved.mode, outputEnv: supplied };
  const reader = saved.mode === 'portable' ? readPortableBinding : readNativeBinding;
  const binding = await reader(saved.identity.receipt, env);
  return { mode: saved.mode, outputEnv: assertFrozenOutput(saved, binding, supplied) };
}

export async function boundOutput(runDir, supplied, env = process.env) {
  return (await outputBinding(runDir, supplied, env)).outputEnv;
}
