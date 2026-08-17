/**
 * Spec intake: reading a customer's API description, whichever dialect it is
 * written in.
 *
 * Kept apart from index-add.mjs so these two can be unit-tested without booting
 * the CLI. They are the whole of the dialect knowledge in the intake path, and a
 * customer hands you the spec they have, not the spec you prefer: OSV.dev's is
 * Swagger 2.0, and reading it as if it were OpenAPI 3 silently produced a work
 * order with no base URL and three POST endpoints marked body-less.
 */

/**
 * The spec's own base URL.
 * OpenAPI 3 states it as `servers[].url`; Swagger 2.0 spells it out as
 * `schemes` + `host` + `basePath`, and omits `schemes` when it means https.
 * Returns undefined only when the spec genuinely does not say.
 */
export function specBaseUrl(spec) {
  const fromServers = Array.isArray(spec.servers) ? spec.servers.map((sv) => sv.url).filter(Boolean)[0] : undefined
  if (fromServers !== undefined) return fromServers
  if (typeof spec.host !== 'string' || spec.host === '') return undefined
  const scheme = Array.isArray(spec.schemes) && spec.schemes.length > 0
    ? (spec.schemes.includes('https') ? 'https' : String(spec.schemes[0]))
    : 'https'
  const base = typeof spec.basePath === 'string' ? spec.basePath.replace(/\/$/, '') : ''
  return `${scheme}://${spec.host}${base}`
}

/**
 * Every operation in the spec, grouped by its first tag — the inventory a human
 * reads to decide which endpoints deserve to become tools.
 *
 * `hasBody` must be true whenever the endpoint takes a request body, in either
 * dialect: OpenAPI 3 puts it in `requestBody`, Swagger 2.0 in a parameter whose
 * `in` is `body`. The body parameter is left out of the `params` list because it
 * is not a query/path knob — `hasBody` is what tells the builder about it.
 */
export function inventoryEndpoints(spec) {
  const groups = new Map()
  const paths = spec.paths ?? {}
  for (const [path, item] of Object.entries(paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = item?.[method]
      if (op === undefined) continue
      const tag = (Array.isArray(op.tags) && op.tags.length > 0) ? String(op.tags[0]) : 'default'
      const allParams = [...(item.parameters ?? []), ...(op.parameters ?? [])]
      const bodyParams = allParams.filter((prm) => prm.in === 'body')
      const params = allParams
        .filter((prm) => prm.in !== 'body')
        .map((prm) => `${prm.name}${prm.required === true ? '*' : ''}(${prm.in})`)
      const entry = {
        method: method.toUpperCase(),
        path,
        summary: String(op.summary ?? op.description ?? '').replace(/\s+/g, ' ').slice(0, 120),
        operationId: op.operationId,
        params,
        hasBody: op.requestBody !== undefined || bodyParams.length > 0,
        auth: Array.isArray(op.security) ? op.security.length > 0 : undefined,
      }
      if (!groups.has(tag)) groups.set(tag, [])
      groups.get(tag).push(entry)
    }
  }
  return groups
}
