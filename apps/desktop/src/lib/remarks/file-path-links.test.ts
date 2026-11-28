import { describe, expect, it } from 'vitest'

import { linkifyFilePaths, splitInlineLinks } from './file-path-links'

const kinds = (text: string) => splitInlineLinks(text).map(segment => `${segment.kind}:${segment.value}`)

describe('splitInlineLinks — bare domains', () => {
  it('links a bare host with no scheme', () => {
    expect(kinds('见 github.com 就行')).toEqual(['text:见 ', 'url:github.com', 'text: 就行'])
  })

  it('keeps a bare host and its path together', () => {
    expect(kinds('arxiv.org/abs/1706.03762')).toEqual(['url:arxiv.org/abs/1706.03762'])
  })

  it('handles a multi-label host and a trailing port', () => {
    expect(kinds('developer.mozilla.org/docs')).toEqual(['url:developer.mozilla.org/docs'])
    expect(kinds('localhost:3000 不算')).toEqual(['text:localhost:3000 不算'])
  })

  it('leaves trailing punctuation in the prose', () => {
    expect(kinds('x.com。')).toEqual(['url:x.com', 'text:。'])
    expect(kinds('看 figma.com,')).toEqual(['text:看 ', 'url:figma.com', 'text:,'])
  })

  it('does not link filenames that share a TLD', () => {
    for (const text of ['README.md', 'config.yaml', 'build.sh', 'libfoo.so', 'index.js', 'data.json']) {
      expect(kinds(text)).toEqual([`text:${text}`])
    }
  })

  it('does not link an email address', () => {
    expect(kinds('me@example.com')).toEqual(['text:me@example.com'])
  })

  it('does not link a version number', () => {
    expect(kinds('v1.2.3')).toEqual(['text:v1.2.3'])
  })

  it('links a brand domain from the brand table', () => {
    expect(kinds('figma.com')).toEqual(['url:figma.com'])
  })

  it('refuses a TLD that doubles as a file extension', () => {
    // `.so` is Somalia AND the shared-library suffix. The brand table can
    // still rescue a host it knows; nothing else gets through.
    expect(kinds('motion.so')).toEqual(['text:motion.so'])
    expect(kinds('libfoo.so')).toEqual(['text:libfoo.so'])
  })
})

describe('splitInlineLinks — paths and explicit URLs', () => {
  it('keeps the path rule ahead of the domain rule', () => {
    expect(kinds('/Users/me/site.com')).toEqual(['path:/Users/me/site.com'])
    expect(kinds('~/Downloads/a.png')).toEqual(['path:~/Downloads/a.png'])
  })

  it('keeps an explicit URL whole', () => {
    expect(kinds('https://x.com/isMore19743')).toEqual(['url:https://x.com/isMore19743'])
  })
})

describe('linkifyFilePaths — markdown source', () => {
  it('writes a bare domain as a link to its https origin', () => {
    expect(linkifyFilePaths('github.com')).toBe('[github.com](https://github.com)')
  })

  it('leaves an explicit URL to GFM', () => {
    expect(linkifyFilePaths('https://github.com')).toBe('https://github.com')
  })

  it('never touches inline code or fenced blocks', () => {
    expect(linkifyFilePaths('`README.md` 和 `github.com`')).toBe('`README.md` 和 `github.com`')
    expect(linkifyFilePaths('```\ngithub.com\n```')).toBe('```\ngithub.com\n```')
  })

  it('is idempotent', () => {
    const once = linkifyFilePaths('github.com 和 ~/a/b.png')
    expect(linkifyFilePaths(once)).toBe(once)
  })
})
