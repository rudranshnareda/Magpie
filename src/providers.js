// Every AI backend Magpie can talk to. One registry drives both the engine and the Settings UI.
//   group 'app'   : a program on this PC, driven through its command line
//   group 'cloud' : a hosted API (needs a key)
//   group 'local' : a server on this PC (Ollama, LM Studio)
const REGISTRY = [
  { id: 'claude-cli', label: 'Claude Code', group: 'app', type: 'claude-cli', fields: ['model'],
    models: ['haiku', 'sonnet', 'opus'], defaults: { model: 'haiku' },
    hint: 'Uses your existing Claude Code login. Starts a little slower than an API.' },
  { id: 'gemini-cli', label: 'Gemini CLI', group: 'app', type: 'cli-gemini', fields: ['model', 'command'],
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'], defaults: { model: '', command: 'gemini' },
    hint: 'Runs “gemini” in the background. Install it and sign in once first. Leave model empty for its default.' },
  { id: 'codex-cli', label: 'Codex CLI', group: 'app', type: 'cli-codex', fields: ['model', 'command'],
    models: [], defaults: { model: '', command: 'codex' },
    hint: 'Runs “codex exec” in the background. Leave model empty for its default.' },
  { id: 'custom-cli', label: 'Custom command', group: 'app', type: 'cli-custom', fields: ['command'],
    models: [], defaults: { command: '' },
    hint: 'Any program that reads the prompt from stdin and prints the answer, e.g. “ollama run llama3.2”. Works with Antigravity-style tools that expose a command line.' },

  { id: 'anthropic', label: 'Anthropic API', group: 'cloud', type: 'anthropic', fields: ['model', 'apiKey'],
    models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'], defaults: { model: 'claude-haiku-5-5' },
    hint: 'Fastest way to use Claude: about a second to first word. Key from console.anthropic.com.' },
  { id: 'gemini-api', label: 'Google Gemini API', group: 'cloud', type: 'gemini', fields: ['model', 'apiKey'],
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'], defaults: { model: 'gemini-2.5-flash' },
    hint: 'Key from aistudio.google.com. This is how to use Gemini models without the CLI.' },
  { id: 'openai', label: 'OpenAI', group: 'cloud', type: 'openai', fields: ['model', 'apiKey'],
    models: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1'], defaults: { model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' } },
  { id: 'openrouter', label: 'OpenRouter', group: 'cloud', type: 'openai', fields: ['model', 'apiKey'],
    models: [], defaults: { model: '', baseUrl: 'https://openrouter.ai/api/v1' },
    hint: 'One key, hundreds of models. Type the model id exactly as OpenRouter lists it.' },
  { id: 'groq', label: 'Groq', group: 'cloud', type: 'openai', fields: ['model', 'apiKey'],
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'], defaults: { model: 'llama-3.1-8b-instant', baseUrl: 'https://api.groq.com/openai/v1' },
    hint: 'Very fast inference.' },
  { id: 'openai-custom', label: 'Other OpenAI-compatible', group: 'cloud', type: 'openai', fields: ['model', 'baseUrl', 'apiKey'], noKey: true,
    models: [], defaults: { model: '', baseUrl: '' }, hint: 'Any service that speaks the OpenAI chat API: Together, Fireworks, DeepSeek, vLLM and more.' },

  { id: 'ollama', label: 'Ollama (local)', group: 'local', type: 'openai', fields: ['model', 'baseUrl'], noKey: true, listModels: true,
    models: [], defaults: { model: '', baseUrl: 'http://localhost:11434/v1' }, hint: 'Runs models on this PC. Make sure Ollama is running.' },
  { id: 'lmstudio', label: 'LM Studio (local)', group: 'local', type: 'openai', fields: ['model', 'baseUrl'], noKey: true,
    models: [], defaults: { model: '', baseUrl: 'http://localhost:1234/v1' }, hint: 'Start the local server in LM Studio first.' },
];

const byId = (id) => REGISTRY.find((p) => p.id === id) || REGISTRY[0];

// Merge registry defaults + the user's saved values + the secret key into one config.
function resolve(settings, secrets, id) {
  const reg = byId(id || settings.provider);
  const saved = (settings.providers || {})[reg.id] || {};
  return {
    id: reg.id, label: reg.label, type: reg.type, noKey: !!reg.noKey,
    model: saved.model ?? reg.defaults.model ?? '',
    baseUrl: saved.baseUrl ?? reg.defaults.baseUrl ?? '',
    command: saved.command ?? reg.defaults.command ?? '',
    apiKey: secrets.get(reg.id) || '',
  };
}

// What the UI needs (no functions, no secrets).
const publicRegistry = () => REGISTRY.map(({ id, label, group, fields, models, defaults, hint, noKey, listModels }) => ({ id, label, group, fields, models, defaults, hint, noKey: !!noKey, listModels: !!listModels }));

module.exports = { REGISTRY, byId, resolve, publicRegistry };
