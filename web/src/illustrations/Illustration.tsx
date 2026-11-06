import { useEffect, useState, type CSSProperties } from 'react';
import { ILLUSTRATIONS, type IllustrationName } from './registry';

/**
 * Each SVG is its own small file, fetched only when a page shows it and then
 * cached by the browser (hashed name, served by nginx): nothing is added to
 * the main bundle and the API never sees these requests.
 */
const files = import.meta.glob<string>('./svg/*.svg', { query: '?raw', import: 'default' });
const loaded = new Map<string, string>();

function load(file: string): Promise<string> {
  const hit = loaded.get(file);
  if (hit) return Promise.resolve(hit);
  const get = files[`./svg/${file}.svg`];
  if (!get) return Promise.reject(new Error(`Illustration file ${file}.svg is missing`));
  return get().then((svg) => {
    loaded.set(file, svg);
    return svg;
  });
}

export interface IllustrationProps {
  name: IllustrationName;
  /** px or any CSS length; the height follows the picture's proportions unless given */
  width?: number | string;
  height?: number | string;
  className?: string;
  /** the highlight colour (default: soft brand indigo) */
  accent?: string;
  /** the line colour (default: ink) */
  ink?: string;
  /** describe the picture to screen readers; leave false when the text next to it says it all */
  decorative?: boolean;
  /** overrides the registry's description */
  alt?: string;
}

/** A line illustration from the registry. Scales down to its container's width. */
export function Illustration({ name, width = 200, height, className = '', accent, ink, decorative = true, alt }: IllustrationProps) {
  const entry = ILLUSTRATIONS[name];
  const [svg, setSvg] = useState<string | null>(() => loaded.get(entry.file) ?? null);

  useEffect(() => {
    let live = true;
    load(entry.file)
      .then((s) => live && setSvg(s))
      .catch(() => live && setSvg(''));
    return () => {
      live = false;
    };
  }, [entry.file]);

  const style: CSSProperties & Record<'--il-accent' | '--il-ink', string | undefined> = {
    width,
    height,
    maxWidth: '100%',
    aspectRatio: height === undefined ? String(entry.ratio) : undefined,
    '--il-accent': accent,
    '--il-ink': ink,
  };
  const a11y = decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': alt ?? entry.alt };

  return (
    <span
      className={`illustration ${svg ? 'is-ready' : ''} ${className}`}
      style={style}
      {...a11y}
      // trusted, local files checked when they were added (no scripts, no external links)
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}
