// Free (OFL) fonts, bundled with the app so nothing is fetched from the internet at run time.
import '@fontsource/poppins/latin-700.css';
import '@fontsource/montserrat/latin-800.css';
import '@fontsource/bebas-neue/latin-400.css';
import '@fontsource/anton/latin-400.css';
import '@fontsource/oswald/latin-700.css';
import '@fontsource/playfair-display/latin-700.css';
import '@fontsource/pacifico/latin-400.css';
import '@fontsource/lobster/latin-400.css';
import '@fontsource/dancing-script/latin-700.css';
import '@fontsource/caveat/latin-700.css';
import '@fontsource/permanent-marker/latin-400.css';
import '@fontsource/bangers/latin-400.css';

export const FONTS = [
  { id: 'poppins', label: 'Poppins', family: 'Poppins', weight: 700 },
  { id: 'montserrat', label: 'Montserrat', family: 'Montserrat', weight: 800 },
  { id: 'bebas', label: 'Bebas Neue', family: 'Bebas Neue', weight: 400 },
  { id: 'anton', label: 'Anton', family: 'Anton', weight: 400 },
  { id: 'oswald', label: 'Oswald', family: 'Oswald', weight: 700 },
  { id: 'playfair', label: 'Playfair', family: 'Playfair Display', weight: 700 },
  { id: 'pacifico', label: 'Pacifico', family: 'Pacifico', weight: 400 },
  { id: 'lobster', label: 'Lobster', family: 'Lobster', weight: 400 },
  { id: 'dancing', label: 'Dancing Script', family: 'Dancing Script', weight: 700 },
  { id: 'caveat', label: 'Caveat', family: 'Caveat', weight: 700 },
  { id: 'marker', label: 'Marker', family: 'Permanent Marker', weight: 400 },
  { id: 'bangers', label: 'Bangers', family: 'Bangers', weight: 400 },
];

export const fontCss = (font, px) => `${font.weight} ${px}px "${font.family}"`;

// A canvas cannot use a font that has not been loaded yet, so load it before drawing with it.
export async function loadFont(font) {
  try {
    await document.fonts.load(fontCss(font, 48), 'Abc');
  } catch {
    // the canvas falls back to a default font
  }
}
