/**
 * Fonts for text on a relief: open-licence fonts bundled with the app (SIL OFL / Apache, via
 * Fontsource; Latin letters, one weight each), plus common system fonts.
 */
import '@fontsource/cinzel/latin-700.css';
import '@fontsource/playfair-display/latin-700.css';
import '@fontsource/roboto-slab/latin-700.css';
import '@fontsource/alfa-slab-one/latin-400.css';
import '@fontsource/oswald/latin-600.css';
import '@fontsource/bebas-neue/latin-400.css';
import '@fontsource/montserrat/latin-700.css';
import '@fontsource/great-vibes/latin-400.css';
import '@fontsource/dancing-script/latin-700.css';
import '@fontsource/pacifico/latin-400.css';
import '@fontsource/lobster/latin-400.css';
import '@fontsource/unifrakturmaguntia/latin-400.css';
import '@fontsource/rye/latin-400.css';

export interface FontDef {
  family: string;
  label: string;
  weight: number;
  group: string;
  /** a system font: may be missing on some computers (the browser then uses a fallback) */
  system?: boolean;
}

export const FONTS: FontDef[] = [
  { family: 'Cinzel', label: 'Cinzel (Roman capitals)', weight: 700, group: 'Serif' },
  { family: 'Playfair Display', label: 'Playfair Display', weight: 700, group: 'Serif' },
  { family: 'Roboto Slab', label: 'Roboto Slab', weight: 700, group: 'Slab' },
  { family: 'Alfa Slab One', label: 'Alfa Slab One (heavy)', weight: 400, group: 'Slab' },
  { family: 'Rye', label: 'Rye (western)', weight: 400, group: 'Slab' },
  { family: 'Montserrat', label: 'Montserrat', weight: 700, group: 'Sans' },
  { family: 'Oswald', label: 'Oswald (condensed)', weight: 600, group: 'Sans' },
  { family: 'Bebas Neue', label: 'Bebas Neue (tall capitals)', weight: 400, group: 'Sans' },
  { family: 'Great Vibes', label: 'Great Vibes (formal script)', weight: 400, group: 'Script' },
  { family: 'Dancing Script', label: 'Dancing Script', weight: 700, group: 'Script' },
  { family: 'Pacifico', label: 'Pacifico (brush)', weight: 400, group: 'Script' },
  { family: 'Lobster', label: 'Lobster', weight: 400, group: 'Script' },
  { family: 'UnifrakturMaguntia', label: 'UnifrakturMaguntia (blackletter)', weight: 400, group: 'Decorative' },
  { family: 'Arial', label: 'Arial', weight: 700, group: 'System', system: true },
  { family: 'Georgia', label: 'Georgia', weight: 700, group: 'System', system: true },
  { family: 'Times New Roman', label: 'Times New Roman', weight: 700, group: 'System', system: true },
  { family: 'Impact', label: 'Impact', weight: 400, group: 'System', system: true },
];

export const fontDef = (family: string): FontDef => FONTS.find((f) => f.family === family) ?? FONTS[0];
export const cssFont = (f: FontDef, px: number) => `${f.weight} ${px}px "${f.family}", serif`;
