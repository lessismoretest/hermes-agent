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

export type PathSegment = { kind: 'text'; value: string } | { kind: 'path'; value: string }

/**
 * Split one run of plain prose into text and path segments. Shared by the
 * markdown plugin and the user-message renderer so a path looks and behaves the
 * same wherever the transcript shows it.
 */
export function splitPathText(value: string): PathSegment[] {
  const out: PathSegment[] = []
  let cursor = 0

  for (const match of value.matchAll(PATH_RE)) {
    const start = match.index ?? 0
    const candidate = match[0]

    if (!looksLikePath(candidate)) {
      continue
    }

    if (start > cursor) {
      out.push({ kind: 'text', value: value.slice(cursor, start) })
    }

    out.push({ kind: 'path', value: candidate })
    cursor = start + candidate.length
  }

  if (!out.length) {
    return [{ kind: 'text', value }]
  }

  if (cursor < value.length) {
    out.push({ kind: 'text', value: value.slice(cursor) })
  }

  return out
}

function splitText(value: string): MdNode[] {
  return splitPathText(value).map(segment =>
    segment.kind === 'path'
      ? {
          type: 'link',
          url: `hermes-path:${encodeURIComponent(segment.value)}`,
          children: [{ type: 'text', value: segment.value }]
        }
      : { type: 'text', value: segment.value }
  )
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
    const guarded = chunk.replace(/\[[^\]]*\]\([^)\s]*\)/g, match => {
      shielded.push(match)
      return `\u0001${shielded.length - 1}\u0001`
    })

    const linked = guarded.replace(PATH_RE, candidate => {
      if (!looksLikePath(candidate)) {
        return candidate
      }

      // The transcript's link sanitizer only lets http(s) through, so the
      // marker rides on a https URL that never leaves the renderer:
      // MarkdownLink intercepts the host and draws a chip instead.
      return `[${candidate}](https://hermes.local/path#${encodeURIComponent(candidate)})`
    })

    return linked.replace(/\u0001(\d+)\u0001/g, (_, index) => shielded[Number(index)] ?? '')
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
