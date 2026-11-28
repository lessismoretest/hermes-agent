/**
 * Turn absolute filesystem paths in prose into links.
 *
 * The renderer already knows how to open a local path (`hermes:openExternal`
 * resolves `~`, `file://`, and bare `/…` through the audited file route, opens
 * it with the OS handler and falls back to reveal-in-folder). What was missing
 * was *recognition*: a path written in the middle of a sentence stayed plain
 * text, so the one thing a reader wants to click was the one thing they could
 * not.
 *
 * Deliberately conservative. A false positive is worse than a miss here — a
 * chip that opens nothing teaches people to ignore chips. So a candidate must
 *
 *   - be absolute (`~/…` or `/…`) and live under a known root, or carry a file
 *     extension, and
 *   - start at a word boundary,
 *
 * which keeps `/api/v1/users` and `1/2` plain, while `/Users/me/notes.md`,
 * `~/Downloads/shot.png` and `/tmp/build.log` become chips. Code spans and
 * fenced blocks are never touched (they are `inlineCode`/`code` nodes, not
 * text), and neither is the label of an existing link.
 */

import { resolveBrandIcon } from '@/lib/brand-icon'

type MdNode = {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

const KNOWN_ROOTS = ['Users', 'Volumes', 'private', 'tmp', 'opt', 'Applications', 'Library', 'etc', 'var', 'usr']

const PATH_RE = new RegExp(
  String.raw`(?:~\/|\/(?:${KNOWN_ROOTS.join('|')})\/)[^\s\x60"'“”‘’()（）[\]「」,，;；:：]+`,
  'gu'
)

/**
 * A bare host (`github.com`, `arxiv.org/abs/1706.03762`, `x.com`) written
 * without a scheme. GFM autolinks only `http(s)://` and `www.`, so without
 * this a link the sender plainly meant stayed dead text — the one thing a
 * reader wants to click was the one thing they could not.
 *
 * The candidate must end at a word boundary and not continue a path or a
 * word, so `~/Downloads/a.png` (already handled above) and `foo.bar_baz`
 * never match. What qualifies as a domain is decided separately — see
 * `LINKABLE_TLDS`.
 */
const BARE_DOMAIN_RE = new RegExp(
  String.raw`(?<![\w@./~\\-])(?!www\.)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24})(?::\d{1,5})?(\/[^\s\x60"'“”‘’()（）[\]「」<>，,;；:：。、！？!?]*)?`,
  'giu'
)

/**
 * TLDs we are willing to link with no scheme in front of them.
 *
 * Deliberately NOT every ICANN TLD: `.md` / `.py` / `.sh` / `.so` / `.js` /
 * `.json` / `.zip` are real TLDs *and* the extensions of half the filenames a
 * coding agent writes, so `README.md`, `config.yaml` and `build.sh` would turn
 * into links to Moldova, Paraguay and Saint Helena. A miss is cheap here; a
 * chip that opens the wrong site is not. Domains in the brand table
 * (`motion.so`, `figma.com`) bypass this list — the table is the authority on
 * what is a site.
 */
const LINKABLE_TLDS = new Set([
  'ai',
  'app',
  'au',
  'be',
  'blog',
  'ca',
  'ch',
  'cloud',
  'cn',
  'co',
  'com',
  'cz',
  'de',
  'dev',
  'dk',
  'edu',
  'es',
  'fi',
  'fr',
  'gov',
  'hk',
  'ie',
  'in',
  'info',
  'io',
  'it',
  'jp',
  'kr',
  'me',
  'mx',
  'net',
  'news',
  'nl',
  'no',
  'nz',
  'online',
  'org',
  'pl',
  'ru',
  'se',
  'sg',
  'site',
  'store',
  'tech',
  'tv',
  'tw',
  'uk',
  'us',
  'xyz',
  'za'
])

const SEGMENT_TERMINATORS = /[.,;:!?。，、；：！？"'“”‘’)\]】」』]+$/

/** A link the sender wrote in full. `splitInlineLinks` keeps it whole so the
 *  user-message renderer can chip it; the markdown path leaves it to GFM. */
const EXPLICIT_URL_RE = new RegExp(
  String.raw`https?:\/\/[^\s\x60"'“”‘’()（）[\]「」<>，,;；:：。、！？!?]+`,
  'giu'
)

const MD_LINK_RE = /\[[^\]]*\]\([^)\s]*\)/g

/** A host we are willing to turn into a link: a known brand, or a plain TLD. */
function looksLikeBareDomain(host: string): boolean {
  const h = host.toLowerCase()

  if (resolveBrandIcon(h)) {
    return true
  }

  const dot = h.lastIndexOf('.')

  return dot > 0 && LINKABLE_TLDS.has(h.slice(dot + 1))
}

function schemeFor(host: string): string {
  const bare = host.replace(/[.,;:!?。，、；：！？"'“”‘’)\]】」』]+$/, '')

  return `https://${bare}`
}

/** Markdown link labels still parse emphasis; a path may carry `_` or `*`. */
function escapeMdLabel(label: string): string {
  return label.replace(/[\\[\]]/g, char => `\\${char}`)
}

function pathLink(candidate: string): string {
  return `[${escapeMdLabel(candidate)}](https://hermes.local/path#${encodeURIComponent(candidate)})`
}

function domainLink(text: string): string {
  return `[${escapeMdLabel(text)}](${schemeFor(text)})`
}

/** A path must look like a path, not like a URL fragment or a date. */
function looksLikePath(candidate: string): boolean {
  const trimmed = candidate.replace(/[.,;:]+$/, '')

  if (trimmed.length < 4) {
    return false
  }

  // `~/notes` is fine without an extension; `/Library/…` is not a plausible
  // sentence fragment either. Bare `/Users/x` (a home dir) is a real target.
  const hasExtension = /\.[A-Za-z0-9]{1,8}$/.test(trimmed)

  return hasExtension || trimmed.split('/').filter(Boolean).length >= 2
}

export type InlineSegmentKind = 'text' | 'path' | 'url'

export type InlineSegment =
  | { kind: 'text'; value: string }
  | { kind: 'path'; value: string }
  | { kind: 'url'; value: string }

/** @deprecated Kept for call sites written before bare domains were links. */
export type PathSegment = InlineSegment

type Hit = { start: number; end: number; kind: 'path' | 'url'; value: string }

/**
 * Split one run of plain prose into text, path and URL segments.
 *
 * Shared by the markdown preprocessor and the user-message renderer so a link
 * looks and behaves the same wherever the transcript shows it — including one
 * the sender wrote without a scheme.
 */
export function splitInlineLinks(value: string): InlineSegment[] {
  const hits: Hit[] = []

  for (const match of value.matchAll(PATH_RE)) {
    if (looksLikePath(match[0])) {
      hits.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, kind: 'path', value: match[0] })
    }
  }

  for (const match of value.matchAll(BARE_DOMAIN_RE)) {
    const raw = match[0]
    const trimmed = raw.replace(SEGMENT_TERMINATORS, '')
    const host = trimmed.split('/')[0].split(':')[0]
    const start = match.index ?? 0

    if (trimmed && looksLikeBareDomain(host)) {
      hits.push({ start, end: start + trimmed.length, kind: 'url', value: trimmed })
    }
  }

  for (const match of value.matchAll(EXPLICIT_URL_RE)) {
    const trimmed = match[0].replace(SEGMENT_TERMINATORS, '')
    const start = match.index ?? 0

    if (trimmed) {
      hits.push({ start, end: start + trimmed.length, kind: 'url', value: trimmed })
    }
  }

  if (!hits.length) {
    return [{ kind: 'text', value }]
  }

  // The path rule is the more specific one, and the two can only overlap when
  // a path segment happens to look like a host — path wins, it was matched
  // from the earlier offset.
  hits.sort((a, b) => a.start - b.start || b.end - a.end)

  const out: InlineSegment[] = []
  let cursor = 0

  for (const hit of hits) {
    if (hit.start < cursor) {
      continue
    }

    if (hit.start > cursor) {
      out.push({ kind: 'text', value: value.slice(cursor, hit.start) })
    }

    out.push({ kind: hit.kind, value: hit.value })
    cursor = hit.end
  }

  if (cursor < value.length) {
    out.push({ kind: 'text', value: value.slice(cursor) })
  }

  return out
}

export function splitPathText(value: string): PathSegment[] {
  return splitInlineLinks(value)
}

function splitText(value: string): MdNode[] {
  return splitInlineLinks(value).map(segment => {
    if (segment.kind === 'path') {
      return {
        type: 'link',
        url: `hermes-path:${encodeURIComponent(segment.value)}`,
        children: [{ type: 'text', value: segment.value }]
      }
    }

    if (segment.kind === 'url') {
      return {
        type: 'link',
        url: /^https?:\/\//i.test(segment.value) ? segment.value : `https://${segment.value}`,
        children: [{ type: 'text', value: segment.value }]
      }
    }

    return { type: 'text', value: segment.value }
  })
}

export function remarkFilePathLinks() {
  return (tree: MdNode) => {
    const walk = (node: MdNode) => {
      if (!node.children?.length) {
        return
      }

      const next: MdNode[] = []

      for (const child of node.children) {
        if (child.type === 'text' && typeof child.value === 'string') {
          next.push(...splitText(child.value))
          continue
        }

        // Never rewrite inside code, raw HTML, or an existing link's label.
        if (child.type === 'code' || child.type === 'inlineCode' || child.type === 'html' || child.type === 'link' || child.type === 'linkReference') {
          next.push(child)
          continue
        }

        walk(child)
        next.push(child)
      }

      node.children = next
    }

    walk(tree)
  }
}

/**
 * Markdown-source form of the same rule.
 *
 * The transcript's markdown goes through Streamdown's own block parser, and a
 * remark plugin registered on the component never reached the final tree (the
 * custom `parseMarkdownIntoBlocksFn` wins). So the path is lifted in the text
 * itself: a bare absolute path becomes an ordinary markdown link whose href is
 * the private `hermes-path:` scheme, which MarkdownLink already turns into a
 * chip. Code fences and inline code are left untouched.
 */
export function linkifyFilePaths(markdown: string): string {
  // Existing markdown links are shielded first: the preprocess can run more
  // than once over the same text (streaming block, then settled block), and a
  // second pass that re-links the label inside `[path](href)` nests one link in
  // another — the outer one then fails the renderer's URL check and prints as
  // "[blocked]".
  const linkifyPlain = (chunk: string) => {
    const shielded: string[] = []
    const guard = (value: string) => {
      shielded.push(value)

      return `\u0001${shielded.length - 1}\u0001`
    }

    // Existing markdown links are shielded first: the preprocess can run more
    // than once over the same text (streaming block, then settled block), and a
    // second pass that re-links the label inside `[path](href)` nests one link
    // in another — the outer one then fails the renderer's URL check and prints
    // as "[blocked]".
    let out = chunk.replace(MD_LINK_RE, guard)

    // Paths first: the more specific reading, and the two rules only collide
    // when a path's final segment happens to look like a host.
    out = out.replace(PATH_RE, candidate => (looksLikePath(candidate) ? guard(pathLink(candidate)) : candidate))

    out = out.replace(BARE_DOMAIN_RE, candidate => {
      const trimmed = candidate.replace(SEGMENT_TERMINATORS, '')
      const host = trimmed.split('/')[0].split(':')[0]

      if (!trimmed || !looksLikeBareDomain(host)) {
        return candidate
      }

      // Trailing punctuation stays in the prose, outside the link.
      return guard(domainLink(trimmed)) + candidate.slice(trimmed.length)
    })

    return out.replace(/\u0001(\d+)\u0001/g, (_, index) => shielded[Number(index)] ?? '')
  }

  return markdown
    .split(/(```[\s\S]*?```)/g)
    .map(block => {
      if (block.startsWith('```')) {
        return block
      }

      return block
        .split(/(`[^`]*`)/g)
        .map(part => (part.startsWith('`') ? part : linkifyPlain(part)))
        .join('')
    })
    .join('')
}
