// Every AI backend Magpie can talk to. One registry drives the engine, the Settings UI and the setup guides.
//   group 'free'  : free to start and fast (recommended)
//   group 'cloud' : other hosted APIs (need a key, usually billed)
//   group 'app'   : a program on this PC, driven through its command line
//   group 'local' : a server on this PC (Ollama, LM Studio)
// `models` is only a fallback list. Once a key is saved, Magpie asks the provider for its live list.
const REGISTRY = [
  { id: 'groq', label: 'Groq', badge: 'free, fastest', group: 'free', type: 'openai', fields: ['model', 'apiKey'],
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
    defaults: { model: 'openai/gpt-oss-120b', baseUrl: 'https://api.groq.com/openai/v1' },
    hint: 'Free plan and very fast: answers start in well under a second.',
    guide: {
      time: 'about 1 minute', url: 'https://console.groq.com/keys', urlLabel: 'Open the Groq console',
      steps: ['Open the Groq console and sign in (Google or email works).', 'Go to API Keys and choose Create API Key. Copy the key.', 'Paste it into the API key box below.', 'Press Test. The first word should arrive in about a second.'],
      tip: 'openai/gpt-oss-120b gives the best answers. openai/gpt-oss-20b is the fastest. Free limits apply per model, so check the Limits page in your Groq console.',
    } },
  { id: 'gemini-api', label: 'Google Gemini API', badge: 'free tier', group: 'free', type: 'gemini', fields: ['model', 'apiKey'],
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'], defaults: { model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com' },
    hint: 'Free tier available. This is how to use Gemini models without the command-line tool.',
    guide: {
      time: 'about 1 minute', url: 'https://aistudio.google.com/apikey', urlLabel: 'Open Google AI Studio',
      steps: ['Open Google AI Studio and sign in with your Google account.', 'Choose Create API key and copy it.', 'Paste it into the API key box below.', 'Press Test.'],
      tip: 'gemini-2.5-flash is the quick one. On the free tier Google may use your prompts to improve its products, so avoid sending anything sensitive.',
    } },

  { id: 'anthropic', label: 'Anthropic API', group: 'cloud', type: 'anthropic', fields: ['model', 'apiKey'],
    models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'], defaults: { model: 'claude-haiku-5-5', baseUrl: 'https://api.anthropic.com' },
    hint: 'Claude models over the API: about a second to the first word.',
    guide: {
      time: 'about 3 minutes', url: 'https://console.anthropic.com/settings/keys', urlLabel: 'Open the Anthropic console',
      steps: ['Open the Anthropic console and sign in.', 'Add a payment method or credits. API use is billed separately from a Claude.ai subscription.', 'Go to API keys, create one and copy it.', 'Paste it below and press Test.'],
      tip: 'Pick a small model such as Haiku for speed.',
    } },
  { id: 'openai', label: 'OpenAI', group: 'cloud', type: 'openai', fields: ['model', 'apiKey'],
    models: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1'], defaults: { model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
    guide: {
      time: 'about 3 minutes', url: 'https://platform.openai.com/api-keys', urlLabel: 'Open the OpenAI platform',
      steps: ['Open the OpenAI platform and sign in.', 'Set up billing. API use is billed separately from ChatGPT.', 'Create an API key and copy it.', 'Paste it below and press Test.'],
      tip: 'A "mini" model is the best balance of speed and cost.',
    } },
  { id: 'openrouter', label: 'OpenRouter', group: 'cloud', type: 'openai', fields: ['model', 'apiKey'],
    models: [], defaults: { model: '', baseUrl: 'https://openrouter.ai/api/v1' },
    hint: 'One key for hundreds of models.',
    guide: {
      time: 'about 2 minutes', url: 'https://openrouter.ai/keys', urlLabel: 'Open OpenRouter',
      steps: ['Open OpenRouter and sign in.', 'Create an API key and copy it.', 'Paste it below, press the refresh button next to Model, and choose a model.', 'Press Test.'],
      tip: 'Models whose name ends in ":free" cost nothing but are rate-limited.',
    } },
  { id: 'openai-custom', label: 'Other OpenAI-compatible', group: 'cloud', type: 'openai', fields: ['model', 'baseUrl', 'apiKey'], noKey: true,
    models: [], defaults: { model: '', baseUrl: '' },
    hint: 'Any service that speaks the OpenAI chat API: Together, Fireworks, DeepSeek, vLLM and more.',
    guide: {
      time: 'about 2 minutes',
      steps: ['Find your provider\'s API address in its docs. It usually ends in /v1.', 'Paste it into Server address below.', 'Create a key with the provider and paste it into the API key box (leave it empty for servers that need none).', 'Press the refresh button next to Model, choose one, and press Test.'],
      tip: 'Together, Fireworks and DeepSeek all work this way.',
    } },

  { id: 'claude-cli', label: 'Claude Code', group: 'app', type: 'claude-cli', fields: ['model'],
    models: ['haiku', 'sonnet', 'opus'], defaults: { model: 'haiku' },
    hint: 'Uses your existing Claude Code login. Starts a little slower than an API.',
    guide: {
      time: 'about 5 minutes', url: 'https://claude.com/claude-code', urlLabel: 'Open the Claude Code page',
      steps: ['Install Claude Code from the page below.', 'Open a terminal and run `claude` once. Sign in when it asks.', 'Come back here and press Test.'],
      tip: 'It takes a few seconds to start each time. For instant answers use Groq instead.',
    } },
  { id: 'gemini-cli', label: 'Gemini CLI', group: 'app', type: 'cli-gemini', fields: ['model', 'command'],
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'], defaults: { model: '', command: 'gemini' },
    hint: 'Runs the "gemini" command in the background. Leave model empty for its default.',
    guide: {
      time: 'about 5 minutes', url: 'https://github.com/google-gemini/gemini-cli', urlLabel: 'Open the Gemini CLI page',
      steps: ['Install Gemini CLI (the page shows the command, usually `npm install -g @google/gemini-cli`).', 'Run `gemini` once in a terminal and sign in.', 'Come back here and press Test.'],
      tip: 'This option is untested. If it fails, use the Google Gemini API above instead.',
    } },
  { id: 'codex-cli', label: 'Codex CLI', group: 'app', type: 'cli-codex', fields: ['model', 'command'],
    models: [], defaults: { model: '', command: 'codex' },
    hint: 'Runs "codex exec" in the background. Leave model empty for its default.',
    guide: {
      time: 'about 5 minutes', url: 'https://github.com/openai/codex', urlLabel: 'Open the Codex page',
      steps: ['Install Codex CLI (the page shows the command, usually `npm install -g @openai/codex`).', 'Run `codex` once in a terminal and sign in.', 'Come back here and press Test.'],
      tip: 'This option is untested. If it fails, use the OpenAI API above instead.',
    } },
  { id: 'custom-cli', label: 'Custom command', group: 'app', type: 'cli-custom', fields: ['command'],
    models: [], defaults: { command: '' },
    hint: 'Any program that reads the prompt from stdin and prints the answer.',
    guide: {
      time: 'about 2 minutes',
      steps: ['Type a command that reads the prompt from stdin and prints the answer, for example `ollama run llama3.2`.', 'Press Test.'],
      tip: 'The prompt arrives on stdin and the answer is read from stdout.',
    } },

  { id: 'ollama', label: 'Ollama', badge: 'on this PC', group: 'local', type: 'openai', fields: ['model', 'baseUrl'], noKey: true,
    models: [], defaults: { model: '', baseUrl: 'http://localhost:11434/v1' },
    hint: 'Runs models on this PC, privately. Make sure Ollama is running.',
    guide: {
      time: 'about 10 minutes', url: 'https://ollama.com/download', urlLabel: 'Open the Ollama download page',
      steps: ['Install Ollama and leave it running.', 'Open a terminal and download a model, for example `ollama pull llama3.2`.', 'Press the refresh button next to Model and choose it.', 'Press Test.'],
      tip: 'Speed depends on your graphics card. Small models (about 3 billion parameters) feel instant on most PCs.',
    } },
  { id: 'lmstudio', label: 'LM Studio', badge: 'on this PC', group: 'local', type: 'openai', fields: ['model', 'baseUrl'], noKey: true,
    models: [], defaults: { model: '', baseUrl: 'http://localhost:1234/v1' },
    hint: 'Start the local server in LM Studio first.',
    guide: {
      time: 'about 10 minutes', url: 'https://lmstudio.ai', urlLabel: 'Open the LM Studio site',
      steps: ['Install LM Studio and download a model inside it.', 'Open its Developer tab and start the local server.', 'Press the refresh button next to Model and choose it.', 'Press Test.'],
      tip: 'Keep LM Studio open while you use Magpie.',
    } },
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
const publicRegistry = () =>
  REGISTRY.map(({ id, label, badge, group, fields, models, defaults, hint, noKey, guide }) => ({ id, label, badge: badge || '', group, fields, models, defaults, hint: hint || '', noKey: !!noKey, guide: guide || null }));

module.exports = { REGISTRY, byId, resolve, publicRegistry };
