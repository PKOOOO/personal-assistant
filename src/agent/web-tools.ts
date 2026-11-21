// Live web and data tools for the chat agent, backed by the Firecrawl SDK.
//
// Two kinds of lookup:
// - Web: search the web and read pages (Firecrawl search / scrape).
// - Live data sources: Firecrawl's Alexandria catalogue of ready-made site
//   integrations (Resy, Zillow, StockX, Polymarket, job boards, ...). The agent
//   finds a source, reads its inputs, then runs it for structured results.
//
// Bot users never hear the words "Firecrawl" or "Alexandria": tool names and
// descriptions talk about the web and data sources, and the system prompt tells
// the model to name the actual websites instead.
//
// Every call costs Firecrawl credits, so each handler runs inside an Inngest
// step (durable(), src/agent/tool.ts): a retried function run reuses the saved
// result instead of paying again.
import Firecrawl from '@mendable/firecrawl-js'
import { z } from 'zod'
import { clip, defineTool, durable } from './tool.js'

// Lazy so the app still boots (and the agent works without tools) when the key
// is missing; the tools report the problem to the model instead.
let client: Firecrawl | undefined
function firecrawl() {
  const apiKey = process.env.FIRECRAWL_API_KEY
  if (!apiKey) throw new Error('Web lookups are not configured (FIRECRAWL_API_KEY is missing).')
  return (client ??= new Firecrawl({ apiKey }))
}

export const webToolsEnabled = () => Boolean(process.env.FIRECRAWL_API_KEY)

const searchWeb = defineTool({
  name: 'search_web',
  description:
    'Search the web for current information: news, facts that may have changed, ' +
    'opening hours, prices, reviews, events, anything time-sensitive or that you are unsure about. ' +
    'Returns titles, URLs and relevant excerpts. Use read_webpage to read a result in full.',
  parameters: z.object({
    query: z.string().describe("Search query in the user's words, keeping their place, dates and constraints."),
    recency: z
      .enum(['any', 'day', 'week', 'month', 'year'])
      .optional()
      .describe('Only return results from this period. Default any.'),
    news: z.boolean().optional().describe('Search news articles instead of general web pages.'),
    country: z.string().optional().describe('ISO 3166-1 alpha-2 country code to localise results, e.g. "US", "GB".'),
  }),
  handler: async ({ query, recency, news, country }, { step }) =>
    durable(step, 'search_web', async () => {
      const tbs = recency && recency !== 'any' ? `qdr:${recency[0]}` : undefined
      const data = await firecrawl().search(query, {
        sources: [news ? 'news' : 'web'],
        limit: 6,
        tbs,
        country,
      })
      const results = (news ? data.news : data.web) ?? []
      return clip(
        results.map((r) => {
          const rec = r as Record<string, unknown>
          return {
            title: rec.title,
            url: rec.url,
            excerpt: rec.highlights ?? rec.description ?? rec.snippet,
            date: rec.date,
          }
        })
      )
    }),
})

const readWebpage = defineTool({
  name: 'read_webpage',
  description:
    'Read the main content of a web page as text. Use it on a URL from search results ' +
    'or one the user sent, when the excerpt is not enough.',
  parameters: z.object({
    url: z.string().url().describe('Full URL of the page, including https://'),
  }),
  handler: async ({ url }, { step }) =>
    durable(step, 'read_webpage', async () => {
      const doc = await firecrawl().scrape(url, { formats: ['markdown'], onlyMainContent: true })
      return clip({ url, title: doc.metadata?.title, content: doc.markdown ?? '' })
    }),
})

const findDataSources = defineTool({
  name: 'find_data_sources',
  description:
    'Find live data sources for structured, up-to-the-minute data that web search ' +
    'cannot give reliably: restaurant tables and booking times, ticket prices, apartment ' +
    'and home listings, flights and hotels, product prices across stores, resale prices ' +
    '(sneakers, records, cars), job postings, betting/prediction odds, stock and company ' +
    'financials, insider trades, analyst ratings, startup funding, reviews of local businesses, ' +
    'contractor ratings, campsites, fitness classes, app comparisons, earthquakes, fantasy ' +
    'sports projections, and similar. Describe the data you need in plain words, with ' +
    'place and dates. Returns matching sources (provider, capability, description); ' +
    'next call get_data_source_details for the one that fits.',
  parameters: z.object({
    need: z.string().describe('The data needed, e.g. "open restaurant tables tonight for 2 in the East Village, NYC".'),
  }),
  handler: async ({ need }, { step }) =>
    durable(step, 'find_data_sources', async () => {
      const data = await firecrawl().search(need, {
        sources: ['alexandria'],
        toolDetail: 'compact',
        limit: 8,
      })
      const tools = (data.tools ?? []).slice(0, 10).map((t) => ({
        provider: t.provider,
        capability: t.capability,
        description: t.description,
      }))
      return tools.length
        ? clip(tools)
        : 'No matching data source. Fall back to search_web and read_webpage.'
    }),
})

const getDataSourceDetails = defineTool({
  name: 'get_data_source_details',
  description:
    'Get the inputs and output fields of one data source returned by find_data_sources, ' +
    'so you can call fetch_live_data with exactly the inputs it requires. Some sources need ' +
    'an ID or coordinates from another capability of the same provider first; the descriptions say so.',
  parameters: z.object({
    provider: z.string().describe('provider id exactly as returned, e.g. "resy-com"'),
    capability: z.string().describe('capability id exactly as returned, e.g. "restaurants/search_venues"'),
  }),
  handler: async ({ provider, capability }, { step }) =>
    durable(step, 'get_data_source_details', async () => {
      const data = await firecrawl().findTools({
        providers: [provider],
        capabilities: [capability],
        level: 'tools',
        expand: ['options', 'response'],
        limit: 1,
      })
      const item = data.items[0] as Record<string, any> | undefined
      if (!item) return `No data source ${provider}/${capability}. Use find_data_sources to look again.`
      return clip({
        provider,
        capability,
        description: item.description,
        whenToUse: item.whenToUse,
        inputs: (item.options ?? []).map((o: Record<string, unknown>) => ({
          name: o.name,
          type: o.type,
          required: o.required ?? false,
          about: o.about,
          enum: o.enum,
        })),
        requiresOneOf: item.requiresOneOf,
        output: item.response && {
          about: item.response.about,
          recordsKey: item.response.key,
          paginated: item.response.paginated,
          fields: (item.response.fields ?? []).map((f: Record<string, unknown>) => f.name),
        },
      })
    }),
})

const fetchLiveData = defineTool({
  name: 'fetch_live_data',
  description:
    'Run a data source with the inputs from get_data_source_details and get live structured ' +
    'results. Pass only declared input names. If it returns an error, read it, fix the inputs ' +
    '(or get a required ID from another capability first) and try once more.',
  parameters: z.object({
    provider: z.string(),
    capability: z.string(),
    inputs: z.record(z.string(), z.unknown()).describe('Input values keyed by input name.'),
  }),
  handler: async ({ provider, capability, inputs }, { step }) =>
    durable(step, 'fetch_live_data', async () => {
      const res = await firecrawl().scrape({
        alexandria: { provider, capability, options: inputs },
      })
      const result = res.alexandria[0]
      if (!result) return 'The data source returned nothing.'
      if (result.error) {
        return clip({
          error: result.error.code,
          message: result.error.message,
          hint: /terms/i.test(`${result.error.code} ${result.error.message}`)
            ? 'This source is not enabled for this bot. Do not retry it; use another source or the web.'
            : undefined,
        })
      }
      return clip({ provider, capability, records: result.records, data: result.data })
    }),
})

export const webTools = [searchWeb, readWebpage, findDataSources, getDataSourceDetails, fetchLiveData]
