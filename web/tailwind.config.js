/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Graphite neutral ramp: surfaces stay grey, content carries the color.
        bg: '#FAFAFA',
        surface: '#FFFFFF',
        raised: '#F4F4F5',
        ink: {
          DEFAULT: '#171717',
          2: '#525252',
          3: '#737373',
        },
        // Ledger indigo, carried over from the QA console. Used rarely:
        // primary action, selection, the one figure that matters.
        brand: {
          DEFAULT: '#3B4A9F',
          dark: '#2F3C85',
          soft: '#EEF0F8',
        },
        good: { DEFAULT: '#1F7A4D', soft: '#EAF4EE' },
        bad: { DEFAULT: '#B3362C', soft: '#FAEDEB' },
        warn: { DEFAULT: '#9A5B0B', soft: '#FBF3E4' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderColor: {
        line: 'rgba(23,23,23,0.08)',
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.05)',
        float: '0 8px 24px rgba(0,0,0,0.06)',
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
};
