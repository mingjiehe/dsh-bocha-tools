/**
 * Bocha + Tavily as explicit model tools (not a ctx.web provider).
 *
 * Registers two tools:
 *   bocha_search  — 博查，中文/国内源
 *   tavily_search — Tavily，英文/海外源
 *
 * Why tools instead of a WebSearchProvider: in DSH Desktop 0.2.1-rc.2 a provider
 * registered on the plugin's ctx.web is not visible to the built-in `web_search`
 * tool (different service scope). Tools registered on ctx.tools ARE visible.
 * See NOTES.md.
 *
 * Keys: BOCHA_API_KEY / TAVILY_API_KEY via ctx.credentials -> env -> ~/.dsh/.credentials.yaml.
 */
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'bocha-tavily-tools'
export const inject = ['tools']

const BOCHA_REF = 'BOCHA_API_KEY'
const TAVILY_REF = 'TAVILY_API_KEY'
const BOCHA_ENDPOINTS = ['https://api.bocha.cn', 'https://api.bochaai.com']
const TAVILY_ENDPOINT = 'https://api.tavily.com/search'

const LOG_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugins')
const LOG_PATH = join(LOG_DIR, 'router-boot.log')

function log(line) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_PATH, new Date().toISOString() + ' pid=' + process.pid + ' ' + line + '\n')
  } catch {
    /* diagnostics must never break loading */
  }
}

log('module evaluated (tools build)')

// defineTool lives in a host-provided package. Resolve it dynamically so that a
// resolution failure degrades to a plain object instead of killing the whole module.
let defineTool = function (definition) {
  return definition
}
try {
  const hostTools = await import('@deepseek-ai/dsh-tools')
  if (hostTools && typeof hostTools.defineTool === 'function') {
    defineTool = hostTools.defineTool
    log('defineTool resolved from @deepseek-ai/dsh-tools')
  } else {
    log('defineTool missing in @deepseek-ai/dsh-tools, using plain object')
  }
} catch (error) {
  log('defineTool import failed (' + (error && error.message ? error.message : error) + '), using plain object')
}

function credentialFromFile(ref) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  try {
    const text = readFileSync(join(home, '.credentials.yaml'), 'utf8')
    const match = text.match(new RegExp('^\\s*' + ref + '\\s*:\\s*(.+?)\\s*$', 'm'))
    return match ? match[1].replace(/^['"]|['"]$/g, '') : undefined
  } catch {
    return undefined
  }
}

async function resolveKey(ctx, ref) {
  try {
    const resolved = await ctx.credentials.resolve(ref)
    if (resolved && resolved.value) return resolved.value
  } catch {
    /* fall through */
  }
  return process.env[ref] || credentialFromFile(ref)
}

function clamp(value, min, max) {
  return Math.min(Math.max(Number(value) || min, min), max)
}

function dedupe(entries) {
  const seen = Object.create(null)
  const sources = []
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    if (!entry || typeof entry.url !== 'string') continue
    const url = entry.url.trim()
    if (!url || seen[url]) continue
    seen[url] = true
    sources.push(entry)
  }
  return sources
}

async function searchBocha(ctx, query, maxResults, signal) {
  const key = await resolveKey(ctx, BOCHA_REF)
  if (!key) throw new Error('没有博查 API key：请在 ~/.dsh/.credentials.yaml 写入 ' + BOCHA_REF + '，或设置同名环境变量')
  const count = clamp(maxResults, 1, 50)
  const body = JSON.stringify({ query: query, summary: true, count: count, freshness: 'noLimit' })
  let lastError
  for (let i = 0; i < BOCHA_ENDPOINTS.length; i += 1) {
    const base = BOCHA_ENDPOINTS[i]
    try {
      const response = await fetch(base + '/v1/web-search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: body,
        signal: signal,
      })
      if (!response.ok) {
        const detail = (await response.text().catch(function () { return '' })).slice(0, 300)
        lastError = new Error(base + ' HTTP ' + response.status + (detail ? ' — ' + detail : ''))
        continue
      }
      const json = await response.json()
      if (json && json.code !== undefined && json.code !== 200 && json.code !== '200') {
        lastError = new Error(base + ' code ' + json.code + (json.msg ? ' — ' + json.msg : ''))
        continue
      }
      const pages =
        (json && json.data && json.data.webPages && json.data.webPages.value) ||
        (json && json.webPages && json.webPages.value) ||
        (json && json.data && json.data.web_pages && json.data.web_pages.value) ||
        []
      if (!Array.isArray(pages)) throw new Error(base + ' 返回结构异常（没有 webPages.value）')
      return dedupe(
        pages.map(function (page) {
          const source = { url: page && page.url }
          if (page && typeof page.name === 'string' && page.name.trim()) source.title = page.name.trim()
          const snippet = page ? page.summary || page.snippet : undefined
          if (typeof snippet === 'string' && snippet.trim()) source.snippet = snippet.trim()
          if (page && typeof page.datePublished === 'string' && page.datePublished.trim()) {
            source.publishedAt = page.datePublished.trim()
          }
          return source
        }),
      ).slice(0, count)
    } catch (error) {
      if (error && error.name === 'AbortError') throw error
      lastError = error
    }
  }
  throw lastError || new Error('博查搜索失败')
}

async function searchTavily(ctx, query, maxResults, signal) {
  const key = await resolveKey(ctx, TAVILY_REF)
  if (!key) throw new Error('没有 Tavily API key：请在 ~/.dsh/.credentials.yaml 写入 ' + TAVILY_REF + '，或设置同名环境变量')
  const max = clamp(maxResults, 1, 20)
  const response = await fetch(TAVILY_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({
      query: query,
      search_depth: 'basic',
      max_results: max,
      include_answer: false,
      include_raw_content: false,
    }),
    signal: signal,
  })
  if (!response.ok) {
    const detail = (await response.text().catch(function () { return '' })).slice(0, 300)
    throw new Error('Tavily HTTP ' + response.status + (detail ? ' — ' + detail : ''))
  }
  const json = await response.json()
  const results = json && Array.isArray(json.results) ? json.results : []
  return dedupe(
    results.map(function (result) {
      const source = { url: result && result.url }
      if (result && typeof result.title === 'string' && result.title.trim()) source.title = result.title.trim()
      if (result && typeof result.content === 'string' && result.content.trim()) source.snippet = result.content.trim()
      if (result && typeof result.published_date === 'string' && result.published_date.trim()) {
        source.publishedAt = result.published_date.trim()
      }
      return source
    }),
  ).slice(0, max)
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    engine: { type: 'string' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          snippet: { type: 'string' },
          publishedAt: { type: 'string' },
        },
      },
    },
  },
}

function render(args, value) {
  const lines = []
  for (let i = 0; i < value.sources.length; i += 1) {
    const source = value.sources[i]
    const title = source.title || source.url
    let line = '- [' + title + '](' + source.url + ')'
    if (source.publishedAt) line += ' · ' + source.publishedAt
    if (source.snippet) line += '\n  ' + source.snippet.slice(0, 300)
    lines.push(line)
  }
  return [
    {
      type: 'text',
      text: 'Engine: ' + value.engine + '\n' + (lines.length ? lines.join('\n') : '（没有结果）'),
    },
  ]
}

function defineSearchTool(backend, hostCtx) {
  const isBocha = backend === 'bocha'
  return defineTool({
    name: isBocha ? 'bocha_search' : 'tavily_search',
    description: isBocha
      ? '用博查（Bocha）搜索中文/国内网页。适合 A 股公司、国内政策、中文财经与本地资讯；结果只有标题、URL 与摘要，需要正文时再用 web_fetch 打开。'
      : '用 Tavily 搜索英文/海外网页。适合美股公司、海外财报、英文技术资料与一手信源；结果只有标题、URL 与摘要，需要正文时再用 web_fetch 打开。',
    parameters: {
      query: { type: 'string', description: '搜索词，原样发给引擎' },
      count: { type: 'number', description: isBocha ? '返回条数，1-50，默认 8' : '返回条数，1-20，默认 8' },
    },
    output: { schema: OUTPUT_SCHEMA, render: render },
    async execute(args, exec) {
      const query = String((args && args.query) || '').trim()
      if (!query) throw new Error('query 不能为空')
      const count = clamp(args && args.count, 1, isBocha ? 50 : 20)
      const signal = exec && exec.signal
      const sources = isBocha
        ? await searchBocha(hostCtx, query, count, signal)
        : await searchTavily(hostCtx, query, count, signal)
      return { engine: isBocha ? 'bocha' : 'tavily', sources: sources }
    },
  })
}

export function apply(ctx) {
  const registerAll = function (sctx) {
    const disposers = []
    try {
      disposers.push(sctx.tools.register(defineSearchTool('bocha', ctx)))
      disposers.push(sctx.tools.register(defineSearchTool('tavily', ctx)))
      log('tools registered: bocha_search, tavily_search')
    } catch (error) {
      log('tool registration failed: ' + (error && error.stack ? error.stack : error))
    }
    return function () {
      for (let i = 0; i < disposers.length; i += 1) {
        try {
          disposers[i]()
        } catch {
          /* ignore */
        }
      }
    }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], function (sctx) {
      if (typeof sctx.effect === 'function') sctx.effect(function () { return registerAll(sctx) })
      else registerAll(sctx)
    })
  }
}