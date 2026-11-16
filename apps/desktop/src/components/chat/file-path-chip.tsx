import { Codicon } from '@/components/ui/codicon'

/**
 * An inline, clickable filesystem path.
 *
 * Clicking reveals the target in Finder — the same `hermes:fs:reveal` route the
 * file tree uses, so it works for files and folders alike and never launches an
 * app the reader didn't ask for. A dead path still reports its failure from the
 * main process instead of doing nothing silently.
 */
export function FilePathChip({ path }: { path: string }) {
  const reveal = () => {
    void window.hermesDesktop?.revealPath?.(path)
  }

  return (
    <button
      className="mx-0.5 inline-flex max-w-full items-baseline gap-1 rounded border border-(--ui-stroke-tertiary) bg-(--ui-control-hover-background) px-1 py-px align-baseline font-mono text-[0.85em] leading-[1.4] text-(--ui-text-secondary) transition-colors duration-100 hover:border-(--ui-stroke-secondary) hover:text-foreground"
      onClick={event => {
        event.preventDefault()
        reveal()
      }}
      title={`在访达中显示：${path}`}
      type="button"
    >
      <Codicon className="size-3 shrink-0 translate-y-px opacity-70" name="file" />
      <span className="min-w-0 truncate">{path}</span>
    </button>
  )
}
