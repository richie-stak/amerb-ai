// Admin-only management of external AI providers (OpenAI, Anthropic, DeepSeek, or any
// OpenAI-compatible service). Mounted at /api/admin/providers.
const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { fetchProviderModels } = require('../llm');
const { auditAdminChanges } = require('../audit');
const logger = require('../logger');
const {
  PROVIDER_TYPES,
  listProviders,
  getProvider,
  createProvider,
  updateProvider,
  deleteProvider,
  toPublic,
  apiKeyOf,
} = require('../llm/providers');

const router = express.Router();
router.use(requireAdmin);
// Every admin change (anything but a read) goes into the audit log automatically.
router.use(auditAdminChanges);

function cleanBaseUrl(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? value : null;
}

router.get('/', (req, res) => {
  const types = Object.fromEntries(Object.entries(PROVIDER_TYPES).map(([k, v]) => [k, { label: v.label, baseUrl: v.baseUrl }]));
  res.json({ providers: listProviders().map(toPublic), types });
});

// Connect a new provider. The key is checked by listing the provider's models before anything is
// saved, so a typo'd key or wrong URL is reported straight away rather than at a staff member's
// first message.
router.post('/', asyncHandler(async (req, res) => {
  const { type, name, apiKey } = req.body || {};
  const info = PROVIDER_TYPES[type];
  if (!info) return res.status(400).json({ error: 'Choose a provider type.' });
  if (typeof apiKey !== 'string' || !apiKey.trim()) return res.status(400).json({ error: 'An API key is required.' });
  const baseUrl = cleanBaseUrl(req.body.baseUrl || info.baseUrl);
  if (!baseUrl) return res.status(400).json({ error: 'Enter the provider\'s API base URL (starting with https://).' });

  let availableModels;
  try {
    availableModels = await fetchProviderModels({ type, baseUrl, apiKey: apiKey.trim() });
  } catch (err) {
    // The person needs to know whether it was the key, the address, the network or the provider's answer —
    // and the log needs the same, without ever containing the key itself.
    logger.warn('Provider connection check failed', {
      type,
      baseUrl,
      user: req.session?.userId,
      reason: err.message,
      status: err.providerStatus || null,
    });
    return res.status(400).json({
      error: `Could not connect to ${info.label}: ${err.message}`,
      details: {
        type,
        baseUrl,
        ...(err.providerStatus ? { providerStatus: err.providerStatus } : {}),
        hint:
          err.providerStatus === 401 || err.providerStatus === 403
            ? 'The provider rejected the API key. Check the key and that it is enabled for this account.'
            : err.providerStatus === 404
              ? 'The address answered but has no API there. Check the base URL — for OpenAI-compatible providers it usually ends in /v1.'
              : /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(err.message)
                ? 'This server could not reach that address — check the internet connection, the URL and any proxy.'
                : null,
      },
    });
  }
  const provider = createProvider({
    type,
    name: (typeof name === 'string' && name.trim()) || info.label,
    baseUrl,
    apiKey: apiKey.trim(),
    availableModels,
  });
  res.json({ provider: toPublic(provider) });
}));

router.patch('/:id', (req, res) => {
  const provider = getProvider(Number(req.params.id));
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  const { name, apiKey, enabled, enabledModels } = req.body || {};
  const fields = {};

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name cannot be empty.' });
    fields.name = name.trim().slice(0, 60);
  }
  if (apiKey !== undefined) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) return res.status(400).json({ error: 'API key cannot be empty.' });
    fields.apiKey = apiKey.trim();
  }
  if (enabled !== undefined) fields.enabled = Boolean(enabled);
  if (enabledModels !== undefined) {
    if (!Array.isArray(enabledModels)) return res.status(400).json({ error: 'enabledModels must be a list.' });
    const unknown = enabledModels.filter((m) => !provider.availableModels.includes(m));
    if (unknown.length) return res.status(400).json({ error: `Not offered by this provider: ${unknown.join(', ')}` });
    fields.enabledModels = [...new Set(enabledModels)];
  }
  res.json({ provider: toPublic(updateProvider(provider.id, fields)) });
});

// Re-reads the provider's model list (new models released, or after changing the key).
router.post('/:id/refresh', asyncHandler(async (req, res) => {
  const provider = getProvider(Number(req.params.id));
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  try {
    const availableModels = await fetchProviderModels({ type: provider.type, baseUrl: provider.baseUrl, apiKey: apiKeyOf(provider) });
    const enabledModels = provider.enabledModels.filter((m) => availableModels.includes(m));
    res.json({ provider: toPublic(updateProvider(provider.id, { availableModels, enabledModels })) });
  } catch (err) {
    res.status(400).json({ error: `Could not connect: ${err.message}` });
  }
}));

router.delete('/:id', (req, res) => {
  const provider = getProvider(Number(req.params.id));
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  deleteProvider(provider.id);
  res.json({ ok: true });
});

module.exports = router;
