// Loose assert: objects returned from the vm realm carry a different
// Object.prototype, which strict deepEqual would reject.
import assert from 'node:assert'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function loadMetadataHelpers() {
  const clientPath = new URL('./src/client.js', import.meta.url)
  const source = await readFile(clientPath, 'utf8')
  const instrumented = source.replace(
    '    return { inject, apply }',
    '    return { inject, apply, __test: { enrichDiscoveredModel, metadataCandidateForDiscovery, metadataMatchForModel, modelDisplayName, modelMatchesSearch, selectedModelsMissingFromDiscovery, sortCandidatesForDisplay, isAliyunEndpoint, effectiveCompat, credentialKeyRef, PROVIDER_ID_PATTERN, syncModelMetadata, mergeCanonicalModels, applyExactMetadata } }',
  )
  let definition
  vm.runInNewContext(instrumented, {
    Headers,
    URL,
    window: {
      __ModuleLoader__: {
        load(value) {
          definition = value
        },
      },
    },
  })
  const react = {
    createElement() {},
    useEffect() {},
    useState() {},
    useSyncExternalStore() {},
  }
  return definition.factory(id => id === 'react' ? react : undefined).__test
}

test('metadata enrichment preserves a discovered display name exactly', async () => {
  const { enrichDiscoveredModel, metadataMatchForModel } = await loadMetadataHelpers()
  const metadata = {
    openai: {
      id: 'openai',
      models: {
        'GPT-5': {
          name: 'Metadata-normalized-name',
          limit: { context: 400000, output: 128000 },
          modalities: { input: ['text', 'image'] },
        },
      },
    },
  }
  const model = { id: 'gateway-model', name: 'GPT-5' }
  const match = metadataMatchForModel(metadata, model)
  const enriched = enrichDiscoveredModel(model, match, match.selection)

  assert.equal(match.officialProvider, 'openai')
  assert.equal(enriched.name, 'GPT-5')
  assert.equal(enriched.contextWindow, 400000)
  assert.equal(enriched.maxTokens, 128000)
})

test('an edited display name selects its official metadata provider', async () => {
  const { metadataMatchForModel } = await loadMetadataHelpers()
  const metadata = {
    deepseek: { id: 'deepseek', models: { 'DeepSeek-V3': { limit: { context: 1, output: 1 } } } },
    openai: { id: 'openai', models: { 'GPT-5': { limit: { context: 1, output: 1 } } } },
  }
  const match = metadataMatchForModel(metadata, { id: 'DeepSeek-V3', name: 'GPT-5' })

  assert.equal(match.officialProvider, 'openai')
  assert.equal(match.selection, 'provider:openai')
})

test('model search is case-insensitive without changing the displayed spelling', async () => {
  const { modelDisplayName, modelMatchesSearch } = await loadMetadataHelpers()
  const model = { id: 'Wire-Model', name: 'MiXeD Display Name' }

  assert.equal(modelDisplayName(model), 'MiXeD Display Name')
  assert.equal(modelMatchesSearch(model, 'mixed display'), true)
  assert.equal(modelMatchesSearch(model, 'wire-model'), true)
  assert.equal(modelMatchesSearch(model, 'missing'), false)
})

test('refresh matches metadata with the edited display name rather than the returned name', async () => {
  const { metadataCandidateForDiscovery, metadataMatchForModel } = await loadMetadataHelpers()
  const metadata = {
    deepseek: { id: 'deepseek', models: { 'DeepSeek-V3': { limit: { context: 1, output: 1 } } } },
    openai: { id: 'openai', models: { 'GPT-5': { limit: { context: 1, output: 1 } } } },
  }
  const returned = { id: 'DeepSeek-V3', name: 'DeepSeek-V3' }
  const editedDraft = { id: 'DeepSeek-V3', name: 'GPT-5' }
  const candidate = metadataCandidateForDiscovery(returned, editedDraft)
  const match = metadataMatchForModel(metadata, candidate)

  assert.equal(candidate.name, 'GPT-5')
  assert.equal(match.selection, 'provider:openai')
})

test('refresh retains selected manual models absent from the endpoint response', async () => {
  const { selectedModelsMissingFromDiscovery } = await loadMetadataHelpers()
  const manual = { id: 'Manual-Model', name: 'Manual Display Name' }
  const discovered = { id: 'Discovered-Model', name: 'Discovered Model' }
  const retained = selectedModelsMissingFromDiscovery(
    [manual, discovered],
    new Set([manual.id]),
    new Set([discovered.id]),
    { [manual.id]: manual },
  )

  assert.deepEqual(retained, [manual])
})

test('the choose-models list sorts candidates by id without mutating the source order', async () => {
  const { sortCandidatesForDisplay } = await loadMetadataHelpers()
  const unsorted = [
    { id: 'zeta-model' },
    { id: 'Alpha-Model' },
    { id: 'model-v10' },
    { id: 'model-v9' },
  ]

  const sortedIds = Array.from(sortCandidatesForDisplay(unsorted), model => model.id)

  assert.deepEqual(sortedIds, ['Alpha-Model', 'model-v9', 'model-v10', 'zeta-model'])
  assert.deepEqual(unsorted.map(model => model.id), ['zeta-model', 'Alpha-Model', 'model-v10', 'model-v9'])
})

test('aliyun endpoints are recognized by hostname, not by url substring', async () => {
  const { isAliyunEndpoint } = await loadMetadataHelpers()

  assert.equal(isAliyunEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1'), true)
  assert.equal(isAliyunEndpoint('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'), true)
  assert.equal(isAliyunEndpoint('https://dashscope-intl.aliyuncs.com/compatible-mode/v1'), true)
  assert.equal(isAliyunEndpoint('https://api.deepseek.com'), false)
  assert.equal(isAliyunEndpoint('https://gateway.example/aliyuncs.com'), false)
  assert.equal(isAliyunEndpoint('https://aliyuncs.com.evil.example/v1'), false)
  assert.equal(isAliyunEndpoint('not a url'), false)
})

test('effectiveCompat pins developer role off for aliyun unless configured explicitly', async () => {
  const { effectiveCompat, isAliyunEndpoint } = await loadMetadataHelpers()
  const aliyun = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

  assert.equal(effectiveCompat({}, 'https://api.deepseek.com'), undefined)
  assert.deepEqual(effectiveCompat({}, aliyun), { supportsDeveloperRole: false })
  assert.deepEqual(
    effectiveCompat({ compat: { thinkingFormat: 'qwen' } }, aliyun),
    { thinkingFormat: 'qwen', supportsDeveloperRole: false },
  )
  assert.deepEqual(
    effectiveCompat({ compat: { supportsDeveloperRole: true } }, aliyun),
    { supportsDeveloperRole: true },
  )
  assert.deepEqual(
    effectiveCompat({ compat: { thinkingFormat: 'deepseek' } }, 'https://gateway.example/v1'),
    { thinkingFormat: 'deepseek' },
  )
  assert.equal(isAliyunEndpoint(''), false)
})

test('credential refs follow the official dash-to-underscore derivation', async () => {
  const { credentialKeyRef } = await loadMetadataHelpers()

  assert.equal(credentialKeyRef('acme-gateway'), 'ACME_GATEWAY_API_KEY')
  assert.equal(credentialKeyRef('qwen'), 'QWEN_API_KEY')
  assert.equal(credentialKeyRef(''), '')
})

test('provider IDs accept exactly the official lowercase-hyphenated grammar', async () => {
  const { PROVIDER_ID_PATTERN } = await loadMetadataHelpers()

  assert.equal(PROVIDER_ID_PATTERN.test('acme-gateway'), true)
  assert.equal(PROVIDER_ID_PATTERN.test('acme'), true)
  assert.equal(PROVIDER_ID_PATTERN.test('acme-gateway-2'), true)
  assert.equal(PROVIDER_ID_PATTERN.test('Acme'), false)
  assert.equal(PROVIDER_ID_PATTERN.test('1acme'), false)
  assert.equal(PROVIDER_ID_PATTERN.test('acme--gateway'), false)
  assert.equal(PROVIDER_ID_PATTERN.test('acme-'), false)
  assert.equal(PROVIDER_ID_PATTERN.test('acme_gateway'), false)
})

test('manual capability sync overwrites stale model capabilities', async () => {
  const { syncModelMetadata } = await loadMetadataHelpers()
  const metadata = {
    openai: {
      id: 'openai',
      models: {
        'GPT-5': {
          limit: { context: 400000, output: 128000 },
          modalities: { input: ['text', 'image'] },
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
        },
      },
    },
  }
  const model = { id: 'gateway-model', name: 'GPT-5', contextWindow: 1, maxTokens: 1, input: ['text'] }
  const result = syncModelMetadata([model], { [model.id]: model }, metadata)

  assert.equal(result.matched, 1)
  assert.equal(result.drafts[model.id].contextWindow, 400000)
  assert.equal(result.drafts[model.id].maxTokens, 128000)
  assert.deepEqual(result.drafts[model.id].input, ['text', 'image'])
  assert.deepEqual(result.drafts[model.id].reasoningEfforts, { low: 'low', high: 'high' })
  assert.equal(result.matches[model.id].officialProvider, 'openai')
  assert.equal(result.selections[model.id], 'provider:openai')
  // The stored model object is replaced, never mutated in place.
  assert.equal(model.contextWindow, 1)
  assert.deepEqual(model.input, ['text'])
})

test('manual capability sync leaves models without a metadata record untouched', async () => {
  const { syncModelMetadata } = await loadMetadataHelpers()
  const metadata = {
    openai: { id: 'openai', models: { 'GPT-5': { limit: { context: 400000, output: 128000 } } } },
  }
  const matched = { id: 'gateway-model', name: 'GPT-5' }
  const unmatched = { id: 'private-model', name: 'private-model', contextWindow: 42 }
  const result = syncModelMetadata(
    [matched, unmatched],
    { [matched.id]: matched, [unmatched.id]: unmatched },
    metadata,
  )

  assert.equal(result.matched, 1)
  assert.equal(result.drafts[unmatched.id], undefined)
  assert.equal(result.matches[unmatched.id], undefined)
  assert.equal(unmatched.contextWindow, 42)
})

test('manual capability sync keeps a still-valid provider selection', async () => {
  const { syncModelMetadata } = await loadMetadataHelpers()
  const metadata = {
    alpha: { id: 'alpha', models: { 'Model-X': { limit: { context: 10, output: 5 } } } },
    beta: { id: 'beta', models: { 'Model-X': { limit: { context: 20, output: 8 } } } },
  }
  const model = { id: 'Model-X' }
  const kept = syncModelMetadata([model], { [model.id]: model }, metadata, { [model.id]: 'provider:beta' })
  assert.equal(kept.selections[model.id], 'provider:beta')
  assert.equal(kept.drafts[model.id].contextWindow, 20)

  // A provider that disappeared from models.dev falls back to the ranked default.
  const fallback = syncModelMetadata([model], { [model.id]: model }, metadata, { [model.id]: 'provider:gone' })
  assert.notEqual(fallback.selections[model.id], 'provider:gone')
  assert.equal(fallback.drafts[model.id].contextWindow, 10)
})

test('the canonical registry fills gaps in the official provider catalog', async () => {
  const { mergeCanonicalModels } = await loadMetadataHelpers()
  const catalog = {
    deepseek: { id: 'deepseek', models: { 'deepseek-v4-flash': { limit: { context: 1000000, output: 393216 } } } },
    scaleway: { id: 'scaleway', models: { 'deepseek-v4.1-flash': { limit: { context: 256000, output: 32768 } } } },
  }
  const canonical = {
    'deepseek/deepseek-v4.1-flash': {
      id: 'deepseek/deepseek-v4.1-flash',
      limit: { context: 1000000, output: 384000 },
      modalities: { input: ['text', 'image'] },
    },
  }
  const merged = mergeCanonicalModels(catalog, canonical)

  assert.equal(merged.deepseek.models['deepseek-v4.1-flash'].limit.output, 384000)
  assert.equal(merged.deepseek.models['deepseek-v4.1-flash'].canonical, true)
  // Existing provider records are never replaced.
  assert.equal(merged.deepseek.models['deepseek-v4-flash'].limit.output, 393216)
  // Other providers are copied unchanged.
  assert.equal(merged.scaleway.models['deepseek-v4.1-flash'].limit.context, 256000)
})

test('a canonical record beats a third-party re-host that reuses the model id', async () => {
  const { mergeCanonicalModels, metadataMatchForModel, enrichDiscoveredModel } = await loadMetadataHelpers()
  const catalog = {
    deepseek: { id: 'deepseek', models: { 'deepseek-v4-flash': { limit: { context: 1000000, output: 393216 } } } },
    scaleway: { id: 'scaleway', models: { 'deepseek-v4.1-flash': { limit: { context: 256000, output: 32768 } } } },
  }
  const canonical = {
    'deepseek/deepseek-v4.1-flash': {
      id: 'deepseek/deepseek-v4.1-flash',
      limit: { context: 1000000, output: 384000 },
      modalities: { input: ['text', 'image'] },
    },
  }
  const metadata = mergeCanonicalModels(catalog, canonical)
  const model = { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash' }
  const match = metadataMatchForModel(metadata, model)
  const enriched = enrichDiscoveredModel(model, match, match.selection, true)

  assert.equal(match.reason, 'official')
  assert.equal(match.officialProvider, 'deepseek')
  assert.equal(enriched.contextWindow, 1000000)
  assert.equal(enriched.maxTokens, 384000)
  assert.deepEqual(enriched.input, ['text', 'image'])
})

test('canonical models land on the official provider implied by the model id', async () => {
  const { mergeCanonicalModels } = await loadMetadataHelpers()
  const merged = mergeCanonicalModels({ alibaba: { id: 'alibaba', models: {} } }, {
    'qwen/qwen-max': { limit: { context: 1000000, output: 65536 } },
  })

  assert.equal(merged.alibaba.models['qwen-max'].limit.output, 65536)
  assert.equal(merged.qwen, undefined)
})

test('a canonical fetch failure leaves the provider catalog usable', async () => {
  const { mergeCanonicalModels } = await loadMetadataHelpers()
  const catalog = { deepseek: { id: 'deepseek', models: { 'deepseek-v4-flash': { limit: { context: 1000000, output: 393216 } } } } }

  assert.equal(mergeCanonicalModels(catalog, undefined), catalog)
  assert.equal(mergeCanonicalModels(catalog, null), catalog)
})

test('a canonical record borrows reasoning options from its own family', async () => {
  const { mergeCanonicalModels, metadataMatchForModel, enrichDiscoveredModel } = await loadMetadataHelpers()
  const catalog = {
    deepseek: {
      id: 'deepseek',
      models: {
        'deepseek-flash': {
          canonical_model_id: 'deepseek/deepseek-v4.1-flash-1017',
          reasoning: true,
          reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }],
          limit: { context: 1000000, output: 393216 },
        },
        'deepseek-v4-pro': {
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['medium'] }],
          limit: { context: 1000000, output: 393216 },
        },
      },
    },
  }
  const canonical = {
    'deepseek/deepseek-v4.1-flash': {
      id: 'deepseek/deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      reasoning: true,
      limit: { context: 1000000, output: 384000 },
      modalities: { input: ['text', 'image'] },
    },
  }
  const metadata = mergeCanonicalModels(catalog, canonical)
  const merged = metadata.deepseek.models['deepseek-v4.1-flash']

  assert.deepEqual(merged.reasoning_options, [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }])
  assert.equal(merged.limit.output, 384000)

  const model = { id: 'deepseek-v4.1-flash' }
  const match = metadataMatchForModel(metadata, model)
  const enriched = enrichDiscoveredModel(model, match, match.selection, true)
  assert.deepEqual(enriched.reasoningEfforts, { low: 'low', high: 'high', max: 'max' })
})

test('canonical reasoning options are not borrowed from an unrelated family', async () => {
  const { mergeCanonicalModels } = await loadMetadataHelpers()
  const catalog = {
    acme: {
      id: 'acme',
      models: {
        'other-model': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['high'] }] },
      },
    },
  }
  const merged = mergeCanonicalModels(catalog, {
    'acme/model-x': { id: 'acme/model-x', reasoning: true, limit: { context: 10, output: 5 } },
  })

  assert.equal(merged.acme.models['model-x'].reasoning_options, undefined)
})

test('a release stamp is not a different model family', async () => {
  const { metadataMatchForModel } = await loadMetadataHelpers()
  const metadata = {
    acme: { id: 'acme', models: { 'model-x-1017': { limit: { context: 1000, output: 500 } } } },
  }
  const match = metadataMatchForModel(metadata, { id: 'model-x' })

  assert.equal(match.reason, 'unique')
  assert.equal(match.selection, 'provider:acme')
  assert.equal(match.exact, false)
})

test('the provider display name may carry a release stamp the local id lacks', async () => {
  const { metadataMatchForModel } = await loadMetadataHelpers()
  const metadata = {
    acme: {
      id: 'acme',
      models: {
        'deepseek-flash': {
          name: 'DeepSeek V4.1 Flash 1017',
          limit: { context: 1000000, output: 393216 },
        },
      },
    },
  }
  const match = metadataMatchForModel(metadata, { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' })

  assert.equal(match.reason, 'unique')
  assert.equal(match.selection, 'provider:acme')
  assert.equal(match.exact, false)
})

test('a local variant suffix still reaches the provider record', async () => {
  const { metadataMatchForModel } = await loadMetadataHelpers()
  const metadata = {
    acme: { id: 'acme', models: { 'gemini-3.8-flash': { limit: { context: 1048576, output: 65536 } } } },
  }
  const match = metadataMatchForModel(metadata, { id: 'gemini-3.8-flash-higi' })

  assert.equal(match.reason, 'unique')
  assert.equal(match.selection, 'provider:acme')
  assert.equal(match.exact, false)
})

test('unrelated families stay unmatched', async () => {
  const { metadataMatchForModel } = await loadMetadataHelpers()
  const metadata = {
    acme: { id: 'acme', models: { 'gemini-3.5-flash': { limit: { context: 1000, output: 500 } } } },
  }
  const match = metadataMatchForModel(metadata, { id: 'gemini-3.8-flash-higi' })

  assert.equal(match.reason, 'none')
  assert.equal(match.exact, true)
})

test('a canonical link identifies the model when the wire id differs', async () => {
  const { metadataMatchForModel } = await loadMetadataHelpers()
  const metadata = {
    deepseek: {
      id: 'deepseek',
      models: {
        'deepseek-flash': {
          name: 'DeepSeek V4.1 Flash 1017',
          canonical_model_id: 'deepseek/deepseek-v4.1-flash-1017',
          limit: { context: 1000000, output: 393216 },
        },
      },
    },
    scaleway: { id: 'scaleway', models: { 'deepseek-v4.1-flash': { limit: { context: 256000, output: 32768 } } } },
  }
  const match = metadataMatchForModel(metadata, { id: 'deepseek-v4.1-flash' })

  // The official provider only has the dated snapshot, so this is approximate.
  assert.equal(match.reason, 'official')
  assert.equal(match.officialProvider, 'deepseek')
  assert.equal(match.selection, 'provider:deepseek')
  assert.equal(match.exact, false)
})

test('an exact id match stays exact', async () => {
  const { metadataMatchForModel } = await loadMetadataHelpers()
  const metadata = {
    deepseek: { id: 'deepseek', models: { 'deepseek-v4.1-flash': { limit: { context: 1000000, output: 384000 } } } },
  }
  const match = metadataMatchForModel(metadata, { id: 'deepseek-v4.1-flash' })

  assert.equal(match.reason, 'official')
  assert.equal(match.exact, true)
})

test('automatic enrichment adopts exact matches but waits on approximate ones', async () => {
  const { applyExactMetadata, metadataMatchForModel } = await loadMetadataHelpers()
  const metadata = {
    acme: { id: 'acme', models: { 'model-x-1017': { limit: { context: 1000, output: 500 } } } },
  }
  const model = { id: 'model-x' }
  const match = metadataMatchForModel(metadata, model)

  const untouched = applyExactMetadata(model, match, match.selection)
  assert.equal(untouched.contextWindow, undefined)
  assert.equal(untouched.maxTokens, undefined)

  const exactModel = { id: 'model-x-1017' }
  const exactMatch = metadataMatchForModel(metadata, exactModel)
  const enriched = applyExactMetadata(exactModel, exactMatch, exactMatch.selection)
  assert.equal(enriched.contextWindow, 1000)
  assert.equal(enriched.maxTokens, 500)
})

test('a manual sync exposes approximate entries for confirmation', async () => {
  const { syncModelMetadata } = await loadMetadataHelpers()
  const metadata = {
    acme: { id: 'acme', models: { 'model-x-1017': { limit: { context: 1000, output: 500 } } } },
    beta: { id: 'beta', models: { 'exact-model': { limit: { context: 2000, output: 800 } } } },
  }
  const approximate = { id: 'model-x' }
  const exact = { id: 'exact-model' }
  const result = syncModelMetadata([approximate, exact], {}, metadata)

  assert.equal(result.matched, 2)
  assert.equal(result.entries.find(entry => entry.id === 'model-x').match.exact, false)
  assert.equal(result.entries.find(entry => entry.id === 'exact-model').match.exact, true)
})
